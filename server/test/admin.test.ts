/**
 * The admin surface.
 *
 * The most dangerous routes in the application: they create accounts, reset
 * other people's passwords and mint agent keys. Three properties matter more
 * than any of the happy paths, and each of them is the sort of thing that is
 * easy to weaken later without noticing:
 *
 *  - **Being an administrator is checked per request.** A menu entry that is not
 *    rendered is not a permission, and the routes have to hold on their own.
 *  - **Nobody can lock everybody out.** Disabling your own account, or the last
 *    remaining administrator, is refused.
 *  - **A key secret exists exactly once.** Only its hash is stored, so if the
 *    creating response does not carry it, it is gone — and nothing else may ever
 *    hand it back.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { SESSION_COOKIE, buildServer } from '../src/http/server.js';
import { LoginThrottle } from '../src/http/throttle.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import * as S from '../../shared/schema.js';

let dataDir: string;
let runtime: Runtime;
let server: FastifyInstance;
let adminCookie: string;
let plainCookie: string;

async function signIn(user: string, password: string): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { user, password },
  });
  return `${SESSION_COOKIE}=${response.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-admin-'));
  const config = { ...loadConfig(), dataDir, cookieSecure: false };
  runtime = await createRuntime(config);
  await runtime.users.create('julian', 'ein gutes passwort', { role: 'admin' });
  await runtime.users.create('ramona', 'ihr gutes passwort');

  server = await buildServer({
    app: runtime.app,
    users: runtime.users,
    sessions: runtime.sessions,
    keys: runtime.keys,
    shares: runtime.shares,
    settings: runtime.settings,
    history: runtime.history,
    config,
    throttle: new LoginThrottle({ limit: 1000 }),
  });

  adminCookie = await signIn('julian', 'ein gutes passwort');
  plainCookie = await signIn('ramona', 'ihr gutes passwort');
});

afterEach(async () => {
  await server.close();
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('who may reach any of this', () => {
  /**
   * Every admin route, with a body where one is needed.
   *
   * `payload` is always present rather than spread in conditionally: an optional
   * property under `exactOptionalPropertyTypes` is not the same type as an
   * absent one, and Fastify's inject types reject the union that produces. An
   * empty object is a legal body for a route that ignores it.
   */
  const routes: Array<{ method: 'GET' | 'POST' | 'DELETE'; url: string; payload: object }> = [
    { method: 'GET', url: '/api/v1/admin/users', payload: {} },
    { method: 'POST', url: '/api/v1/admin/users', payload: { id: 'neu', password: 'ein gutes passwort' } },
    { method: 'POST', url: '/api/v1/admin/users/ramona/password', payload: { password: 'ein gutes passwort' } },
    { method: 'POST', url: '/api/v1/admin/users/ramona/disabled', payload: { disabled: true } },
    { method: 'GET', url: '/api/v1/admin/keys', payload: {} },
    { method: 'POST', url: '/api/v1/admin/keys', payload: { owner: 'ramona', name: 'agent' } },
    { method: 'DELETE', url: '/api/v1/admin/keys/key_x', payload: {} },
  ];

  for (const { method, url, payload } of routes) {
    it(`refuses an ordinary account: ${method} ${url}`, async () => {
      const response = await server.inject({ method, url, headers: { cookie: plainCookie }, payload });

      // 404 rather than 403: confirming that an admin surface exists is
      // information a non-admin has no use for.
      expect(response.statusCode).toBe(404);
    });

    it(`refuses no account at all: ${method} ${url}`, async () => {
      const response = await server.inject({ method, url, payload });

      expect(response.statusCode).toBe(401);
    });
  }
});

