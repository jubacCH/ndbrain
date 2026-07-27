import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { SESSION_TTL_MS, SessionService, UserExistsError, UserService } from '../src/auth/users.js';
import { Database } from '../src/db/database.js';
import { migrate } from '../src/db/schema.js';
import { InvalidUserError } from '../src/errors.js';
import { Vault } from '../src/vault/fs.js';

let dataDir: string;
let db: Database;
let users: UserService;
let sessions: SessionService;
let vault: Vault;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-auth-'));
  vault = new Vault(dataDir);
  db = new Database(':memory:');
  migrate(db);
  users = new UserService(db, vault);
  sessions = new SessionService(db);
});

afterEach(async () => {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('password hashing', () => {
  it('round-trips a password', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batteru', hash)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('dasselbe passwort');
    const b = await hashPassword('dasselbe passwort');
    expect(a).not.toBe(b);
    expect(await verifyPassword('dasselbe passwort', a)).toBe(true);
    expect(await verifyPassword('dasselbe passwort', b)).toBe(true);
  });

  it('records its parameters, so they can be raised later without breaking old hashes', async () => {
    const hash = await hashPassword('irgendein passwort');
    expect(hash.startsWith('scrypt$65536$8$2$')).toBe(true);
  });

  it('handles unicode consistently regardless of how it was typed', async () => {
    // Composed and decomposed ü are different byte sequences for the same
    // password; a Mac and a PC would otherwise disagree about the login.
    const hash = await hashPassword('Müller-Passwort');
    expect(await verifyPassword('Müller-Passwort', hash)).toBe(true);
  });

  it('rejects a corrupt or foreign hash instead of throwing', async () => {
    for (const bad of ['', 'nonsense', 'scrypt$x$y$z$a$b', '$2y$10$bcryptlookalike', 'scrypt$65536$8$2$$']) {
      await expect(verifyPassword('irgendwas', bad)).resolves.toBe(false);
    }
  });

  it('refuses passwords that are too short to be worth hashing', async () => {
    await expect(hashPassword('kurz')).rejects.toThrow(/at least 8/);
    await expect(hashPassword('x'.repeat(5000))).rejects.toThrow(/implausibly long/);
  });
});

describe('accounts', () => {
  it('creates a user together with their vault directory', async () => {
    const user = await users.create('julian', 'ein gutes passwort', { role: 'admin' });

    expect(user).toMatchObject({ id: 'julian', role: 'admin', disabled: false });
    const stat = await fs.stat(vault.rootFor('julian'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('refuses an account name that would be unsafe as a directory', async () => {
    for (const bad of ['../evil', 'mit/slash', '.versteckt', 'mit space', '']) {
      await expect(users.create(bad, 'ein gutes passwort')).rejects.toThrow(InvalidUserError);
    }
  });

  it('refuses a duplicate account', async () => {
    await users.create('julian', 'ein gutes passwort');
    await expect(users.create('julian', 'anderes passwort')).rejects.toThrow(UserExistsError);
  });

  it('authenticates with the right password only', async () => {
    await users.create('julian', 'ein gutes passwort');

    expect(await users.authenticate('julian', 'ein gutes passwort')).toMatchObject({ id: 'julian' });
    expect(await users.authenticate('julian', 'falsch')).toBeNull();
  });

  it('returns null for an unknown account rather than distinguishing it', async () => {
    expect(await users.authenticate('gibtsnicht', 'irgendein passwort')).toBeNull();
  });

  it('takes a comparable amount of time for unknown and known accounts', async () => {
    // Guards the dummy-hash comparison: without it, a missing account returns
    // immediately and account names become enumerable by stopwatch.
    await users.create('julian', 'ein gutes passwort');

    const time = async (id: string): Promise<number> => {
      const start = process.hrtime.bigint();
      await users.authenticate(id, 'falsches passwort');
      return Number(process.hrtime.bigint() - start) / 1e6;
    };

    const known = await time('julian');
    const unknown = await time('gibtsnicht');

    // Generous bounds — this asserts "same order of magnitude", not a constant.
    expect(unknown).toBeGreaterThan(known / 4);
  });

  it('refuses a disabled account and ends its sessions', async () => {
    await users.create('julian', 'ein gutes passwort');
    const { token } = sessions.create('julian');

    users.setDisabled('julian', true);

    expect(await users.authenticate('julian', 'ein gutes passwort')).toBeNull();
    expect(sessions.resolve(token)).toBeNull();
  });

  it('ends every session when the password changes', async () => {
    await users.create('julian', 'ein gutes passwort');
    const { token } = sessions.create('julian');
    expect(sessions.resolve(token)).not.toBeNull();

    await users.setPassword('julian', 'ein neues passwort');

    expect(sessions.resolve(token)).toBeNull();
    expect(await users.authenticate('julian', 'ein neues passwort')).not.toBeNull();
  });
});

describe('sessions', () => {
  beforeEach(async () => {
    await users.create('julian', 'ein gutes passwort');
  });

  it('resolves a freshly issued token', () => {
    const { token } = sessions.create('julian');
    expect(sessions.resolve(token)).toMatchObject({ userId: 'julian' });
  });

  it('stores only the hash, never the token itself', () => {
    const { token } = sessions.create('julian');
    const rows = db.all<{ token_hash: string }>('SELECT token_hash FROM sessions');
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.token_hash)).not.toBe(token);
    expect(String(rows[0]?.token_hash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects an unknown, empty or expired token', () => {
    const now = Date.now();
    const { token } = sessions.create('julian', now);

    expect(sessions.resolve('')).toBeNull();
    expect(sessions.resolve('erfunden')).toBeNull();
    expect(sessions.resolve(token, now + SESSION_TTL_MS + 1)).toBeNull();
  });

  it('drops an expired session on the spot', () => {
    const now = Date.now();
    const { token } = sessions.create('julian', now);
    sessions.resolve(token, now + SESSION_TTL_MS + 1);
    expect(db.all('SELECT 1 FROM sessions')).toHaveLength(0);
  });

  it('logs out', () => {
    const { token } = sessions.create('julian');
    sessions.destroy(token);
    expect(sessions.resolve(token)).toBeNull();
  });

  it('purges expired sessions but keeps live ones', () => {
    const now = Date.now();
    sessions.create('julian', now - SESSION_TTL_MS - 1000);
    const live = sessions.create('julian', now);

    expect(sessions.purgeExpired(now)).toBe(1);
    expect(sessions.resolve(live.token, now)).not.toBeNull();
  });

  it('issues tokens that do not repeat', () => {
    const seen = new Set(Array.from({ length: 50 }, () => sessions.create('julian').token));
    expect(seen.size).toBe(50);
  });

  it('removes sessions when the account is deleted', async () => {
    const { token } = sessions.create('julian');
    db.run('DELETE FROM users WHERE id = ?', 'julian');
    expect(sessions.resolve(token)).toBeNull();
  });
});
