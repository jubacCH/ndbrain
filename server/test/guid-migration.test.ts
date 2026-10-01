/**
 * The v16 migration: the identifier becomes the id, and the vault's directory
 * with it.
 *
 * This is the one change in this project that moves somebody's notes. It is
 * written in two halves on purpose — the database says `acc_…` the moment the
 * migration commits, and the directory is still called `julian` until start-up
 * runs the moves — and the gap between them is exactly where an account's notes
 * would appear to have vanished. So what is pinned here is the whole of it,
 * from a database written the way the previous release wrote one, through the
 * files on disk, to a note that can still be read afterwards.
 *
 * Every test here builds the old state rather than asserting on the new one
 * alone. A migration tested only by its outcome is a migration tested against
 * the fixture somebody wrote while thinking about the outcome.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../src/db/database.js';
import { SCHEMA_VERSION, migrate } from '../src/db/schema.js';
import { runVaultMoves, writeSignposts, vaultDirectories, BY_NAME } from '../src/vault/moves.js';

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-guid-'));
  await fs.mkdir(path.join(dir, 'vaults'), { recursive: true });
  db = new Database(path.join(dir, 'index.sqlite'));
});

afterEach(async () => {
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

/** An account and a vault, written the way the release before v16 wrote them. */
async function older(id: string, note = 'Notiz.md'): Promise<void> {
  db.run(
    `INSERT INTO users (id, login_name, display_name, password_hash, role, created_at, disabled_at, kind)
     VALUES (?, ?, ?, 'x', 'user', 1, NULL, 'person')`,
    id,
    id,
    id,
  );
  await fs.mkdir(path.join(dir, 'vaults', id), { recursive: true });
  await fs.writeFile(path.join(dir, 'vaults', id, note), `# ${id}\n`);
}

/** The id of the one account, after whatever has happened to it. */
const theId = (): string => String(db.get('SELECT id FROM users')?.['id']);

