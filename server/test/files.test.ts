/**
 * The file API behind the browser view.
 *
 * A vault is a folder of files, and until this existed the tool could only see
 * the `.md` ones — so an attachment beside a note was invisible through the very
 * tool that owns the folder, and therefore also unremovable.
 *
 * Most of what is worth testing here is not the happy path. It is:
 *
 *  - **Nothing is served as a document.** The bundle and the vault share an
 *    origin, so an uploaded `.html` returned as `text/html` would be stored XSS
 *    with the session cookie in reach. Every download is an attachment except a
 *    short image allowlist, and SVG is excluded from that allowlist because it
 *    can carry script.
 *  - **The tenant boundary still holds.** Files obey the same share rules as
 *    notes, and a refusal is indistinguishable from a missing file.
 *  - **An uploaded note reaches the index**, or it would exist on disk and be
 *    unfindable by search.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import { SESSION_COOKIE, buildServer } from '../src/http/server.js';
import { LoginThrottle } from '../src/http/throttle.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import * as S from '../../shared/schema.js';

let dataDir: string;
let runtime: Runtime;
let server: FastifyInstance;
let cookie: string;
let ramonaCookie: string;

async function signIn(user: string, password: string): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { user, password },
  });
  return `${SESSION_COOKIE}=${response.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
}

async function upload(
  url: string,
  bytes: Buffer,
  as = cookie,
  contentType = 'application/octet-stream',
): Promise<ReturnType<FastifyInstance['inject']>> {
  return server.inject({
    method: 'POST',
    url,
    headers: { cookie: as, 'content-type': contentType },
    payload: bytes,
  });
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-files-'));
  const config = { ...loadConfig(), dataDir, cookieSecure: false };
  runtime = await createRuntime(config);
  await runtime.users.create('julian', 'ein gutes passwort', { role: 'admin' });
  await runtime.users.create('ramona', 'ihr gutes passwort');
  await runtime.app.createNote('julian', 'Homelab/Proxmox.md', '# Proxmox\n\nZwei Nodes.\n');

  server = await buildServer({
    app: runtime.app,
    db: runtime.db,
    users: runtime.users,
    sessions: runtime.sessions,
    keys: runtime.keys,
    shares: runtime.shares,
    settings: runtime.settings,
    history: runtime.history,
    config,
    throttle: new LoginThrottle({ limit: 1000 }),
  });

  cookie = await signIn('julian', 'ein gutes passwort');
  ramonaCookie = await signIn('ramona', 'ihr gutes passwort');
});

afterEach(async () => {
  await server.close();
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('listing', () => {
  it('shows attachments alongside notes', async () => {
    await upload('/api/v1/files/Homelab/rack.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const response = await server.inject({ url: '/api/v1/files', headers: { cookie } });
    const listing = S.FilesResponse.parse(response.json());

    const byPath = new Map(listing.files.map((f) => [f.path, f]));
    expect(byPath.get('Homelab/Proxmox.md')?.isNote).toBe(true);
    expect(byPath.get('Homelab/rack.png')?.isNote).toBe(false);
    expect(byPath.get('Homelab/rack.png')?.size).toBe(4);
  });

  it('lists folders too, so an empty one does not vanish', async () => {
    await runtime.app.createFolder('julian', 'Leer');

    const response = await server.inject({ url: '/api/v1/files', headers: { cookie } });
    const listing = S.FilesResponse.parse(response.json());

    expect(listing.dirs).toContain('Leer');
  });
});

describe('download', () => {
  it('returns the bytes unchanged', async () => {
    // Deliberately not valid UTF-8: a byte-for-byte round trip is the whole
    // point, and a text-mode read would mangle this into replacement characters.
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x10, 0x80]);
    await upload('/api/v1/files/blob.bin', bytes);

    const response = await server.inject({ url: '/api/v1/files/blob.bin', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(Buffer.compare(response.rawPayload, bytes)).toBe(0);
  });

  it('never serves an uploaded page as a document', async () => {
    await upload('/api/v1/files/evil.html', Buffer.from('<script>alert(document.cookie)</script>'));

    const response = await server.inject({ url: '/api/v1/files/evil.html', headers: { cookie } });

    // Same origin as the session cookie: text/html here would be stored XSS.
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(String(response.headers['content-disposition'])).toContain('attachment');
  });

  it('shows an image inline but never an SVG', async () => {
    await upload('/api/v1/files/shot.png', Buffer.from([0x89, 0x50]));
    await upload('/api/v1/files/logo.svg', Buffer.from('<svg onload="alert(1)"/>'));

    const png = await server.inject({ url: '/api/v1/files/shot.png', headers: { cookie } });
    expect(png.headers['content-type']).toBe('image/png');
    expect(String(png.headers['content-disposition'])).toContain('inline');

    // An SVG is an image and a script host at once, so it only ever downloads.
    const svg = await server.inject({ url: '/api/v1/files/logo.svg', headers: { cookie } });
    expect(svg.headers['content-type']).toBe('application/octet-stream');
    expect(String(svg.headers['content-disposition'])).toContain('attachment');
  });

  it('forbids caching, so a replaced file is never served stale', async () => {
    // Found in production: replace a file, download it, and the browser handed
    // back the previous bytes. A 200 with no cache directives is fair game for
    // heuristic caching, and vault contents are both private and mutable.
    await upload('/api/v1/files/wechselhaft.txt', Buffer.from('alt'));

    const response = await server.inject({
      url: '/api/v1/files/wechselhaft.txt',
      headers: { cookie },
    });

    expect(String(response.headers['cache-control'])).toContain('no-store');
  });

  it('keeps a unicode name readable in the filename header', async () => {
    await upload('/api/v1/files/Messwerte Grösse.csv', Buffer.from('a;b\n'));

    const response = await server.inject({
      url: `/api/v1/files/${encodeURIComponent('Messwerte Grösse.csv')}`,
      headers: { cookie },
    });

    expect(String(response.headers['content-disposition'])).toContain("filename*=UTF-8''");
  });
});

describe('upload and replace', () => {
  it('creates, then replaces, reporting which it was', async () => {
    const created = await upload('/api/v1/files/data.csv', Buffer.from('eins\n'));
    expect(created.statusCode).toBe(201);
    expect(S.UploadResult.parse(created.json()).replaced).toBe(false);

    const replaced = await upload('/api/v1/files/data.csv', Buffer.from('zwei\n'));
    expect(replaced.statusCode).toBe(200);
    expect(S.UploadResult.parse(replaced.json()).replaced).toBe(true);

    const back = await server.inject({ url: '/api/v1/files/data.csv', headers: { cookie } });
    expect(back.rawPayload.toString()).toBe('zwei\n');
  });

  it('stores text uploads byte for byte, whatever type the browser announces', async () => {
    // Found in production. Fastify parses `text/plain` into a string by default,
    // so the route saw no Buffer and wrote zero bytes — and a browser picking a
    // .md or .txt file announces exactly those types. Every text file imported
    // through the file browser would have arrived empty.
    const body = 'Zeile eins\nZeile zwei mit Grösse\n';

    // The types a browser actually announces for a picked text file. A file with
    // no type at all never reaches here as one: the client substitutes
    // application/octet-stream when `File.type` is empty.
    for (const type of ['text/plain', 'text/markdown', 'text/csv', 'application/octet-stream']) {
      const name = `typ-${type.replace(/[^a-z]/g, '')}.txt`;
      const response = await upload(`/api/v1/files/${name}`, Buffer.from(body), cookie, type);
      expect(response.statusCode).toBe(201);
      expect(S.UploadResult.parse(response.json()).size).toBe(Buffer.byteLength(body));

      const back = await server.inject({ url: `/api/v1/files/${name}`, headers: { cookie } });
      expect(back.rawPayload.toString('utf8')).toBe(body);
    }
  });

  it('refuses a JSON content type rather than rewriting the file', async () => {
    // The JSON parser has already discarded key order and whitespace by the time
    // a route sees the body, so the bytes cannot be reproduced. Better to say so.
    const response = await upload(
      '/api/v1/files/config.json',
      Buffer.from('{ "b": 1, "a": 2 }'),
      cookie,
      'application/json',
    );

    expect(response.statusCode).toBe(415);
    expect((response.json() as { code: string }).code).toBe('unsupported_media_type');
  });

  it('indexes an uploaded note so search can find it', async () => {
    await upload('/api/v1/files/Importiert.md', Buffer.from('# Importiert\n\nQdevice steht hier.\n'));

    const response = await server.inject({ url: '/api/v1/search?q=Qdevice', headers: { cookie } });
    const hits = S.SearchResponse.parse(response.json()).hits.map((h) => h.path);

    expect(hits).toContain('Importiert.md');
  });

  it('refuses a path that climbs out of the vault', async () => {
    // Two spellings, refused at two different layers. A literal `..` is
    // collapsed by URL normalisation before routing and never reaches a handler;
    // a percent-encoded one does reach it and is refused by `normalizeVaultPath`.
    // What matters is the same either way: no file appears outside the vault.
    for (const spelling of ['/api/v1/files/../../escape.txt', '/api/v1/files/%2e%2e/%2e%2e/escape.txt']) {
      const response = await upload(spelling, Buffer.from('nope'));
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }

    await expect(fs.stat(path.join(dataDir, 'escape.txt'))).rejects.toThrow();
    await expect(fs.stat(path.join(dataDir, 'vaults', 'escape.txt'))).rejects.toThrow();
  });
});

describe('delete', () => {
  it('removes an attachment', async () => {
    await upload('/api/v1/files/junk.bin', Buffer.from('x'));

    const response = await server.inject({
      method: 'DELETE',
      url: '/api/v1/files/junk.bin',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(204);

    const gone = await server.inject({ url: '/api/v1/files/junk.bin', headers: { cookie } });
    expect(gone.statusCode).toBe(404);
  });

  it('takes a deleted note out of the index as well', async () => {
    const response = await server.inject({
      method: 'DELETE',
      url: '/api/v1/files/Homelab/Proxmox.md',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(204);

    const search = await server.inject({ url: '/api/v1/search?q=Nodes', headers: { cookie } });
    expect(S.SearchResponse.parse(search.json()).hits).toHaveLength(0);
  });
});

describe('the tenant boundary', () => {
  it('hides another vault behind the same answer as a missing file', async () => {
    await upload('/api/v1/files/geheim.bin', Buffer.from('privat'));

    const response = await server.inject({
      url: '/api/v1/files/geheim.bin?owner=julian',
      headers: { cookie: ramonaCookie },
    });

    // 404, never 403 — a 403 would confirm the file is there.
    expect(response.statusCode).toBe(404);
  });

  /**
   * Listing somebody else's vault lists what the caller's shares cover, and
   * nothing else — the same regions as every note query.
   *
   * Two worlds for each share: the second has more in the owner's vault beside
   * what is shared (a private folder, a sibling of a shared note, a file named
   * like the shared note plus a suffix, an empty folder next to it). The
   * grantee's listing must not change by a byte.
   */
  describe('listing somebody else\'s vault', () => {
    async function listing(): Promise<{ status: number; body: string }> {
      const response = await server.inject({ url: '/api/v1/files?owner=julian', headers: { cookie: ramonaCookie } });
      return { status: response.statusCode, body: response.body.replace(/"mtimeMs":[0-9.]+/g, '"mtimeMs":0') };
    }

    async function secondWorld(): Promise<void> {
      await upload('/api/v1/files/Privat/geheim.pdf', Buffer.from('privat'));
      await upload('/api/v1/files/Homelab.pdf', Buffer.from('daneben'));
      await upload('/api/v1/files/Homelab2/nah.txt', Buffer.from('fast'));
      await upload('/api/v1/files/Homelab/Proxmox.md.bak', Buffer.from('kopie'));
      await runtime.app.createNote('julian', 'Homelab/Nachbar.md', '# Nachbar\n');
      await runtime.app.createFolder('julian', 'Leer');
    }

    it('lists a shared folder, and nothing beside it', async () => {
      await upload('/api/v1/files/Homelab/schema.png', Buffer.from('png'));
      runtime.shares.grant('julian', 'Homelab', 'ramona', false);
      const first = await listing();
      expect(first.status).toBe(200);
      const parsed = S.FilesResponse.parse(JSON.parse(first.body));
      expect(parsed.files.map((f) => f.path)).toEqual(['Homelab/Proxmox.md', 'Homelab/schema.png']);
      expect(parsed.dirs).toEqual(['Homelab']);

      await upload('/api/v1/files/Privat/geheim.pdf', Buffer.from('privat'));
      await upload('/api/v1/files/Homelab2/nah.txt', Buffer.from('fast'));
      await upload('/api/v1/files/Homelab.pdf', Buffer.from('daneben'));
      await runtime.app.createFolder('julian', 'Leer');
      expect(await listing()).toEqual(first);
    });

    it('lists a shared note alone, the same whether its neighbours exist or not', async () => {
      await runtime.app.createNote('julian', 'Homelab/Plan.md', '# Plan\n');
      runtime.shares.grant('julian', { kind: 'note', path: 'Homelab/Plan.md' }, 'ramona', false);
      await runtime.app.bindings.bindAll('julian', 'Homelab/Plan.md');
      const first = await listing();
      const parsed = S.FilesResponse.parse(JSON.parse(first.body));
      expect(parsed.files.map((f) => f.path)).toEqual(['Homelab/Plan.md']);
      expect(parsed.dirs).toEqual(['Homelab']);

      await secondWorld();
      await upload('/api/v1/files/Homelab/Plan.md.bak', Buffer.from('kopie'));
      await runtime.app.createFolder('julian', 'Homelab/Plan.md.d');
      expect(await listing()).toEqual(first);
    });

    it('answers a vault with no share on it exactly like one that does not exist', async () => {
      const foreign = await listing();
      const missing = await server.inject({ url: '/api/v1/files?owner=niemand', headers: { cookie: ramonaCookie } });
      expect(foreign).toEqual({ status: missing.statusCode, body: missing.body });
      expect(foreign.status).toBe(404);
    });

    it('lists a whole-vault share as the vault', async () => {
      runtime.shares.grant('julian', '', 'ramona', false);
      await upload('/api/v1/files/Privat/geheim.pdf', Buffer.from('privat'));
      const parsed = S.FilesResponse.parse(JSON.parse((await listing()).body));
      expect(parsed.files.map((f) => f.path)).toEqual(['Homelab/Proxmox.md', 'Privat/geheim.pdf']);
    });

    it('still lists your own vault', async () => {
      const response = await server.inject({
        url: '/api/v1/files',
        headers: { cookie: ramonaCookie },
      });

      expect(response.statusCode).toBe(200);
      expect(S.FilesResponse.parse(response.json()).files.map((f) => f.path)).not.toContain(
        'Homelab/Proxmox.md',
      );
    });
  });

  it('refuses a write into a share that is read-only', async () => {
    runtime.shares.grant('julian', 'Homelab/', 'ramona', false);

    const response = await upload(
      '/api/v1/files/Homelab/eingeschmuggelt.txt?owner=julian',
      Buffer.from('nope'),
      ramonaCookie,
    );

    expect(response.statusCode).toBe(404);
  });

  it('allows a write inside a writable share', async () => {
    runtime.shares.grant('julian', 'Homelab/', 'ramona', true);

    const response = await upload(
      '/api/v1/files/Homelab/von-ramona.txt?owner=julian',
      Buffer.from('hallo'),
      ramonaCookie,
    );

    expect(response.statusCode).toBe(201);
  });
});

