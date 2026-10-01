/**
 * An agent key somebody makes for themselves.
 *
 * Making a key used to be an administrator's job. With one account that is
 * invisible; with three it means nobody but the operator can connect an agent
 * to their own notes, and the operator is handed a steady trickle of requests
 * to make keys for vaults they have no other reason to touch.
 *
 * So these routes exist beside the administrator's, and what matters is the
 * line between them. The owner comes from the session and never from the body,
 * which is the whole difference between this and the admin route with its check
 * removed. Somebody else's key is answered exactly as a key that is not there.
 * And a key made this way always runs out: "no deadline" stays where it was,
 * with the person who operates the machine that needs it.
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
let julian: string;
let ramona: string;

async function signIn(user: string, password: string): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { user, password },
  });
  return `${SESSION_COOKIE}=${response.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
}

/** Makes a key the ordinary way, and hands back the whole answer. */
async function make(cookie: string, payload: object) {
  return server.inject({ method: 'POST', url: '/api/v1/keys', headers: { cookie }, payload });
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-own-keys-'));
  const config = { ...loadConfig(), dataDir, cookieSecure: false };
  runtime = await createRuntime(config);
  // An administrator and an ordinary account: the point is that the second one
  // needs nothing from the first.
  await runtime.users.create('julian', 'ein gutes passwort', { role: 'admin' });
  await runtime.users.create('ramona', 'ihr gutes passwort');

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

  julian = await signIn('julian', 'ein gutes passwort');
  ramona = await signIn('ramona', 'ihr gutes passwort');
});

afterEach(async () => {
  await server.close();
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('making one', () => {
  it('needs no administrator, and hands back the secret once', async () => {
    const created = await make(ramona, { name: 'Claude' });

    expect(created.statusCode).toBe(201);
    const key = S.CreatedKeyResponse.parse(created.json());
    expect(key.secret).toMatch(/^ndb_[0-9a-f]{64}$/);
    expect(key.owner).toBe('ramona');

    // Nowhere else, ever: only the hash is kept.
    const listed = await server.inject({ url: '/api/v1/keys', headers: { cookie: ramona } });
    expect(JSON.stringify(listed.json())).not.toContain(key.secret);
  });

  /**
   * The line this route stands or falls on.
   *
   * `CreateOwnKeyRequest` has no `owner` and is `.strict()`, so naming one is a
   * malformed body rather than a quietly ignored field. Ignoring it would be
   * the same outcome today and a privilege escalation the day somebody adds the
   * property back "for symmetry".
   */
  it('refuses a body that names an owner, rather than ignoring it', async () => {
    const created = await make(ramona, { name: 'Claude', owner: 'julian' });

    expect(created.statusCode).toBe(400);
    expect(runtime.keys.list('julian')).toHaveLength(0);
  });

  it('refuses a key with no deadline; that stays with the administrator', async () => {
    expect((await make(ramona, { name: 'Cron', expiresInDays: null })).statusCode).toBe(400);

    // And the administrator's route still takes it, for the job that needs it.
    const byAdmin = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/keys',
      headers: { cookie: julian },
      payload: { owner: 'julian', name: 'Cron', expiresInDays: null },
    });
    expect(byAdmin.statusCode).toBe(201);
    expect(S.CreatedKeyResponse.parse(byAdmin.json()).expiresAt).toBeNull();
  });

  it('takes a scope and a write flag, and defaults to read-only', async () => {
    const scoped = S.CreatedKeyResponse.parse(
      (await make(ramona, { name: 'Lesen', scope: '10_Projects' })).json(),
    );
    expect(scoped.scope).toBe('10_Projects/');
    expect(scoped.canWrite).toBe(false);

    const writing = S.CreatedKeyResponse.parse((await make(ramona, { name: 'Schreiben', canWrite: true })).json());
    expect(writing.canWrite).toBe(true);
  });

  it('is signed in or it is nothing', async () => {
    expect((await server.inject({ method: 'POST', url: '/api/v1/keys', payload: { name: 'x' } })).statusCode).toBe(401);
    expect((await server.inject({ url: '/api/v1/keys' })).statusCode).toBe(401);
  });
});

describe('listing them', () => {
  it('shows the caller’s own and nobody else’s', async () => {
    await make(ramona, { name: 'Ihrer' });
    await make(julian, { name: 'Seiner' });

    const mine = S.KeysResponse.parse((await server.inject({ url: '/api/v1/keys', headers: { cookie: ramona } })).json());
    expect(mine.keys.map((key) => key.name)).toEqual(['Ihrer']);
  });
});

describe('revoking one', () => {
  it('stops the key working', async () => {
    const key = S.CreatedKeyResponse.parse((await make(ramona, { name: 'Claude' })).json());
    expect(runtime.keys.resolve(key.secret)).not.toBeNull();

    const gone = await server.inject({
      method: 'DELETE',
      url: `/api/v1/keys/${key.id}`,
      headers: { cookie: ramona },
    });

    expect(gone.statusCode).toBe(204);
    expect(runtime.keys.resolve(key.secret)).toBeNull();
  });

  /**
   * Refusal looks like absence, which is the rule everywhere else in here.
   *
   * The two answers are compared rather than each checked against 404: a status
   * that matches while the body differs would still tell somebody that the key
   * they guessed at exists and belongs to another account.
   */
  it('answers somebody else’s key exactly as one that is not there', async () => {
    const hers = S.CreatedKeyResponse.parse((await make(ramona, { name: 'Ihrer' })).json());

    const other = await server.inject({
      method: 'DELETE',
      url: `/api/v1/keys/${hers.id}`,
      headers: { cookie: julian },
    });
    const nothing = await server.inject({
      method: 'DELETE',
      url: '/api/v1/keys/key_0000000000000000',
      headers: { cookie: julian },
    });

    expect(other.statusCode).toBe(404);
    expect(other.statusCode).toBe(nothing.statusCode);
    expect(other.body).toBe(nothing.body);
    // And hers still works, which is the thing the refusal was protecting.
    expect(runtime.keys.resolve(hers.secret)).not.toBeNull();
  });

  /** An administrator is not exempt here: this route is about one's own keys. */
  it('does not let an administrator through this door', async () => {
    const hers = S.CreatedKeyResponse.parse((await make(ramona, { name: 'Ihrer' })).json());

    expect(
      (await server.inject({ method: 'DELETE', url: `/api/v1/keys/${hers.id}`, headers: { cookie: julian } }))
        .statusCode,
    ).toBe(404);

    // The administrator's own route is where that is done, and it still works.
    expect(
      (await server.inject({
        method: 'DELETE',
        url: `/api/v1/admin/keys/${hers.id}`,
        headers: { cookie: julian },
      })).statusCode,
    ).toBe(204);
  });
});
