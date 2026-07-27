import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { SESSION_COOKIE, buildServer } from '../src/http/server.js';
import { LoginThrottle } from '../src/http/throttle.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

let dataDir: string;
let runtime: Runtime;
let server: FastifyInstance;
let julianCookie: string;
let ramonaCookie: string;

async function login(user: string, password: string): Promise<string | null> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { user, password },
  });
  if (response.statusCode !== 200) return null;
  const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE);
  return cookie ? `${cookie.name}=${cookie.value}` : null;
}

function as(cookie: string) {
  return { cookie };
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-api-'));
  const config = { ...loadConfig(), dataDir, cookieSecure: false };
  runtime = await createRuntime(config);

  await runtime.users.create('julian', 'ein gutes passwort', { role: 'admin' });
  await runtime.users.create('ramona', 'ihr gutes passwort');

  server = await buildServer({
    app: runtime.app,
    users: runtime.users,
    sessions: runtime.sessions,
    keys: runtime.keys,
    config,
    throttle: new LoginThrottle({ limit: 1000 }),
  });

  julianCookie = (await login('julian', 'ein gutes passwort'))!;
  ramonaCookie = (await login('ramona', 'ihr gutes passwort'))!;

  await runtime.app.createNote('ramona', 'Privat/Tagebuch.md', 'Ramonas geheimes stichwort\n');
});

afterEach(async () => {
  await server.close();
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('the authentication gate', () => {
  it.each([
    ['GET', '/api/v1/tree'],
    ['GET', '/api/v1/notes/Irgendwas.md'],
    ['PUT', '/api/v1/notes/Irgendwas.md'],
    ['DELETE', '/api/v1/notes/Irgendwas.md'],
    ['POST', '/api/v1/rename'],
    ['GET', '/api/v1/search?q=test'],
    ['GET', '/api/v1/overview'],
    ['GET', '/api/v1/tidy'],
    ['GET', '/api/v1/backlinks/Irgendwas.md'],
    ['GET', '/api/v1/auth/me'],
  ])('refuses %s %s without a session', async (method, url) => {
    const response = await server.inject({ method: method as 'GET', url, payload: {} });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'unauthenticated' });
  });

  it('is not fooled by percent-encoding in the path', async () => {
    // v1 shipped exactly this hole: the gate compared the raw URL, so an encoded
    // route name slipped past and was decoded afterwards.
    for (const url of [
      '/api/v1/%74ree',
      '/%61pi/v1/tree',
      '/api/v1/auth/login/../tree',
      '/api/v1/notes/%2e%2e%2framona%2fPrivat%2fTagebuch.md',
    ]) {
      const response = await server.inject({ method: 'GET', url });
      expect([400, 401, 404]).toContain(response.statusCode);
      expect(response.body).not.toContain('geheimes');
    }
  });

  it('rejects a forged or expired cookie', async () => {
    for (const cookie of [`${SESSION_COOKIE}=erfunden`, `${SESSION_COOKIE}=`]) {
      const response = await server.inject({ method: 'GET', url: '/api/v1/tree', headers: as(cookie) });
      expect(response.statusCode).toBe(401);
    }
  });

  it('stops working the moment the account is disabled', async () => {
    expect((await server.inject({ url: '/api/v1/tree', headers: as(julianCookie) })).statusCode).toBe(200);
    runtime.users.setDisabled('julian', true);
    expect((await server.inject({ url: '/api/v1/tree', headers: as(julianCookie) })).statusCode).toBe(401);
  });

  it('lets health through without a session', async () => {
    expect((await server.inject({ url: '/api/v1/health' })).statusCode).toBe(200);
  });
});

