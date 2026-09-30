/**
 * Agent keys stop working by themselves.
 *
 * A key used to last until somebody remembered to revoke it, and nobody
 * remembers: on the live instance one key called `Claude Macbook` had been
 * replaced rather than revoked and was still valid months later. A credential
 * that outlives its purpose is the normal outcome, not an oversight, so the
 * lifetime has to be part of the key rather than part of somebody's diary.
 *
 * Three things are pinned here, and the first is not about expiry at all:
 *
 *  - **The keys that already exist keep working.** Rolling this out must not be
 *    an outage for the agents that are running today, so the migration gives
 *    existing rows no expiry rather than a date in the past.
 *  - **An expired key answers exactly like an unknown one.** Same status, same
 *    body, same headers, and `last_used_at` untouched. "Rejection looks like
 *    absence" is the house rule; a distinguishable "this expired on Tuesday"
 *    tells whoever found the string that they found a real key.
 *  - **Somebody hears about it first.** A key that dies overnight with no
 *    warning is the same failure as the silent history it replaced.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ApiKeyService,
  DEFAULT_LIFETIME_DAYS,
  EXPIRY_WARNING_DAYS,
} from '../src/auth/keys.js';
import { Database } from '../src/db/database.js';
import { migrate, SCHEMA_VERSION } from '../src/db/schema.js';

const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let db: Database;
let keys: ApiKeyService;

/** An account to hang keys off; `resolve` joins `users` and needs one. */
function account(id: string, disabled = false): void {
  db.run(
    `INSERT INTO users (id, display_name, password_hash, role, created_at, disabled_at, kind)
     VALUES (?, ?, 'x', 'user', 1, ?, 'person')`,
    id,
    id,
    disabled ? 1 : null,
  );
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-keyexp-'));
  db = new Database(path.join(dir, 'index.sqlite'));
  migrate(db);
  keys = new ApiKeyService(db);
  account('julian');
});

afterEach(async () => {
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('the v13 migration', () => {
  it('leaves a key that already exists with no expiry at all', async () => {
    const older = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-keyexp-old-'));
    const before = new Database(path.join(older, 'index.sqlite'));
    try {
      migrate(before, 12);
      expect(before.userVersion).toBe(12);

      before.run(
        `INSERT INTO users (id, display_name, password_hash, role, created_at, disabled_at, kind)
         VALUES ('julian', 'julian', 'x', 'user', 1, NULL, 'person')`,
      );
      before.run(
        `INSERT INTO api_keys (id, key_hash, owner, name, scope, can_write, created_at, last_used_at, revoked_at)
         VALUES ('key_alt', 'hash', 'julian', 'Claude Macbook', '', 1, 1, NULL, NULL)`,
      );

      migrate(before);
      expect(before.userVersion).toBe(SCHEMA_VERSION);

      // Not a date in the past, and not today plus a year either: a key that
      // was handed out without a deadline did not agree to one, and inventing
      // one retroactively is an outage with a start time nobody chose.
      const row = before.get('SELECT expires_at FROM api_keys WHERE id = ?', 'key_alt');
      expect(row?.['expires_at']).toBeNull();

      const service = new ApiKeyService(before);
      expect(service.get('key_alt')?.expiresAt).toBeNull();
    } finally {
      before.close();
      await fs.rm(older, { recursive: true, force: true });
    }
  });
});

describe('a new key', () => {
  it('expires a year from now when nobody says otherwise', () => {
    const now = Date.UTC(2026, 0, 15);
    const { key } = keys.create('julian', 'agent', {}, now);

    expect(key.expiresAt).toBe(now + DEFAULT_LIFETIME_DAYS * DAY);
  });

  it('takes a lifetime in days', () => {
    const now = Date.UTC(2026, 0, 15);
    const { key } = keys.create('julian', 'agent', { expiresInDays: 30 }, now);

    expect(key.expiresAt).toBe(now + 30 * DAY);
  });

  it('can be made to last, for the job that runs once a month', () => {
    // A cron key and a session key are not the same case, so the expiry is
    // choosable — but it has to be chosen, which is what `null` is here.
    const { key } = keys.create('julian', 'monatslauf', { expiresInDays: null });

    expect(key.expiresAt).toBeNull();
  });
});

describe('an expired key', () => {
  const now = Date.UTC(2026, 0, 15);

  it('stops resolving the moment it is due', () => {
    const { secret } = keys.create('julian', 'kurz', { expiresInDays: 1 }, now);

    expect(keys.resolve(secret, now + DAY - 1)?.name).toBe('kurz');
    expect(keys.resolve(secret, now + DAY)).toBeNull();
    expect(keys.resolve(secret, now + 400 * DAY)).toBeNull();
  });

  it('is not recorded as used', () => {
    const { key, secret } = keys.create('julian', 'kurz', { expiresInDays: 1 }, now);

    keys.resolve(secret, now + 2 * DAY);

    // An unknown key leaves no trace either. A `last_used_at` that moves is a
    // difference somebody holding the string could read off the admin view.
    expect(keys.get(key.id)?.lastUsedAt).toBeNull();
  });

  it('still lists, so the reason it stopped is visible', () => {
    const { key } = keys.create('julian', 'kurz', { expiresInDays: 1 }, now);

    // To its owner, who may see everything about their own keys anyway. The
    // rule is about what the *holder of a rejected secret* learns.
    expect(keys.list('julian').map((k) => k.id)).toContain(key.id);
  });

});

describe('a key with no expiry', () => {
  it('keeps working however far the clock is wound on', () => {
    const { secret } = keys.create('julian', 'monatslauf', { expiresInDays: null });

    expect(keys.resolve(secret, Date.now() + 4000 * DAY)?.name).toBe('monatslauf');
  });
});

describe('the warning before it is too late', () => {
  const now = Date.UTC(2026, 0, 15);

  it('names the keys inside the window, soonest first', () => {
    const soon = keys.create('julian', 'in-drei-tagen', { expiresInDays: 3 }, now).key;
    const later = keys.create('julian', 'in-zehn-tagen', { expiresInDays: 10 }, now).key;
    keys.create('julian', 'in-einem-jahr', {}, now);

    expect(keys.expiringSoon(now).map((k) => k.id)).toEqual([soon.id, later.id]);
  });

  it('says nothing about a key that cannot be saved or does not need saving', () => {
    const revoked = keys.create('julian', 'widerrufen', { expiresInDays: 3 }, now).key;
    keys.revoke(revoked.id);
    keys.create('julian', 'schon-abgelaufen', { expiresInDays: 1 }, now - 10 * DAY);
    keys.create('julian', 'ohne-ablauf', { expiresInDays: null }, now);

    account('ramona', true);
    keys.create('ramona', 'abgeschaltetes-konto', { expiresInDays: 3 }, now);

    // Nothing here is a warning worth reading: two are already dead, one has no
    // deadline, and the fourth belongs to an account that is switched off — its
    // keys stopped working when the account did.
    expect(keys.expiringSoon(now)).toEqual([]);
  });

  it('starts warning exactly at the horizon it promises', () => {
    const { key } = keys.create(
      'julian',
      'am-rand',
      { expiresInDays: EXPIRY_WARNING_DAYS },
      now,
    );

    expect(keys.expiringSoon(now).map((k) => k.id)).toEqual([key.id]);
    expect(keys.expiringSoon(now - DAY)).toEqual([]);
  });
});
