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
  /**
   * Stopped at 14, which is what this describe is about.
   *
   * Run to the end instead and v16 would have moved every id to a random
   * identifier before the assertion — so the test would be describing two
   * migrations at once and failing on the one it does not name. `guid-migration`
   * is where the whole road is walked.
   */
  it('gives every account that already existed its own id as its login', () => {
    migrate(db, 13);
    expect(db.userVersion).toBe(13);
    olderAccount('julian');
    olderAccount('ramona');

    migrate(db, 14);
    expect(db.userVersion).toBe(14);

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

/**
 * The v15 migration: an identifier that was never anybody's name.
 *
 * `id` is readable because it is a directory name, and readable is the one
 * thing an identifier should not be — every readable name is a name somebody
 * eventually wants changed. So each account also carries one that was never
 * chosen and never means anything.
 */
describe('the account identifier', () => {
  const insert = (id: string): void =>
    db.run(
      `INSERT INTO users (id, display_name, password_hash, role, created_at, disabled_at)
       VALUES (?, ?, 'x', 'user', 1, NULL)`,
      id,
      id,
    );

  /**
   * These were written against `guid`, the column v15 added to stage the
   * identifier in. v16 moved it into `id` and dropped the column, because two
   * columns holding one value is a pair that comes to disagree — so the same
   * properties are asserted here against `id`, which is where the identifier
   * lives now. Nothing claimed has been given up; only the column name moved.
   */
  it('is different for every account that already existed', () => {
    migrate(db, 14);
    db.run(
      `INSERT INTO users (id, login_name, display_name, password_hash, role, created_at, disabled_at)
       VALUES ('julian', 'julian', 'J', 'x', 'user', 1, NULL)`,
    );
    db.run(
      `INSERT INTO users (id, login_name, display_name, password_hash, role, created_at, disabled_at)
       VALUES ('ramona', 'ramona', 'R', 'x', 'user', 1, NULL)`,
    );

    migrate(db);

    const ids = db.all('SELECT id FROM users ORDER BY login_name').map((row) => String(row['id']));
    // `randomblob` is evaluated per row and not per statement. If it were not,
    // the backfill would hand two accounts one identifier — and the unique
    // index would stop it, which is the point of asserting it here rather than
    // trusting the documentation.
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^acc_[0-9a-f]{32}$/);
    // And the names they were made with are still what they sign in with.
    expect(db.all('SELECT login_name FROM users ORDER BY login_name').map((row) => row['login_name'])).toEqual([
      'julian',
      'ramona',
    ]);
  });

  it('is drawn for an account the service makes', async () => {
    migrate(db);
    const users = new UserService(db, new Vault(dir));
    const julian = (await users.create('julian', 'sein gutes passwort')).id;
    const ramona = (await users.create('ramona', 'ihr gutes passwort')).id;

    for (const id of [julian, ramona]) expect(id).toMatch(/^acc_[0-9a-f]{32}$/);
    expect(julian).not.toBe(ramona);
  });

  it('survives a rename of everything that is readable', async () => {
    migrate(db);
    const vault = new Vault(path.join(dir));
    const users = new UserService(db, vault);
    const ramona = (await users.create('ramona', 'ihr gutes passwort')).id;

    users.setLoginName(ramona, 'ramona-b');
    users.setDisplayName(ramona, 'Ramona Bachmann');

    const after = users.byLogin('ramona-b');
    expect(after?.id).toBe(ramona);
    expect(ramona).toMatch(/^acc_[0-9a-f]{32}$/);
  });
});

describe('renaming the login', () => {
  async function service(): Promise<{ users: UserService; ramona: string }> {
    migrate(db);
    const vault = new Vault(dir);
    const users = new UserService(db, vault);
    const ramona = (await users.create('ramona', 'ihr gutes passwort')).id;
    return { users, ramona };
  }

  it('writes one row and moves nothing else', async () => {
    const { users, ramona } = await service();
    const before = users.get(ramona);

    users.setLoginName(ramona, 'ramona-b');
    const after = users.get(ramona);

    expect(after?.loginName).toBe('ramona-b');
    // The id, which is the vault's directory and every foreign key's target.
    expect(after?.id).toBe(before?.id);
    expect(after?.displayName).toBe(before?.displayName);
    expect(after?.createdAt).toBe(before?.createdAt);
    // And the vault is where it was: nothing on disk is named after the login.
    await expect(fs.stat(path.join(dir, 'vaults', ramona))).resolves.toBeDefined();
  });

  it('is what the login then accepts — along with the id it used to be', async () => {
    const { users, ramona } = await service();
    users.setLoginName(ramona, 'ramona-b');

    expect(await users.authenticate('ramona-b', 'ihr gutes passwort')).not.toBeNull();
    // The id was the login until v14, and the account is still that row.
    // Refusing it would take something away from everybody who never renamed.
    expect(await users.authenticate(ramona, 'ihr gutes passwort')).not.toBeNull();
    expect(await users.authenticate('ramona-b', 'falsch')).toBeNull();
  });

  /**
   * Exact, not folded. A login that resolved another case would be a second
   * name for an account nobody granted; the unique indexes are what make an
   * exact match the only match there could have been.
   */
  it('resolves no login of another case', async () => {
    const { users, ramona } = await service();
    users.setLoginName(ramona, 'ramona-b');

    expect(await users.authenticate('Ramona-B', 'ihr gutes passwort')).toBeNull();
    expect(await users.authenticate('RAMONA', 'ihr gutes passwort')).toBeNull();
  });

  it('refuses a login another account already answers to, by id or by login', async () => {
    const { users, ramona } = await service();
    const julian = (await users.create('julian', 'sein gutes passwort')).id;
    users.setLoginName(julian, 'jb');

    // Somebody else's id.
    expect(() => users.setLoginName(ramona, julian)).toThrow();
    // And somebody else's login.
    expect(() => users.setLoginName(ramona, 'jb')).toThrow();
    expect(users.get(ramona)?.loginName).toBe('ramona');
  });

  it('lets an account keep its own login, in another case', async () => {
    const { users, ramona } = await service();
    // Not a clash with itself, which a check written without the exception
    // would have made it.
    expect(() => users.setLoginName(ramona, 'Ramona')).not.toThrow();
    expect(users.get(ramona)?.loginName).toBe('Ramona');
  });

  it('refuses a login that could not be a directory name', async () => {
    const { users, ramona } = await service();

    for (const bad of ['../anderswo', 'mit leerzeichen', '', '.versteckt']) {
      expect(() => users.setLoginName(ramona, bad), bad).toThrow();
    }
    expect(users.get(ramona)?.loginName).toBe('ramona');
  });

  it('says so about an account that is not there', async () => {
    const { users } = await service();
    expect(() => users.setLoginName('niemand', 'wer')).toThrow();
  });
});
