/**
 * The account and preference routes behind the settings page.
 *
 * Changing a password needed shell access on the box until now, which in
 * practice meant nobody changed one — and a credential that cannot be rotated
 * without a sysadmin is a credential that stays put after it leaks.
 *
 * Three rules are worth pinning down, because each is easy to weaken later and
 * none of them is visible in the interface:
 *
 *  - the **current** password is required even though the caller already holds a
 *    session, since a cookie proves somebody signed in once, not that the person
 *    at the keyboard now is the account holder
 *  - a change **ends every other session**, or it changes nothing for the person
 *    it was meant to lock out
 *  - the caller keeps working afterwards, or it is a button that signs you out
 *    for pressing it
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
let cookie: string;

const PASSWORD = 'ein gutes passwort';

async function signIn(password = PASSWORD): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { user: 'julian', password },
  });
  return `${SESSION_COOKIE}=${response.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
}

/** Whether a cookie still opens a door. */
async function stillValid(jar: string): Promise<boolean> {
  const response = await server.inject({ url: '/api/v1/auth/me', headers: { cookie: jar } });
  return response.statusCode === 200;
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-settings-'));
  const config = { ...loadConfig(), dataDir, cookieSecure: false };
  runtime = await createRuntime(config);
  await runtime.users.create('julian', PASSWORD, { role: 'admin' });

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

  cookie = await signIn();
});

afterEach(async () => {
  await server.close();
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('preferences', () => {
  it('starts at the documented default', async () => {
    const response = await server.inject({ url: '/api/v1/settings', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(S.SettingsResponse.parse(response.json()).settings.staleDays).toBe(42);
  });

  it('remembers a change', async () => {
    await server.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: { cookie },
      payload: { staleDays: 7 },
    });

    const response = await server.inject({ url: '/api/v1/settings', headers: { cookie } });
    expect(S.SettingsResponse.parse(response.json()).settings.staleDays).toBe(7);
  });

  it('actually changes which notes are reported as stale', async () => {
    // The point of storing it on the server rather than in the browser: it
    // changes what the server answers, not how the answer is drawn.
    await runtime.app.createNote('julian', 'Alt.md', 'Lange nicht angefasst.\n');
    const file = path.join(dataDir, 'vaults', 'julian', 'Alt.md');
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await fs.utimes(file, tenDaysAgo, tenDaysAgo);
    await runtime.indexer.rebuild('julian');

    const staleCount = async (): Promise<number> => {
      const response = await server.inject({ url: '/api/v1/tidy', headers: { cookie } });
      return (response.json() as { stale: unknown[] }).stale.length;
    };

    // Ten days old, default threshold is forty-two: not stale yet.
    expect(await staleCount()).toBe(0);

    await server.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: { cookie },
      payload: { staleDays: 5 },
    });

    expect(await staleCount()).toBe(1);
  });

  it('refuses a threshold that would switch the finding off', async () => {
    for (const staleDays of [0, -1, 99999]) {
      const response = await server.inject({
        method: 'PUT',
        url: '/api/v1/settings',
        headers: { cookie },
        payload: { staleDays },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('leaves untouched settings alone, so two tabs do not undo each other', async () => {
    await server.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: { cookie },
      payload: { staleDays: 14 },
    });
    // An empty patch is legitimate and must not reset anything.
    await server.inject({ method: 'PUT', url: '/api/v1/settings', headers: { cookie }, payload: {} });

    const response = await server.inject({ url: '/api/v1/settings', headers: { cookie } });
    expect(S.SettingsResponse.parse(response.json()).settings.staleDays).toBe(14);
  });

  it("keeps one account's preferences out of another's", async () => {
    await runtime.users.create('ramona', 'ihr gutes passwort');
    const hers = `${SESSION_COOKIE}=${
      (
        await server.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { user: 'ramona', password: 'ihr gutes passwort' },
        })
      ).cookies.find((c) => c.name === SESSION_COOKIE)?.value
    }`;

    await server.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: { cookie },
      payload: { staleDays: 3 },
    });

    const response = await server.inject({ url: '/api/v1/settings', headers: { cookie: hers } });
    expect(S.SettingsResponse.parse(response.json()).settings.staleDays).toBe(42);
  });
});

describe('changing a password', () => {
  it('requires the current one, even from a signed-in session', async () => {
    // A cookie proves somebody signed in at some point. It does not prove the
    // person at the keyboard right now is the account holder.
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/account/password',
      headers: { cookie },
      payload: { currentPassword: 'falsch', newPassword: 'ein noch besseres passwort' },
    });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe('wrong_password');
    // And it really did not change.
    expect(await signIn()).toBeTruthy();
  });

  it('refuses a new password too short to be worth having', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/account/password',
      headers: { cookie },
      payload: { currentPassword: PASSWORD, newPassword: 'kurz' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('changes it, and the old one stops working', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/account/password',
      headers: { cookie },
      payload: { currentPassword: PASSWORD, newPassword: 'ein noch besseres passwort' },
    });

    expect(response.statusCode).toBe(200);

    const withOld = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { user: 'julian', password: PASSWORD },
    });
    expect(withOld.statusCode).toBe(401);

    const withNew = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { user: 'julian', password: 'ein noch besseres passwort' },
    });
    expect(withNew.statusCode).toBe(200);
  });

  it('ends every other session and keeps this one working', async () => {
    // The whole point: a change that leaves an attacker's session alive has
    // locked nobody out.
    const otherDevice = await signIn();
    expect(await stillValid(otherDevice)).toBe(true);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/account/password',
      headers: { cookie },
      payload: { currentPassword: PASSWORD, newPassword: 'ein noch besseres passwort' },
    });

    const replacement = `${SESSION_COOKIE}=${
      response.cookies.find((c) => c.name === SESSION_COOKIE)?.value
    }`;

    expect(await stillValid(otherDevice)).toBe(false);
    // ...and the browser that made the change is not signed out by it.
    expect(await stillValid(replacement)).toBe(true);
  });
});

