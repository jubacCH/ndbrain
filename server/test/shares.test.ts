import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { SESSION_COOKIE, buildServer } from '../src/http/server.js';
import { LoginThrottle } from '../src/http/throttle.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

let dataDir: string;
let runtime: Runtime;
let server: FastifyInstance;

/** Session cookies, so a request can be made as either person. */
const cookies: Record<string, string> = {};

async function login(user: string, password: string): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { user, password },
  });
  const jar = response.cookies.find((c) => c.name === SESSION_COOKIE);
  return `${jar?.name}=${jar?.value}`;
}

async function as(
  user: string,
  options: { method?: string; url: string; payload?: unknown },
): Promise<{ status: number; body: any }> {
  // Assembled rather than spread: under `exactOptionalPropertyTypes` a spread of
  // `{}` widens `payload` to include `undefined`, which does not match
  // `InjectOptions` — and a GET must not be given an empty body just to satisfy
  // the type, since that is not the request the route would really receive.
  const injection: InjectOptions = {
    method: (options.method ?? 'GET') as NonNullable<InjectOptions['method']>,
    url: options.url,
    headers: { cookie: cookies[user] ?? '' },
  };
  if (options.payload !== undefined) {
    injection.payload = options.payload as NonNullable<InjectOptions['payload']>;
  }

  const response = await server.inject(injection);
  return {
    status: response.statusCode,
    body: response.body === '' ? null : response.json(),
  };
}

/** Julian shares one folder with Ramona. */
async function share(prefix: string, canWrite: boolean): Promise<string> {
  const { body } = await as('julian', {
    method: 'POST',
    url: '/api/v1/shares',
    payload: { grantee: 'ramona', prefix, canWrite },
  });
  return body.share.id;
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-shares-'));
  const config = { ...loadConfig(), dataDir, cookieSecure: false };
  runtime = await createRuntime(config);

  await runtime.users.create('julian', 'ein gutes passwort');
  await runtime.users.create('ramona', 'ihr gutes passwort');

  await runtime.app.createNote(
    'julian',
    'Projekt/Plan.md',
    '---\ntags: [projekt]\n---\n# Plan\n\nZwei Nodes, Qdevice auf [[Technik]].\n\n- [ ] Termin fixieren\n',
  );
  await runtime.app.createNote('julian', 'Projekt/Technik.md', '# Technik\n\nDetails zum Projekt.\n');
  await runtime.app.createNote('julian', 'Privat/Tagebuch.md', '# Tagebuch\n\nstreng geheim\n');
  await runtime.app.createNote('julian', 'Verweis.md', 'Siehe [[Plan]] — privat notiert.\n');
  await runtime.app.createNote('ramona', 'Eigenes.md', '# Eigenes\n\nRamonas Notiz.\n');

  server = await buildServer({
    app: runtime.app,
    users: runtime.users,
    sessions: runtime.sessions,
    keys: runtime.keys,
    shares: runtime.shares,
    config,
    throttle: new LoginThrottle({ limit: 1000 }),
  });

  cookies['julian'] = await login('julian', 'ein gutes passwort');
  cookies['ramona'] = await login('ramona', 'ihr gutes passwort');
});