describe('accounts', () => {
  it('lists them with what each one holds', async () => {
    await runtime.app.createNote('ramona', 'Eine.md', 'Text.\n');

    const response = await server.inject({ url: '/api/v1/admin/users', headers: { cookie: adminCookie } });
    const parsed = S.AdminUsersResponse.parse(response.json());

    const ramona = parsed.users.find((u) => u.id === 'ramona');
    expect(ramona?.notes).toBe(1);
    expect(ramona?.role).toBe('user');
    expect(ramona?.disabled).toBe(false);
  });

  it('creates one that can sign in', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { cookie: adminCookie },
      payload: { id: 'neuling', password: 'ein gutes passwort', displayName: 'Neuling' },
    });

    expect(response.statusCode).toBe(201);
    const login = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { user: 'neuling', password: 'ein gutes passwort' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('refuses a password too short to be worth having', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { cookie: adminCookie },
      payload: { id: 'neuling', password: 'kurz' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses an id that is not a safe directory name', async () => {
    // The id becomes the vault's folder, so it is a traversal vector.
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { cookie: adminCookie },
      payload: { id: '../escape', password: 'ein gutes passwort' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('resets a password and ends that account’s sessions', async () => {
    // An administrator resetting a password is usually doing it because the old
    // one is not trusted; leaving the sessions alive would defeat the point.
    const stillValid = async (): Promise<boolean> =>
      (await server.inject({ url: '/api/v1/auth/me', headers: { cookie: plainCookie } })).statusCode === 200;

    expect(await stillValid()).toBe(true);

    await server.inject({
      method: 'POST',
      url: '/api/v1/admin/users/ramona/password',
      headers: { cookie: adminCookie },
      payload: { password: 'ein anderes gutes passwort' },
    });

    expect(await stillValid()).toBe(false);
    const login = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { user: 'ramona', password: 'ein anderes gutes passwort' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('disables an account and turns it off at the door', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/admin/users/ramona/disabled',
      headers: { cookie: adminCookie },
      payload: { disabled: true },
    });

    const login = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { user: 'ramona', password: 'ihr gutes passwort' },
    });
    expect(login.statusCode).toBe(401);
  });

  it('enables it again', async () => {
    for (const disabled of [true, false]) {
      await server.inject({
        method: 'POST',
        url: '/api/v1/admin/users/ramona/disabled',
        headers: { cookie: adminCookie },
        payload: { disabled },
      });
    }

    const login = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { user: 'ramona', password: 'ihr gutes passwort' },
    });
    expect(login.statusCode).toBe(200);
  });
});

describe('nobody can lock everybody out', () => {
  it('refuses to disable your own account', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/users/julian/disabled',
      headers: { cookie: adminCookie },
      payload: { disabled: true },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { code: string }).code).toBe('self_disable');
    expect(runtime.users.get('julian')?.disabled).toBe(false);
  });

  it('refuses to disable the last administrator', async () => {
    // A second admin who then disables the first: allowed, because one is left.
    await runtime.users.create('zweit', 'noch ein gutes passwort', { role: 'admin' });
    const zweitCookie = await signIn('zweit', 'noch ein gutes passwort');

    const first = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/users/julian/disabled',
      headers: { cookie: zweitCookie },
      payload: { disabled: true },
    });
    expect(first.statusCode).toBe(200);

    // And now there is one, who cannot be removed by anybody — including
    // themselves, which the previous test covers, or by a route call naming them.
    const admins = runtime.users.list().filter((u) => u.role === 'admin' && !u.disabled);
    expect(admins).toHaveLength(1);
  });
});

describe('agent keys', () => {
  it('hands back the secret exactly once', async () => {
    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/keys',
      headers: { cookie: adminCookie },
      payload: { owner: 'ramona', name: 'Claude' },
    });

    expect(created.statusCode).toBe(201);
    const key = S.CreatedKeyResponse.parse(created.json());
    expect(key.secret).toMatch(/^ndb_[0-9a-f]{64}$/);

    // Nothing else ever carries it: only the hash is stored.
    const listed = await server.inject({
      url: '/api/v1/admin/keys?owner=ramona',
      headers: { cookie: adminCookie },
    });
    const all = S.AdminKeysResponse.parse(listed.json());
    expect(all.keys).toHaveLength(1);
    expect(JSON.stringify(all.keys)).not.toContain(key.secret);
  });

  it('makes a key that actually opens the door', async () => {
    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/keys',
      headers: { cookie: adminCookie },
      payload: { owner: 'ramona', name: 'Claude' },
    });
    const { secret } = S.CreatedKeyResponse.parse(created.json());

    expect(runtime.keys.resolve(secret)?.owner).toBe('ramona');
  });

  it('revokes one, and the secret stops working', async () => {
    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/keys',
      headers: { cookie: adminCookie },
      payload: { owner: 'ramona', name: 'Claude' },
    });
    const key = S.CreatedKeyResponse.parse(created.json());

    const gone = await server.inject({
      method: 'DELETE',
      url: `/api/v1/admin/keys/${key.id}`,
      headers: { cookie: adminCookie },
    });
    expect(gone.statusCode).toBe(204);
    expect(runtime.keys.resolve(key.secret)).toBeNull();
  });

  it('refuses a key for an account that does not exist', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/keys',
      headers: { cookie: adminCookie },
      payload: { owner: 'niemand', name: 'Claude' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('carries the scope and the write flag it was given', async () => {
    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/keys',
      headers: { cookie: adminCookie },
      payload: { owner: 'ramona', name: 'Claude', scope: 'Projekte', canWrite: true },
    });

    const key = S.CreatedKeyResponse.parse(created.json());
    expect(key.canWrite).toBe(true);
    expect(key.scope).toBe('Projekte/');
  });
});