describe('login', () => {
  it('gives the same answer for a wrong name and a wrong password', async () => {
    const wrongPassword = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { user: 'julian', password: 'falsch' },
    });
    const wrongName = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { user: 'gibtsnicht', password: 'falsch' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongName.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(wrongName.json());
  });

  it('sets an httpOnly cookie', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { user: 'julian', password: 'ein gutes passwort' },
    });
    const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.path).toBe('/');
  });

  it('throttles repeated failures', async () => {
    const throttled = await buildServer({
      app: runtime.app,
      users: runtime.users,
      sessions: runtime.sessions,
      keys: runtime.keys,
      config: { ...runtime.config, cookieSecure: false },
      throttle: new LoginThrottle({ limit: 3, windowMs: 60_000 }),
    });

    for (let i = 0; i < 3; i += 1) {
      const response = await throttled.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { user: 'julian', password: 'falsch' },
      });
      expect(response.statusCode).toBe(401);
    }

    const blocked = await throttled.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { user: 'julian', password: 'ein gutes passwort' },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();

    await throttled.close();
  });

  it('logs out', async () => {
    const cookie = (await login('julian', 'ein gutes passwort'))!;
    expect((await server.inject({ url: '/api/v1/tree', headers: as(cookie) })).statusCode).toBe(200);

    await server.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: as(cookie) });

    expect((await server.inject({ url: '/api/v1/tree', headers: as(cookie) })).statusCode).toBe(401);
  });
});

describe('notes', () => {
  it('creates, reads, updates and deletes', async () => {
    const created = await server.inject({
      method: 'PUT',
      url: '/api/v1/notes/Homelab/Proxmox.md',
      headers: as(julianCookie),
      payload: { content: '# Proxmox\n\nText #homelab\n' },
    });
    expect(created.statusCode).toBe(201);

    const read = await server.inject({
      url: '/api/v1/notes/Homelab/Proxmox.md',
      headers: as(julianCookie),
    });
    expect(read.json().note.content).toBe('# Proxmox\n\nText #homelab\n');
    expect(read.json().note.title).toBe('Proxmox');

    const updated = await server.inject({
      method: 'PUT',
      url: '/api/v1/notes/Homelab/Proxmox.md',
      headers: as(julianCookie),
      payload: { content: 'geändert\n' },
    });
    expect(updated.statusCode).toBe(200);

    const deleted = await server.inject({
      method: 'DELETE',
      url: '/api/v1/notes/Homelab/Proxmox.md',
      headers: as(julianCookie),
    });
    expect(deleted.statusCode).toBe(204);

    const gone = await server.inject({
      url: '/api/v1/notes/Homelab/Proxmox.md',
      headers: as(julianCookie),
    });
    expect(gone.statusCode).toBe(404);
  });

  it('handles spaces and umlauts in note names', async () => {
    const url = `/api/v1/notes/${encodeURIComponent('Küche/Rezept für Brot.md')}`;
    const created = await server.inject({
      method: 'PUT',
      url,
      headers: as(julianCookie),
      payload: { content: 'Mehl\n' },
    });
    expect(created.statusCode).toBe(201);
    expect((await server.inject({ url, headers: as(julianCookie) })).json().note.content).toBe('Mehl\n');
  });

  it('indexes immediately, so a note is searchable right after writing', async () => {
    await server.inject({
      method: 'PUT',
      url: '/api/v1/notes/Sofort.md',
      headers: as(julianCookie),
      payload: { content: 'unverwechselbares kennwort\n' },
    });

    const found = await server.inject({
      url: '/api/v1/search?q=unverwechselbares',
      headers: as(julianCookie),
    });
    expect(found.json().hits).toHaveLength(1);
  });

  it('renames and reports which notes were rewritten', async () => {
    await runtime.app.createNote('julian', 'Ziel.md', '# Z\n');
    await runtime.app.createNote('julian', 'A.md', 'Siehe [[Ziel]].\n');

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/rename',
      headers: as(julianCookie),
      payload: { from: 'Ziel.md', to: 'Neu.md' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().updatedLinks).toEqual(['A.md']);
  });
});

