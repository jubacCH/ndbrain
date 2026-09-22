/**
 * `ndbrain-user reindex` — the way back from an index that is wrong.
 *
 * `Indexer.rebuild` existed with no caller at all, so the only reindex on offer
 * was "delete the index file" — which is the same file that holds the accounts,
 * the sessions, the agent keys and the shares. Nothing in there comes back from
 * the vault, so that advice costs every login and every grant to fix a cache.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runReindexCommand } from '../src/cliReindex.js';
import { loadConfig } from '../src/config.js';
import { Database } from '../src/db/database.js';
import { migrate } from '../src/db/schema.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

let dataDir: string;
let runtime: Runtime;
let out: string[];

const write = (text: string): void => {
  out.push(text);
};

const printed = (): string => out.join('');

/** Writes a file straight into the vault, the way an import or an rsync would. */
async function dropFile(owner: string, name: string, content: string): Promise<void> {
  const file = path.join(dataDir, 'vaults', owner, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-reindex-'));
  runtime = await createRuntime({ ...loadConfig(), dataDir, logLevel: 'silent', reconcileIntervalMs: 0 });
  out = [];
});

afterEach(async () => {
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('reindex', () => {
  it('rebuilds one account from its files and reports what it indexed', async () => {
    await runtime.users.create('anna', 'passwort-eins-zwei');
    await runtime.notes.createNote('anna', 'Notiz.md', '# Notiz\n');
    await runtime.notes.createNote('anna', 'Zweite.md', '# Zweite\n');

    await runReindexCommand(runtime, ['anna'], write);

    expect(printed()).toContain('anna');
    expect(printed()).toContain('2 indexed');
    expect(runtime.app.queries.countNotes('anna')).toBe(2);
  });

  it('names every file it had to skip, so the operator knows what to rename', async () => {
    await runtime.users.create('anna', 'passwort-eins-zwei');
    await runtime.notes.createNote('anna', 'Notiz.md', '# Notiz\n');
    await dropFile('anna', 'Was ist ein VLAN?.md', '# VLAN\n');

    await runReindexCommand(runtime, ['anna'], write);

    expect(printed()).toContain('1 indexed');
    expect(printed()).toContain('1 skipped');
    expect(printed()).toContain('Was ist ein VLAN?.md');
    expect(runtime.app.queries.countNotes('anna')).toBe(1);
  });

  it('does every account when none is named', async () => {
    await runtime.users.create('anna', 'passwort-eins-zwei');
    await runtime.users.create('bruno', 'passwort-eins-zwei');
    await runtime.notes.createNote('anna', 'Notiz.md', '# Notiz\n');
    await runtime.notes.createNote('bruno', 'Andere.md', '# Andere\n');

    await runReindexCommand(runtime, [], write);

    expect(printed()).toContain('anna');
    expect(printed()).toContain('bruno');
    expect(runtime.app.queries.countNotes('anna')).toBe(1);
    expect(runtime.app.queries.countNotes('bruno')).toBe(1);
  });

  it('repairs an index that disagrees with the vault', async () => {
    await runtime.users.create('anna', 'passwort-eins-zwei');
    await runtime.app.createNote('anna', 'Notiz.md', '# Notiz\n');
    // A row for a note that is not in the vault — what a lost event leaves behind.
    runtime.db.run(
      `INSERT INTO notes (owner, path, title, path_key, title_key, size, mtime_ms, hash, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'anna',
      'Geist.md',
      'Geist',
      'geist.md',
      'geist',
      0,
      0,
      'x',
      0,
    );
    expect(runtime.app.queries.countNotes('anna')).toBe(2);

    await runReindexCommand(runtime, ['anna'], write);

    expect(runtime.app.queries.countNotes('anna')).toBe(1);
  });

  it('refuses an account that does not exist rather than reporting nothing to do', async () => {
    await expect(runReindexCommand(runtime, ['niemand'], write)).rejects.toThrow('niemand');
  });

  it('leaves the accounts, keys and shares alone — they are not in the vault', async () => {
    await runtime.users.create('anna', 'passwort-eins-zwei');
    await runtime.users.create('bruno', 'passwort-eins-zwei');
    await runtime.notes.createNote('anna', 'Notiz.md', '# Notiz\n');
    const { key } = runtime.keys.create('anna', 'agent');
    runtime.shares.grant('anna', 'Notiz.md', 'bruno');

    await runReindexCommand(runtime, [], write);

    expect(runtime.users.list().map((user) => user.id).sort()).toEqual(['anna', 'bruno']);
    expect(runtime.keys.list('anna').map((entry) => entry.id)).toContain(key.id);
    expect(runtime.shares.byOwner('anna').length).toBe(1);
  });
});

describe('a database written by a newer build', () => {
  it('is refused without telling anybody to delete the accounts', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.userVersion = 9999;

    try {
      expect(() => migrate(db)).toThrow(/newer/);
      expect(() => migrate(db)).not.toThrow(/[Dd]elete the index file/);
      // The advice that actually helps, and the reason the old one did not.
      expect(() => migrate(db)).toThrow(/accounts/);
    } finally {
      db.close();
    }
  });
});