describe('export', () => {
  /**
   * The bytes of one member, read back out of the archive.
   *
   * Enough of a zip reader to prove the entry holds the file that was on disk:
   * the local file header gives the name and the offset where the deflated data
   * begins, and raw inflate stops at the end of that stream by itself.
   */
  function memberOf(archive: Buffer, name: string): Buffer | null {
    for (let at = 0; at + 30 <= archive.length; at += 1) {
      if (archive.readUInt32LE(at) !== 0x04034b50) continue;
      const nameLength = archive.readUInt16LE(at + 26);
      const extraLength = archive.readUInt16LE(at + 28);
      const entry = archive.subarray(at + 30, at + 30 + nameLength).toString('utf8');
      if (entry !== name) continue;
      return zlib.inflateRawSync(archive.subarray(at + 30 + nameLength + extraLength));
    }
    return null;
  }

  /**
   * The archive is built while it is sent, not before.
   *
   * The comment on the route promised this from the start; the code under it
   * read every file into a Buffer first, so peak memory was the size of the
   * vault. `readFile` is the way to get a file's bytes into memory, and export
   * is the one route that must never use it: what it hands yazl is a path, and
   * yazl opens each file only when that entry's turn to be written comes.
   */
  it('never pulls a file into memory to archive it', async () => {
    await upload('/api/v1/files/gross.bin', Buffer.alloc(256 * 1024, 0x61));
    const readFile = vi.spyOn(runtime.app, 'readFile');

    const response = await server.inject({ url: '/api/v1/export', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(readFile).not.toHaveBeenCalled();
    // And the bytes are the file's, so streaming did not mean streaming the
    // wrong thing: an archive naming a member it never read would still be a
    // valid zip.
    expect(memberOf(response.rawPayload, 'gross.bin')).toEqual(Buffer.alloc(256 * 1024, 0x61));
    expect(memberOf(response.rawPayload, 'Homelab/Proxmox.md')?.toString()).toBe(
      '# Proxmox\n\nZwei Nodes.\n',
    );
  });

  /**
   * Streaming moved the failure: a file that disappears between the listing and
   * its turn in the archive is reported by yazl as an `error` event instead of a
   * rejected promise. Unhandled that would end the process, and the output
   * stream would never finish, so the request would hang instead of failing.
   */
  it('fails the response when a file vanishes mid-archive instead of hanging', async () => {
    vi.spyOn(runtime.app, 'fileOnDisk').mockResolvedValue(path.join(dataDir, 'weg.bin'));

    const response = await server.inject({ url: '/api/v1/export', headers: { cookie } });

    expect(response.statusCode).toBe(500);
    // Not a zip: nothing was written yet, so the answer can still be a refusal
    // rather than an archive with a hole in it.
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('answers with a zip carrying the vault', async () => {
    await upload('/api/v1/files/bild.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const response = await server.inject({ url: '/api/v1/export', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/zip');
    // "PK" — the local file header magic. Enough to know it is a real archive
    // rather than an error page with a hopeful content type.
    expect(response.rawPayload.subarray(0, 2).toString()).toBe('PK');
    // Both members are named in the archive's bytes.
    const raw = response.rawPayload.toString('latin1');
    expect(raw).toContain('Homelab/Proxmox.md');
    expect(raw).toContain('bild.png');
  });

  it('exports only your own vault, never a share', async () => {
    runtime.shares.grant('julian', 'Homelab/', 'ramona', false);

    const response = await server.inject({ url: '/api/v1/export', headers: { cookie: ramonaCookie } });
    const raw = response.rawPayload.toString('latin1');

    // A lent folder must not become a permanent copy that revoking cannot recall.
    expect(raw).not.toContain('Proxmox.md');
  });
});