afterEach(async () => {
  await server.close();
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const NOTE = '/api/v1/notes/Projekt/Plan.md?owner=julian';

describe('the permission matrix', () => {
  /**
   * The six operations, each as the caller would issue it. The expectation per
   * grant level is asserted below rather than in each case, so a new operation
   * cannot be added without deciding what it does at all three levels.
   */
  const OPERATIONS = {
    read: () => as('ramona', { url: NOTE }),
    write: () =>
      as('ramona', { method: 'PUT', url: NOTE, payload: { content: 'überschrieben\n' } }),
    rename: () =>
      as('ramona', {
        method: 'POST',
        url: '/api/v1/rename',
        payload: { owner: 'julian', from: 'Projekt/Plan.md', to: 'Projekt/Planung.md' },
      }),
    delete: () => as('ramona', { method: 'DELETE', url: NOTE }),
    search: () => as('ramona', { url: '/api/v1/search?q=Qdevice' }),
    backlinks: () => as('ramona', { url: '/api/v1/backlinks/Projekt/Plan.md?owner=julian' }),
  };

  describe('without a grant', () => {
    it.each(['read', 'write', 'rename', 'delete'] as const)(
      'answers %s exactly as for a note that does not exist',
      async (operation) => {
        const { status, body } = await OPERATIONS[operation]();
        expect(status).toBe(404);
        expect(JSON.stringify(body)).not.toContain('Qdevice');
      },
    );

    it('does not surface the note in search', async () => {
      const { body } = await OPERATIONS.search();
      expect(body.hits).toEqual([]);
    });

    it('does not surface the note in the tree, quick switcher or tags', async () => {
      expect(JSON.stringify((await as('ramona', { url: '/api/v1/tree' })).body)).not.toContain(
        'Projekt',
      );
      expect((await as('ramona', { url: '/api/v1/quickfind?q=Plan' })).body.notes).toEqual([]);
      expect(
        (await as('ramona', { url: '/api/v1/tags' })).body.tags.map((t: any) => t.tag),
      ).not.toContain('projekt');
    });
  });

  describe('with read access', () => {
    beforeEach(async () => {
      await share('Projekt', false);
    });

    it('reads the note and says it may not be written', async () => {
      const { status, body } = await OPERATIONS.read();
      expect(status).toBe(200);
      expect(body.note.content).toContain('Qdevice');
      expect(body.owner).toBe('julian');
      expect(body.canWrite).toBe(false);
    });

    it.each(['write', 'rename', 'delete'] as const)('still refuses %s', async (operation) => {
      const { status } = await OPERATIONS[operation]();
      expect(status).toBe(404);
    });

    it('leaves the note untouched after a refused write', async () => {
      await OPERATIONS.write();
      const note = await runtime.notes.getNote('julian', 'Projekt/Plan.md');
      expect(note.content).toContain('Qdevice');
    });

    it('finds the note in search, labelled with its owner', async () => {
      const { body } = await OPERATIONS.search();
      expect(body.hits).toHaveLength(1);
      expect(body.hits[0].owner).toBe('julian');
      expect(body.hits[0].path).toBe('Projekt/Plan.md');
    });

    it('shows the shared folder in the tree without the rest of the vault', async () => {
      const { body } = await as('ramona', { url: '/api/v1/tree' });
      const paths = body.notes.map((n: any) => `${n.owner}:${n.path}`);

      expect(paths).toContain('julian:Projekt/Plan.md');
      expect(paths).toContain('ramona:Eigenes.md');
      expect(paths).not.toContain('julian:Privat/Tagebuch.md');
      expect(body.dirs.map((d: any) => `${d.owner}:${d.path}`)).not.toContain('julian:Privat');
    });

    it('counts shared notes in the overview and lists their open tasks', async () => {
      const { body } = await as('ramona', { url: '/api/v1/overview' });
      expect(body.counts.notes).toBe(3); // her own note plus the two shared ones
      expect(body.tasks.map((t: any) => t.text)).toContain('Termin fixieren');
    });
  });

  describe('with write access', () => {
    beforeEach(async () => {
      await share('Projekt', true);
    });

    it('writes, and the change lands in the owner\'s vault', async () => {
      const { status } = await OPERATIONS.write();
      expect(status).toBe(200);

      const note = await runtime.notes.getNote('julian', 'Projekt/Plan.md');
      expect(note.content).toBe('überschrieben\n');
    });

    it('records who actually made the change, not whose vault it is', async () => {
      await OPERATIONS.write();
      const activity = runtime.app.queries.activity('julian', 0);
      expect(activity.find((row) => row.path === 'Projekt/Plan.md')?.actor).toBe('ramona');
    });

    it('renames inside the shared folder', async () => {
      const { status } = await OPERATIONS.rename();
      expect(status).toBe(200);
      expect(runtime.app.queries.getNote('julian', 'julian', 'Projekt/Planung.md')).toBeDefined();
    });

    it('deletes inside the shared folder', async () => {
      const { status } = await OPERATIONS.delete();
      expect(status).toBe(204);
    });
  });
});

describe('the edge of a share', () => {
  beforeEach(async () => {
    await share('Projekt', true);
  });

  it('does not treat a folder that merely starts the same as shared', async () => {
    await runtime.app.createNote('julian', 'Projekt-Privat/Geheim.md', 'nicht geteilt\n');

    const { status } = await as('ramona', {
      url: '/api/v1/notes/Projekt-Privat/Geheim.md?owner=julian',
    });
    expect(status).toBe(404);
  });

  it('refuses to move a note out of the shared folder', async () => {
    const { status } = await as('ramona', {
      method: 'POST',
      url: '/api/v1/rename',
      payload: { owner: 'julian', from: 'Projekt/Plan.md', to: 'Plan.md' },
    });

    expect(status).toBe(404);
    expect(runtime.app.queries.getNote('julian', 'julian', 'Projekt/Plan.md')).toBeDefined();
  });

  it('refuses to move a note out of the shared folder in bulk either', async () => {
    const { body } = await as('ramona', {
      method: 'POST',
      url: '/api/v1/bulk',
      payload: { owner: 'julian', action: 'move', paths: ['Projekt/Plan.md'], dir: 'Anderswo' },
    });

    expect(body.ok ?? []).toEqual([]);
    expect(runtime.app.queries.getNote('julian', 'julian', 'Projekt/Plan.md')).toBeDefined();
  });

  it('reports an out-of-scope note in a bulk selection as missing, and does the rest', async () => {
    const { body } = await as('ramona', {
      method: 'POST',
      url: '/api/v1/bulk',
      payload: {
        owner: 'julian',
        action: 'tag',
        paths: ['Projekt/Plan.md', 'Privat/Tagebuch.md'],
        tag: 'sortiert',
      },
    });

    expect(body.ok).toEqual(['Projekt/Plan.md']);
    expect(body.failed).toEqual([{ path: 'Privat/Tagebuch.md', reason: 'note does not exist' }]);
    // The untouched note is genuinely untouched, not merely reported as failed.
    const untouched = await runtime.notes.getNote('julian', 'Privat/Tagebuch.md');
    expect(untouched.content).not.toContain('sortiert');
  });

  it('cannot create a note outside the shared folder', async () => {
    const { status } = await as('ramona', {
      method: 'PUT',
      url: '/api/v1/notes/Eingeschleust.md?owner=julian',
      payload: { content: 'x' },
    });

    expect(status).toBe(404);
    expect(runtime.app.queries.getNote('julian', 'julian', 'Eingeschleust.md')).toBeUndefined();
  });

  it('never lets a share be passed on', async () => {
    // Ramona grants "julian's Projekt" to a third account. What she can actually
    // grant is her own vault — the endpoint takes the owner from her session.
    await runtime.users.create('gast', 'noch ein passwort');
    await as('ramona', {
      method: 'POST',
      url: '/api/v1/shares',
      payload: { grantee: 'gast', prefix: 'Projekt', canWrite: true },
    });

    cookies['gast'] = await login('gast', 'noch ein passwort');
    const { status } = await as('gast', { url: NOTE });
    expect(status).toBe(404);
  });
});

describe('links stop at the sharing boundary', () => {
  it('does not reveal a private note that links to a shared one', async () => {
    await share('Projekt', false);

    // `Verweis.md` links to `Plan.md` but is not itself shared. Ramona may read
    // the target; naming the source would tell her a note she cannot see exists.
    const { body } = await as('ramona', {
      url: '/api/v1/backlinks/Projekt/Plan.md?owner=julian',
    });

    expect(body.backlinks.map((l: any) => l.source)).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('Verweis');
  });

  it('shows the owner their own backlinks in full', async () => {
    await share('Projekt', false);
    const { body } = await as('julian', { url: '/api/v1/backlinks/Projekt/Plan.md' });
    expect(body.backlinks.map((l: any) => l.source)).toContain('Verweis.md');
  });

  it('does not resolve a link across vaults', async () => {
    await share('Projekt', true);
    await as('ramona', {
      method: 'PUT',
      url: '/api/v1/notes/Projekt/Neu.md?owner=julian',
      payload: { content: 'Siehe [[Eigenes]].\n' },
    });

    // `Eigenes.md` is Ramona's own note. Written into Julian's vault, the link
    // has no target — vaults do not link to each other.
    const outgoing = runtime.app.queries.outgoingLinks('julian', 'julian', 'Projekt/Neu.md');
    expect(outgoing[0]?.targetPath).toBeNull();
  });
});

describe('withdrawing a share', () => {
  it('ends access immediately, with no cached decision', async () => {
    const id = await share('Projekt', true);
    expect((await as('ramona', { url: NOTE })).status).toBe(200);

    await as('julian', { method: 'DELETE', url: `/api/v1/shares/${id}` });

    expect((await as('ramona', { url: NOTE })).status).toBe(404);
    expect((await as('ramona', { url: '/api/v1/search?q=Qdevice' })).body.hits).toEqual([]);
  });

  it('lets the grantee decline it too', async () => {
    const id = await share('Projekt', false);
    const { status } = await as('ramona', { method: 'DELETE', url: `/api/v1/shares/${id}` });

    expect(status).toBe(204);
    expect((await as('ramona', { url: NOTE })).status).toBe(404);
  });

  it('is invisible to anybody else', async () => {
    await runtime.users.create('gast', 'noch ein passwort');
    cookies['gast'] = await login('gast', 'noch ein passwort');

    const id = await share('Projekt', false);
    const { status } = await as('gast', { method: 'DELETE', url: `/api/v1/shares/${id}` });

    expect(status).toBe(404);
    expect((await as('ramona', { url: NOTE })).status).toBe(200);
  });

  it('re-granting changes the right instead of stacking a second grant', async () => {
    const first = await share('Projekt', false);
    const second = await share('Projekt', true);

    expect(second).toBe(first);
    expect(runtime.shares.toGrantee('ramona')).toHaveLength(1);
    expect((await OPERATIONS_write()).status).toBe(200);
  });

  async function OPERATIONS_write(): Promise<{ status: number }> {
    return as('ramona', { method: 'PUT', url: NOTE, payload: { content: 'neu\n' } });
  }
});

describe('managing shares', () => {
  it('lists both directions', async () => {
    await share('Projekt', true);

    const mine = await as('julian', { url: '/api/v1/shares' });
    expect(mine.body.granted).toHaveLength(1);
    expect(mine.body.received).toEqual([]);

    const hers = await as('ramona', { url: '/api/v1/shares' });
    expect(hers.body.granted).toEqual([]);
    expect(hers.body.received[0].owner).toBe('julian');
  });

  it('normalises the prefix to a folder boundary', async () => {
    await share('/Projekt/', false);
    expect(runtime.shares.toGrantee('ramona')[0]?.prefix).toBe('Projekt/');
  });

  it('treats an empty prefix as the whole vault', async () => {
    await share('', false);
    expect((await as('ramona', { url: '/api/v1/notes/Privat/Tagebuch.md?owner=julian' })).status)
      .toBe(200);
  });

  it('refuses to share with somebody who does not exist', async () => {
    const { status, body } = await as('julian', {
      method: 'POST',
      url: '/api/v1/shares',
      payload: { grantee: 'niemand', prefix: 'Projekt' },
    });
    expect(status).toBe(404);
    expect(body.code).toBe('no_such_user');
  });

  it('refuses to share a vault with its own owner', async () => {
    const { status, body } = await as('julian', {
      method: 'POST',
      url: '/api/v1/shares',
      payload: { grantee: 'julian', prefix: 'Projekt' },
    });
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_share');
  });

  it('needs a session', async () => {
    expect((await server.inject({ url: '/api/v1/shares' })).statusCode).toBe(401);
  });
});

describe('conflicting writes to a shared note', () => {
  beforeEach(async () => {
    await share('Projekt', true);
  });

  /** Reads the note the way a client would, to get the mtime it should send back. */
  async function open(user: string): Promise<number> {
    const { body } = await as(user, { url: NOTE });
    return body.note.mtimeMs;
  }

  it('keeps the displaced version instead of dropping it', async () => {
    const base = await open('ramona');

    // Julian writes while Ramona has the note open…
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.app.updateNote('julian', 'Projekt/Plan.md', 'Julians Fassung\n', 'julian');

    // …and Ramona saves on top of it.
    const { status, body } = await as('ramona', {
      method: 'PUT',
      url: NOTE,
      payload: { content: 'Ramonas Fassung\n', baseMtimeMs: base },
    });

    expect(status).toBe(200);
    expect(body.conflictCopy).toMatch(/^Projekt\/Plan \(Konflikt .+\)\.md$/);

    // Last writer wins, and the version that lost is still on disk.
    expect((await runtime.notes.getNote('julian', 'Projekt/Plan.md')).content).toBe(
      'Ramonas Fassung\n',
    );
    expect((await runtime.notes.getNote('julian', body.conflictCopy)).content).toBe(
      'Julians Fassung\n',
    );
  });

  it('makes the conflict copy findable rather than leaving it lying in the folder', async () => {
    const base = await open('ramona');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.app.updateNote('julian', 'Projekt/Plan.md', 'Julians eigenwillige Fassung\n');

    await as('ramona', {
      method: 'PUT',
      url: NOTE,
      payload: { content: 'Ramonas Fassung\n', baseMtimeMs: base },
    });

    const { body } = await as('ramona', { url: '/api/v1/search?q=eigenwillige' });
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0].path).toMatch(/Konflikt/);
  });

  it('does not make a copy when nobody else wrote in the meantime', async () => {
    const base = await open('ramona');
    const { body } = await as('ramona', {
      method: 'PUT',
      url: NOTE,
      payload: { content: 'nur ich\n', baseMtimeMs: base },
    });

    expect(body.conflictCopy).toBeUndefined();
  });

  it('does not make a copy when both wrote the same text', async () => {
    const base = await open('ramona');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.app.updateNote('julian', 'Projekt/Plan.md', 'dasselbe\n');

    const { body } = await as('ramona', {
      method: 'PUT',
      url: NOTE,
      payload: { content: 'dasselbe\n', baseMtimeMs: base },
    });

    expect(body.conflictCopy).toBeUndefined();
  });

  it('leaves a client that sends no base version with the old behaviour', async () => {
    await runtime.app.updateNote('julian', 'Projekt/Plan.md', 'Julians Fassung\n');

    const { body } = await as('ramona', {
      method: 'PUT',
      url: NOTE,
      payload: { content: 'Ramonas Fassung\n' },
    });

    expect(body.conflictCopy).toBeUndefined();
  });
});
