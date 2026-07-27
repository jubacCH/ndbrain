import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../src/db/database.js';
import { migrate } from '../src/db/schema.js';
import { Indexer } from '../src/index/indexer.js';
import { Queries } from '../src/index/queries.js';
import { VaultWatcher } from '../src/index/watcher.js';
import { NoteService } from '../src/notes/service.js';
import { Vault } from '../src/vault/fs.js';

let dataDir: string;
let db: Database;
let notes: NoteService;
let indexer: Indexer;
let q: Queries;
let watcher: VaultWatcher;
let batches: number;
let errors: unknown[];

/** Writes straight to disk, bypassing the server — this is what "external edit" means. */
async function externalWrite(owner: string, notePath: string, content: string): Promise<void> {
  const file = path.join(dataDir, 'vaults', owner, notePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

async function externalDelete(owner: string, notePath: string): Promise<void> {
  await fs.rm(path.join(dataDir, 'vaults', owner, notePath), { force: true });
}

/** Waits until the watcher has produced at least one batch, then flushes the rest. */
async function settle(): Promise<void> {
  const deadline = Date.now() + 4000;
  const before = batches;
  while (batches === before && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await watcher.flushNow();
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-watch-'));
  const vault = new Vault(dataDir);
  notes = new NoteService(vault);
  await vault.ensureVault('julian');
  await vault.ensureVault('ramona');

  db = new Database(':memory:');
  migrate(db);
  indexer = new Indexer(db, notes);
  q = new Queries(db);

  batches = 0;
  errors = [];
  watcher = new VaultWatcher(dataDir, indexer, {
    debounceMs: 40,
    // Driven explicitly in the tests below; a timer would make them flaky.
    reconcileIntervalMs: 0,
    onBatch: () => {
      batches += 1;
    },
    onError: (error) => errors.push(error),
  });
  await watcher.start();
});

afterEach(async () => {
  await watcher.stop();
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('external edits reach the index', () => {
  it('indexes a note created outside the server', async () => {
    await externalWrite('julian', 'Extern.md', '# Extern\n\nEinzigartiges stichwort.\n');
    await settle();

    expect(q.countNotes('julian')).toBe(1);
    expect(q.search('julian', 'einzigartiges')).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('picks up a change made outside the server', async () => {
    await notes.createNote('julian', 'A.md', 'erste fassung\n');
    await indexer.sync('julian');

    await externalWrite('julian', 'A.md', 'zweite fassung mit merkwort\n');
    await settle();

    expect(q.search('julian', 'merkwort')).toHaveLength(1);
    expect(q.search('julian', 'erste')).toHaveLength(0);
  });

  it('removes a note deleted outside the server', async () => {
    await externalWrite('julian', 'Weg.md', 'verschwindet\n');
    await settle();
    expect(q.countNotes('julian')).toBe(1);

    await externalDelete('julian', 'Weg.md');
    await settle();

    expect(q.countNotes('julian')).toBe(0);
  });

  it('resolves links that an externally added note satisfies', async () => {
    await notes.createNote('julian', 'A.md', 'Siehe [[Später]].\n');
    await indexer.sync('julian');
    expect(q.deadLinks('julian')).toHaveLength(1);

    await externalWrite('julian', 'Später.md', 'Jetzt da.\n');
    await settle();

    expect(q.deadLinks('julian')).toHaveLength(0);
  });

  it('keeps each owner separate', async () => {
    await externalWrite('ramona', 'Privat.md', 'ramonas geheimnis\n');
    await settle();

    expect(q.search('julian', 'geheimnis')).toHaveLength(0);
    expect(q.search('ramona', 'geheimnis')).toHaveLength(1);
  });
});

describe('the server\'s own writes do not cause extra work', () => {
  it('treats an already-indexed write as a no-op', async () => {
    await notes.createNote('julian', 'Eigen.md', 'inhalt\n');
    // This is what the API will do in phase 2: write, then index immediately.
    await indexer.indexNote('julian', 'Eigen.md');
    const indexedAt = db.get<{ indexed_at: number }>(
      'SELECT indexed_at FROM notes WHERE owner = ? AND path = ?',
      'julian',
      'Eigen.md',
    );

    // The file event still arrives; it must find nothing to do.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await watcher.flushNow();

    const after = db.get<{ indexed_at: number }>(
      'SELECT indexed_at FROM notes WHERE owner = ? AND path = ?',
      'julian',
      'Eigen.md',
    );
    expect(after?.indexed_at).toBe(indexedAt?.indexed_at);
    expect(q.countNotes('julian')).toBe(1);
  });

  it('does not loop: indexing writes nothing back to the vault', async () => {
    await externalWrite('julian', 'Ruhe.md', 'inhalt\n');
    await settle();

    const first = batches;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await watcher.flushNow();

    expect(batches).toBe(first);
  });
});

describe('what the watcher ignores', () => {
  it('ignores hidden directories such as .git and .obsidian', async () => {
    const root = path.join(dataDir, 'vaults', 'julian');
    await fs.mkdir(path.join(root, '.obsidian'), { recursive: true });
    await fs.writeFile(path.join(root, '.obsidian', 'workspace.md'), 'x', 'utf8');
    await externalWrite('julian', 'Echt.md', 'sichtbar\n');
    await settle();

    expect(q.countNotes('julian')).toBe(1);
    expect(q.getNote('julian', '.obsidian/workspace.md')).toBeUndefined();
  });

  it('ignores files that are not notes', async () => {
    await fs.writeFile(path.join(dataDir, 'vaults', 'julian', 'bild.png'), 'x', 'utf8');
    await externalWrite('julian', 'Echt.md', 'sichtbar\n');
    await settle();

    expect(q.countNotes('julian')).toBe(1);
  });

  it('ignores a directory that is not a valid vault name', async () => {
    const strange = path.join(dataDir, 'vaults', 'nicht gültig');
    await fs.mkdir(strange, { recursive: true });
    await fs.writeFile(path.join(strange, 'Note.md'), 'x', 'utf8');
    await externalWrite('julian', 'Echt.md', 'sichtbar\n');
    await settle();

    expect(q.countNotes('julian')).toBe(1);
    expect(errors).toEqual([]);
  });
});

describe('reconciliation repairs what the watcher missed', () => {
  it('removes a note whose deletion produced no event at all', async () => {
    // Created and deleted inside chokidar's write-settling window: it withholds
    // the file until it stops changing, so neither `add` nor `unlink` is ever
    // announced. Meanwhile the index knows the note, because the server wrote it.
    await notes.createNote('julian', 'Kurzlebig.md', 'gleich wieder weg\n');
    await indexer.indexNote('julian', 'Kurzlebig.md');
    await externalDelete('julian', 'Kurzlebig.md');

    await watcher.flushNow();
    // Nothing to react to — the watcher genuinely never heard about it.
    expect(q.countNotes('julian')).toBe(1);

    await watcher.reconcile();
    expect(q.countNotes('julian')).toBe(0);
  });

  it('picks up a change that arrived while the process was not running', async () => {
    // Stands in for events lost to an inotify limit, a network share or a
    // restart: the file simply differs from the index and nobody told us.
    await externalWrite('julian', 'Still.md', 'alt\n');
    await settle();
    expect(q.search('julian', 'alt')).toHaveLength(1);

    await watcher.stop();
    await externalWrite('julian', 'Still.md', 'neu mit kennwort\n');
    await externalWrite('julian', 'Dazu.md', 'kam dazu\n');

    await watcher.reconcile();
    expect(q.search('julian', 'kennwort')).toHaveLength(1);
    expect(q.countNotes('julian')).toBe(2);
  });

  it('is a no-op when nothing changed', async () => {
    await externalWrite('julian', 'A.md', 'inhalt\n');
    await settle();
    const before = db.get<{ indexed_at: number }>(
      'SELECT indexed_at FROM notes WHERE owner = ? AND path = ?',
      'julian',
      'A.md',
    );

    await watcher.reconcile();

    const after = db.get<{ indexed_at: number }>(
      'SELECT indexed_at FROM notes WHERE owner = ? AND path = ?',
      'julian',
      'A.md',
    );
    expect(after?.indexed_at).toBe(before?.indexed_at);
  });

  it('reconciles every vault, not just one', async () => {
    await watcher.stop();
    await externalWrite('julian', 'J.md', 'julian\n');
    await externalWrite('ramona', 'R.md', 'ramona\n');

    await watcher.reconcile();

    expect(q.countNotes('julian')).toBe(1);
    expect(q.countNotes('ramona')).toBe(1);
  });
});

describe('bursts', () => {
  it('handles many files arriving at once, as a git pull would', async () => {
    for (let i = 0; i < 25; i += 1) {
      await externalWrite('julian', `Bulk/Note ${i}.md`, `Inhalt ${i} #bulk\n`);
    }
    await settle();
    await watcher.flushNow();

    expect(q.countNotes('julian')).toBe(25);
    expect(q.notesWithTag('julian', 'bulk')).toHaveLength(25);
    expect(errors).toEqual([]);
  });
});
