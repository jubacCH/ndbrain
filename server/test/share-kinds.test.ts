/**
 * Share kinds and account kinds: the v9 migration and the one scope rule.
 *
 * A note share is a scope that matches exactly one path. Everything that asks
 * "is this path inside this scope" goes through `inScope`, so these tests pin
 * that rule once and the surface tests elsewhere check that nothing bypasses it.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { inScope } from '../src/auth/shares.js';
import { Database } from '../src/db/database.js';
import { migrate, SCHEMA_VERSION } from '../src/db/schema.js';

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-kinds-'));
  db = new Database(path.join(dir, 'index.sqlite'));
});

afterEach(async () => {
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('the v11 migration: one account per name, whatever the letter case', () => {
  const insert = (id: string): void =>
    db.run(
      `INSERT INTO users (id, display_name, password_hash, role, created_at, disabled_at)
       VALUES (?, ?, 'x', 'user', 1, NULL)`,
      id,
      id,
    );

  it('refuses a pair of spellings that cannot both have a vault directory', () => {
    migrate(db, 10);
    insert('julian');
    insert('Julian');
    insert('ramona');

    // Named, not silently skipped: the index would simply fail to be created
    // and the collision would live on with nothing said.
    expect(() => migrate(db)).toThrow(/julian \/ Julian|Julian \/ julian/);
    expect(db.userVersion).toBe(10);
  });

  it('closes the gap the application check leaves open', () => {
    migrate(db);
    expect(db.userVersion).toBe(SCHEMA_VERSION);
    insert('julian');
    expect(() => insert('JULIAN')).toThrow(/UNIQUE constraint failed/);
    insert('ramona');
    expect(db.all('SELECT id FROM users ORDER BY id').map((row) => row['id'])).toEqual([
      'julian',
      'ramona',
    ]);
  });
});

describe('the v9 migration', () => {
  it('marks existing accounts as people and derives share kinds from their prefix', () => {
    migrate(db, 8);
    expect(db.userVersion).toBe(8);

    for (const id of ['julian', 'ramona']) {
      db.run(
        `INSERT INTO users (id, display_name, password_hash, role, created_at, disabled_at)
         VALUES (?, ?, 'x', 'user', 1, NULL)`,
        id,
        id,
      );
    }
    db.run(
      `INSERT INTO shares (id, owner, prefix, grantee, can_write, created_at)
       VALUES ('shr_vault', 'julian', '', 'ramona', 0, 1),
              ('shr_folder', 'julian', 'Projekt/', 'ramona', 1, 2)`,
    );

    migrate(db);
    expect(db.userVersion).toBe(SCHEMA_VERSION);

    const users = db.all('SELECT id, kind FROM users ORDER BY id').map((row) => ({ ...row }));
    expect(users).toEqual([
      { id: 'julian', kind: 'person' },
      { id: 'ramona', kind: 'person' },
    ]);

    const shares = db
      .all('SELECT id, kind, prefix, can_write FROM shares ORDER BY id')
      .map((row) => ({ ...row }));
    expect(shares).toEqual([
      { id: 'shr_folder', kind: 'folder', prefix: 'Projekt/', can_write: 1 },
      { id: 'shr_vault', kind: 'vault', prefix: '', can_write: 0 },
    ]);
  });

  it('refuses a kind the model does not know', () => {
    migrate(db);
    db.run(
      `INSERT INTO users (id, display_name, password_hash, role, created_at, disabled_at)
       VALUES ('julian', 'julian', 'x', 'user', 1, NULL)`,
    );
    expect(() =>
      db.run(
        `INSERT INTO users (id, display_name, password_hash, role, created_at, disabled_at, kind)
         VALUES ('robot', 'robot', 'x', 'user', 1, NULL, 'robot')`,
      ),
    ).toThrow();
    expect(() =>
      db.run(
        `INSERT INTO shares (id, owner, prefix, grantee, can_write, created_at, kind)
         VALUES ('s', 'julian', 'a.md', 'julian', 0, 1, 'file')`,
      ),
    ).toThrow();
  });
});

describe('inScope', () => {
  const note = { prefix: 'Projekt/Plan.md', exact: true };
  const folder = { prefix: 'Projekt/', exact: false };
  const vault = { prefix: '', exact: false };

  it('matches a note scope on the exact path and nothing else', () => {
    expect(inScope(note, 'Projekt/Plan.md')).toBe(true);
    for (const neighbour of [
      'Projekt/Plan.md.bak',
      'Projekt/Plan2.md',
      'Projekt/Plan.md/x',
      'Projekt/Plan.md/x.md',
      'projekt/plan.md',
      'Projekt/Plan',
      'Projekt/',
      '',
    ]) {
      expect(inScope(note, neighbour), neighbour).toBe(false);
    }
  });

  it('keeps folder and vault scopes as they were', () => {
    expect(inScope(folder, 'Projekt/Plan.md')).toBe(true);
    expect(inScope(folder, 'Projekt2/Plan.md')).toBe(false);
    expect(inScope(vault, 'irgendwo/was.md')).toBe(true);
  });

  it('never lets an empty exact scope mean the whole vault', () => {
    expect(inScope({ prefix: '', exact: true }, 'Projekt/Plan.md')).toBe(false);
  });
});