describe('error taxonomy', () => {
  it.each([
    ['a path that is not a note', 'PUT', '/api/v1/notes/bild.png', 400, 'invalid_path'],
    ['traversal', 'GET', '/api/v1/notes/..%2F..%2Fetc%2Fpasswd', 400, 'invalid_path'],
    ['a missing note', 'GET', '/api/v1/notes/Fehlt.md', 404, 'not_found'],
    ['an unknown endpoint', 'GET', '/api/v1/gibtsnicht', 404, 'not_found'],
  ])('answers %s with %s', async (_label, method, url, status, code) => {
    const response = await server.inject({
      method: method as 'GET',
      url,
      headers: as(julianCookie),
      payload: { content: 'x' },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json().code).toBe(code);
  });

  it('reports a case collision as such', async () => {
    await runtime.app.createNote('julian', 'Proxmox.md', 'a');
    const response = await server.inject({
      method: 'PUT',
      url: '/api/v1/notes/proxmox.md',
      headers: as(julianCookie),
      payload: { content: 'b' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('case_collision');
  });

  it('never leaks a stack trace or a filesystem path', async () => {
    const responses = await Promise.all([
      server.inject({ url: '/api/v1/notes/Fehlt.md', headers: as(julianCookie) }),
      server.inject({ url: '/api/v1/notes/..%2Fx.md', headers: as(julianCookie) }),
      server.inject({ method: 'POST', url: '/api/v1/rename', headers: as(julianCookie), payload: {} }),
    ]);

    for (const response of responses) {
      expect(response.body).not.toMatch(/at [A-Za-z]+ \(/); // stack frame
      expect(response.body.toLowerCase()).not.toContain(dataDir.toLowerCase().slice(0, 12));
      expect(response.body).not.toContain('vaults');
    }
  });
});

describe('one user never sees another', () => {
  it.each([
    ['read', 'GET', '/api/v1/notes/Privat/Tagebuch.md'],
    ['backlinks', 'GET', '/api/v1/backlinks/Privat/Tagebuch.md'],
  ])('%s of a foreign note answers exactly as for a missing one', async (_label, method, url) => {
    const foreign = await server.inject({ method: method as 'GET', url, headers: as(julianCookie) });
    const missing = await server.inject({
      method: method as 'GET',
      url: url.replace('Tagebuch', 'GibtEsNicht'),
      headers: as(julianCookie),
    });

    // Identical responses: any difference would confirm the note exists.
    expect(foreign.statusCode).toBe(missing.statusCode);
    expect(foreign.json()).toEqual(missing.json());
  });

  it('cannot overwrite a foreign note', async () => {
    await server.inject({
      method: 'PUT',
      url: '/api/v1/notes/Privat/Tagebuch.md',
      headers: as(julianCookie),
      payload: { content: 'eingeschleust' },
    });

    const ramonas = await server.inject({
      url: '/api/v1/notes/Privat/Tagebuch.md',
      headers: as(ramonaCookie),
    });
    expect(ramonas.json().note.content).toBe('Ramonas geheimes stichwort\n');
  });

  it('cannot delete or rename a foreign note', async () => {
    await server.inject({
      method: 'DELETE',
      url: '/api/v1/notes/Privat/Tagebuch.md',
      headers: as(julianCookie),
    });
    await server.inject({
      method: 'POST',
      url: '/api/v1/rename',
      headers: as(julianCookie),
      payload: { from: 'Privat/Tagebuch.md', to: 'Geklaut.md' },
    });

    expect(
      (await server.inject({ url: '/api/v1/notes/Privat/Tagebuch.md', headers: as(ramonaCookie) }))
        .statusCode,
    ).toBe(200);
  });

  it('does not show foreign notes in the tree, search, overview or tidy view', async () => {
    const body = async (url: string): Promise<string> =>
      (await server.inject({ url, headers: as(julianCookie) })).body;

    expect(await body('/api/v1/tree')).not.toContain('Tagebuch');
    expect(await body('/api/v1/search?q=geheimes')).not.toContain('Tagebuch');
    expect(await body('/api/v1/tidy')).not.toContain('Tagebuch');
    expect(await body('/api/v1/overview')).not.toContain('Tagebuch');
  });

  it('counts only the caller\'s own notes', async () => {
    await runtime.app.createNote('julian', 'Eigen.md', 'x');
    const overview = await server.inject({ url: '/api/v1/overview', headers: as(julianCookie) });
    expect(overview.json().counts.notes).toBe(1);
  });

  it('cannot be told to act as somebody else', async () => {
    // There is no owner parameter anywhere; these are attempts to invent one.
    for (const url of [
      '/api/v1/tree?user=ramona',
      '/api/v1/tree?owner=ramona',
      '/api/v1/search?q=geheimes&user=ramona',
    ]) {
      const response = await server.inject({ url, headers: as(julianCookie) });
      expect(response.body).not.toContain('Tagebuch');
      expect(response.body).not.toContain('geheimes');
    }
  });
});
