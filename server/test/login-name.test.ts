/**
 * The v14 migration, which took the login off the account's id.
 *
 * The id was three things at once: the primary key every share, session and
 * agent key hangs off, the vault's directory name, and the word typed at the
 * login. The first two have to be stable — one is a foreign key in a schema
 * with no `ON UPDATE CASCADE` anywhere, the other is a directory with a git
 * repository inside it — and the third is the one somebody wants to change.
 *
 * So the third moved out, and what is pinned here is that the move cost the
 * accounts that already existed nothing: everybody goes on signing in with what
 * they always signed in with, the ids are untouched, and nothing in the vault
 * or in any other table moved.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../src/db/database.js';
import { SCHEMA_VERSION, migrate } from '../src/db/schema.js';
import { UserService } from '../src/auth/users.js';
import { Vault } from '../src/vault/fs.js';

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-login-'));
  db = new Database(path.join(dir, 'index.sqlite'));
});

afterEach(async () => {
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

/** An account written the way v13 wrote one: no `login_name` at all. */
function olderAccount(id: string): void {
  db.run(
    `INSERT INTO users (id, display_name, password_hash, role, created_at, disabled_at, kind)
     VALUES (?, ?, 'x', 'user', 1, NULL, 'person')`,
    id,
    id,
  );
}

describe('the v14 migration', () => {
  it('gives every account that already existed its own id as its login', () => {
    migrate(db, 13);
    expect(db.userVersion).toBe(13);
    olderAccount('julian');
    olderAccount('ramona');

    migrate(db);
    expect(db.userVersion).toBe(SCHEMA_VERSION);

    const rows = db.all('SELECT id, login_name FROM users ORDER BY id');
    expect(rows).toEqual([
      { id: 'julian', login_name: 'julian' },
      { id: 'ramona', login_name: 'ramona' },
    ]);
  });

  /**
   * Two accounts whose logins differ only in case are one account to whoever is
   * typing, which is the same reasoning `users_id_lower` was added for in v11.
   */
  it('will not let two accounts answer to one login', () => {
    migrate(db);
    db.run(
      `INSERT INTO users (id, login_name, display_name, password_hash, role, created_at, disabled_at, kind)
       VALUES ('a', 'julian', 'A', 'x', 'user', 1, NULL, 'person')`,
    );

    expect(() =>
      db.run(
        `INSERT INTO users (id, login_name, display_name, password_hash, role, created_at, disabled_at, kind)
         VALUES ('b', 'JULIAN', 'B', 'x', 'user', 1, NULL, 'person')`,
      ),
    ).toThrow();
  });
});

/**
 * `ALTER TABLE ADD COLUMN NOT NULL` has to name a default, and the only one
 * available is the empty string — so a row written without a login would get
 * one, and the unique index would then permit exactly one such row in the whole
 * table. The second would fail with "UNIQUE constraint failed:
 * users_login_lower", which says nothing about the column somebody forgot.
 */
describe('a row written without a login', () => {
  const insert = (id: string): void =>
    db.run(
      `INSERT INTO users (id, display_name, password_hash, role, created_at, disabled_at)
       VALUES (?, ?, 'x', 'user', 1, NULL)`,
      id,
      id,
    );

  it('gets its id, so direct SQL behaves the way the service does', () => {
    migrate(db);
    insert('julian');

    expect(db.get('SELECT login_name FROM users WHERE id = ?', 'julian')?.['login_name']).toBe('julian');
  });

  it('does not take the one empty login the table would otherwise allow', () => {
    migrate(db);
    insert('julian');
    // Without the trigger this is where it fails, on an index that names
    // neither the column nor the account.
    expect(() => insert('ramona')).not.toThrow();

    expect(db.all('SELECT login_name FROM users ORDER BY id').map((row) => row['login_name'])).toEqual([
      'julian',
      'ramona',
    ]);
  });
});

describe('renaming the login', () => {
  async function service(): Promise<UserService> {
    migrate(db);
    const vault = new Vault(dir);
    const users = new UserService(db, vault);
    await users.create('ramona', 'ihr gutes passwort');
    return users;
  }

  it('writes one row and moves nothing else', async () => {
    const users = await service();
    const before = users.get('ramona');

    users.setLoginName('ramona', 'ramona-b');
    const after = users.get('ramona');

    expect(after?.loginName).toBe('ramona-b');
    // The id, which is the vault's directory and every foreign key's target.
    expect(after?.id).toBe(before?.id);
    expect(after?.displayName).toBe(before?.displayName);
    expect(after?.createdAt).toBe(before?.createdAt);
    // And the vault is where it was: nothing on disk is named after the login.
    await expect(fs.stat(path.join(dir, 'vaults', 'ramona'))).resolves.toBeDefined();
  });

  it('is what the login then accepts — along with the id it used to be', async () => {
    const users = await service();
    users.setLoginName('ramona', 'ramona-b');

    expect(await users.authenticate('ramona-b', 'ihr gutes passwort')).not.toBeNull();
    // The id was the login until v14, and the account is still that row.
    // Refusing it would take something away from everybody who never renamed.
    expect(await users.authenticate('ramona', 'ihr gutes passwort')).not.toBeNull();
    expect(await users.authenticate('ramona-b', 'falsch')).toBeNull();
  });

  /**
   * Exact, not folded. A login that resolved another case would be a second
   * name for an account nobody granted; the unique indexes are what make an
   * exact match the only match there could have been.
   */
  it('resolves no login of another case', async () => {
    const users = await service();
    users.setLoginName('ramona', 'ramona-b');

    expect(await users.authenticate('Ramona-B', 'ihr gutes passwort')).toBeNull();
    expect(await users.authenticate('RAMONA', 'ihr gutes passwort')).toBeNull();
  });

  it('refuses a login another account already answers to, by id or by login', async () => {
    const users = await service();
    await users.create('julian', 'sein gutes passwort');
    users.setLoginName('julian', 'jb');

    // Somebody else's id.
    expect(() => users.setLoginName('ramona', 'julian')).toThrow();
    // And somebody else's login.
    expect(() => users.setLoginName('ramona', 'jb')).toThrow();
    expect(users.get('ramona')?.loginName).toBe('ramona');
  });

  it('lets an account keep its own login, in another case', async () => {
    const users = await service();
    // Not a clash with itself, which a check written without the exception
    // would have made it.
    expect(() => users.setLoginName('ramona', 'Ramona')).not.toThrow();
    expect(users.get('ramona')?.loginName).toBe('Ramona');
  });

  it('refuses a login that could not be a directory name', async () => {
    const users = await service();

    for (const bad of ['../anderswo', 'mit leerzeichen', '', '.versteckt']) {
      expect(() => users.setLoginName('ramona', bad), bad).toThrow();
    }
    expect(users.get('ramona')?.loginName).toBe('ramona');
  });

  it('says so about an account that is not there', async () => {
    const users = await service();
    expect(() => users.setLoginName('niemand', 'wer')).toThrow();
  });
});