describe('the database half', () => {
  it('turns the id into the identifier and carries every reference along', async () => {
    migrate(db, 15);
    await older('julian');
    const guid = String(db.get('SELECT guid FROM users')?.['guid']);

    // One row in each table that points at an account, so that a table left out
    // of the rewrite is a row still naming somebody who no longer exists.
    db.run(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
       VALUES ('t', 'julian', 1, 9, 1)`,
    );
    db.run("INSERT INTO edits (owner, path, actor, action, at) VALUES ('julian', 'Notiz.md', 'julian', 'update', 1)");
    db.run(
      `INSERT INTO api_keys (id, key_hash, owner, name, scope, can_write, created_at, last_used_at, revoked_at)
       VALUES ('key_a', 'h', 'julian', 'Claude', '', 0, 1, NULL, NULL)`,
    );
    db.run(
      `INSERT INTO shares (id, owner, prefix, grantee, can_write, created_at, kind)
       VALUES ('s1', 'julian', '', 'julian', 0, 1, 'vault')`,
    );
    db.run("INSERT INTO user_settings (user_id, key, value) VALUES ('julian', 'staleDays', '90')");

    migrate(db);
    expect(db.userVersion).toBe(SCHEMA_VERSION);

    expect(theId()).toBe(guid);
    expect(db.get('SELECT user_id FROM sessions')?.['user_id']).toBe(guid);
    expect(db.get('SELECT owner FROM edits')?.['owner']).toBe(guid);
    expect(db.get('SELECT owner FROM api_keys')?.['owner']).toBe(guid);
    // Both columns of `shares`: a grantee is an account like an owner is, and
    // rewriting one of the two leaves a grant to nobody.
    expect(db.get('SELECT owner, grantee FROM shares')).toMatchObject({ owner: guid, grantee: guid });
    expect(db.get('SELECT user_id FROM user_settings')?.['user_id']).toBe(guid);
  });

  /**
   * The staging column goes. Two columns holding one value is a pair that can
   * come to disagree, and the one somebody reads would be the stale one.
   */
  it('leaves exactly one identifier behind', async () => {
    migrate(db, 15);
    await older('julian');
    migrate(db);

    const columns = db.all('PRAGMA table_info(users)').map((row) => String(row['name']));
    expect(columns).not.toContain('guid');
    expect(columns).toContain('id');
    expect(theId()).toMatch(/^acc_[0-9a-f]{32}$/);
  });

  it('empties the index rather than translating it', async () => {
    migrate(db, 15);
    await older('julian');
    db.run(
      `INSERT INTO notes (owner, path, title, path_key, title_key, size, mtime_ms, hash, indexed_at)
       VALUES ('julian', 'Notiz.md', 'Notiz', 'notiz.md', 'notiz', 1, 1, 'h', 1)`,
    );

    migrate(db);

    // Derived from the vault, and rebuilt by the sweep at start-up. Translating
    // six tables can be subtly wrong; emptying them cannot.
    expect(db.all('SELECT owner FROM notes')).toEqual([]);
  });

  it('writes the move it is leaving for start-up', async () => {
    migrate(db, 15);
    await older('julian');
    const guid = String(db.get('SELECT guid FROM users')?.['guid']);

    migrate(db);

    expect(db.all('SELECT guid, from_name FROM vault_moves')).toEqual([{ guid, from_name: 'julian' }]);
  });
});

/**
 * Where the temporary files of a migration go.
 *
 * The container this runs in has a read-only root filesystem and a 16 MB
 * `/tmp`, and a single `UPDATE` touching many rows inside a transaction makes
 * SQLite open a statement journal — a temporary file. The live instance's
 * `access_log` holds six hundred and sixty thousand rows and that journal does
 * not fit, which arrives as `SQLITE_FULL`: "database or disk is full", with ten
 * gigabytes free.
 *
 * The constrained filesystem cannot be built here, so what is pinned is the
 * mechanism: the setting is on while the migrations run and off afterwards.
 * Its first home was inside the migration, where it did nothing — changing
 * `temp_store` does not affect temporary objects that already exist — so the
 * *place* is the thing worth a test.
 */
describe('where a migration puts its temporary files', () => {
  const tempStore = (): number => Number(db.get('PRAGMA temp_store')?.['temp_store']);

  it('is memory while they run, and the default again afterwards', () => {
    let during = -1;
    const seen = db.all.bind(db);
    // Caught from inside, by a migration that reads the setting as it goes.
    db.all = ((sql: string, ...rest: unknown[]) => {
      if (during === -1) during = tempStore();
      return seen(sql, ...(rest as []));
    }) as typeof db.all;

    migrate(db);
    db.all = seen;

    // 2 is MEMORY; 0 is the default this build does not otherwise change.
    expect(during).toBe(2);
    expect(tempStore()).toBe(0);
  });

  it('puts it back even where a migration throws', () => {
    migrate(db, 15);
    // An account, or there is nothing for v16 to rewrite and nothing to fail.
    db.run(
      `INSERT INTO users (id, login_name, display_name, password_hash, role, created_at, disabled_at, kind)
       VALUES ('julian', 'julian', 'J', 'x', 'user', 1, NULL, 'person')`,
    );
    // Taking away a table v16 rewrites is the cheapest way to make it throw
    // where it does its work, rather than before it starts.
    db.exec('DROP TABLE access_log');

    expect(() => migrate(db)).toThrow();
    expect(tempStore()).toBe(0);
  });
});

describe('the half on disk', () => {
  it('moves the directory and leaves the notes in it', async () => {
    migrate(db, 15);
    await older('julian');
    migrate(db);
    const guid = theId();

    const report = await runVaultMoves(db, dir);

    expect(report.moved).toEqual([{ from: 'julian', to: guid }]);
    expect(await vaultDirectories(dir)).toEqual([guid]);
    expect(await fs.readFile(path.join(dir, 'vaults', guid, 'Notiz.md'), 'utf8')).toBe('# julian\n');
    // And the row is gone, so the next start has nothing left to do.
    expect(db.all('SELECT guid FROM vault_moves')).toEqual([]);
  });

  /**
   * A crash between the commit and the move is the normal case to design for,
   * not an exotic one: the two halves cannot be one transaction.
   */
  it('finishes a move that was interrupted, and does nothing on a second run', async () => {
    migrate(db, 15);
    await older('julian');
    migrate(db);
    const guid = theId();

    const first = await runVaultMoves(db, dir);
    const second = await runVaultMoves(db, dir);

    expect(first.moved).toHaveLength(1);
    expect(second.moved).toEqual([]);
    expect(await vaultDirectories(dir)).toEqual([guid]);
  });

  it('treats a move that already happened as done', async () => {
    migrate(db, 15);
    await older('julian');
    migrate(db);
    const guid = theId();
    // As if the process died after the rename and before the row was deleted.
    await fs.rename(path.join(dir, 'vaults', 'julian'), path.join(dir, 'vaults', guid));

    const report = await runVaultMoves(db, dir);

    expect(report.moved).toEqual([]);
    expect(db.all('SELECT guid FROM vault_moves')).toEqual([]);
    expect(await fs.readFile(path.join(dir, 'vaults', guid, 'Notiz.md'), 'utf8')).toBe('# julian\n');
  });

  it('makes a vault for an account that never had one', async () => {
    migrate(db, 15);
    db.run(
      `INSERT INTO users (id, login_name, display_name, password_hash, role, created_at, disabled_at, kind)
       VALUES ('neu', 'neu', 'Neu', 'x', 'user', 1, NULL, 'person')`,
    );
    migrate(db);

    await runVaultMoves(db, dir);

    expect(await vaultDirectories(dir)).toEqual([theId()]);
  });

  /**
   * Two directories with notes in them. Picking one would throw the other away
   * in silence, which is the single outcome worth refusing to decide — so it is
   * reported, both are left alone, and the row stays for somebody to resolve.
   */
  it('refuses to choose when both directories exist', async () => {
    migrate(db, 15);
    await older('julian');
    migrate(db);
    const guid = theId();
    await fs.mkdir(path.join(dir, 'vaults', guid), { recursive: true });
    await fs.writeFile(path.join(dir, 'vaults', guid, 'Fremd.md'), '# fremd\n');

    const report = await runVaultMoves(db, dir);

    expect(report.conflicted).toEqual([{ from: 'julian', to: guid }]);
    expect(report.moved).toEqual([]);
    expect(await fs.readFile(path.join(dir, 'vaults', 'julian', 'Notiz.md'), 'utf8')).toBe('# julian\n');
    expect(await fs.readFile(path.join(dir, 'vaults', guid, 'Fremd.md'), 'utf8')).toBe('# fremd\n');
    // Still pending: nothing has been decided, so nothing is forgotten either.
    expect(db.all('SELECT guid FROM vault_moves')).toHaveLength(1);
  });

  it('does nothing at all on a database that has no moves to make', async () => {
    migrate(db);
    const report = await runVaultMoves(db, dir);
    expect(report).toEqual({ moved: [], conflicted: [] });
  });
});

describe('the signpost', () => {
  it('points each login at its vault', async () => {
    const accounts = [
      { id: 'acc_aaaa', loginName: 'julian' },
      { id: 'acc_bbbb', loginName: 'ramona' },
    ];
    await writeSignposts(dir, accounts);

    for (const account of accounts) {
      const link = path.join(dir, 'vaults', BY_NAME, account.loginName);
      expect(await fs.readlink(link)).toBe(path.join('..', account.id));
    }
  });

  /**
   * Thrown away and written again rather than reconciled: a link left behind
   * from a rename is worse than no link at all — it is a name that resolves to
   * somebody else's vault.
   */
  it('leaves nothing behind from a login that has changed', async () => {
    await writeSignposts(dir, [{ id: 'acc_aaaa', loginName: 'julian' }]);
    await writeSignposts(dir, [{ id: 'acc_aaaa', loginName: 'jb' }]);

    const links = await fs.readdir(path.join(dir, 'vaults', BY_NAME));
    expect(links).toEqual(['jb']);
  });

  it('is not mistaken for a vault', async () => {
    await fs.mkdir(path.join(dir, 'vaults', 'acc_aaaa'), { recursive: true });
    await writeSignposts(dir, [{ id: 'acc_aaaa', loginName: 'julian' }]);

    expect(await vaultDirectories(dir)).toEqual(['acc_aaaa']);
  });

  it('skips a name that could not be a path, rather than failing the start', async () => {
    const written = await writeSignposts(dir, [
      { id: 'acc_aaaa', loginName: 'julian' },
      { id: 'acc_bbbb', loginName: '../anderswo' },
    ]);

    expect(written).toBe(1);
    expect(await fs.readdir(path.join(dir, 'vaults', BY_NAME))).toEqual(['julian']);
  });
});