describe('signing out everywhere', () => {
  it('ends other sessions but not this one', async () => {
    const otherDevice = await signIn();

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/account/sessions/revoke',
      headers: { cookie },
    });
    const replacement = `${SESSION_COOKIE}=${
      response.cookies.find((c) => c.name === SESSION_COOKIE)?.value
    }`;

    expect(await stillValid(otherDevice)).toBe(false);
    expect(await stillValid(replacement)).toBe(true);
  });

  it('needs a session of its own', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/account/sessions/revoke',
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('the display name', () => {
  it('changes what the interface calls you', async () => {
    const response = await server.inject({
      method: 'PUT',
      url: '/api/v1/account/profile',
      headers: { cookie },
      payload: { displayName: 'Julian' },
    });

    expect(response.statusCode).toBe(200);
    expect(S.MeResponse.parse(response.json()).user.displayName).toBe('Julian');
  });

  it('leaves the account id alone', async () => {
    // The id is the vault's directory name and the key every share, session and
    // API key hangs off. Renaming that is a migration; this is a label.
    await server.inject({
      method: 'PUT',
      url: '/api/v1/account/profile',
      headers: { cookie },
      payload: { displayName: 'Julian' },
    });

    const me = await server.inject({ url: '/api/v1/auth/me', headers: { cookie } });
    expect(S.MeResponse.parse(me.json()).user.id).toBe('julian');

    // And signing in still uses the id, not the new label.
    const wrong = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { user: 'Julian', password: PASSWORD },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('refuses an empty name', async () => {
    const response = await server.inject({
      method: 'PUT',
      url: '/api/v1/account/profile',
      headers: { cookie },
      payload: { displayName: '   ' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses control characters, which would break the layout it appears in', async () => {
    const response = await server.inject({
      method: 'PUT',
      url: '/api/v1/account/profile',
      headers: { cookie },
      payload: { displayName: `Julian` },
    });

    expect(response.statusCode).toBe(400);
  });

  it('changes nobody else', async () => {
    await runtime.users.create('ramona', 'ihr gutes passwort');
    await server.inject({
      method: 'PUT',
      url: '/api/v1/account/profile',
      headers: { cookie },
      payload: { displayName: 'Julian' },
    });

    expect(runtime.users.get('ramona')?.displayName).toBe('ramona');
  });
});
