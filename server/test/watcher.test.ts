import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Database } from '../src/db/database.js';
import { migrate } from '../src/db/schema.js';
import { Indexer } from '../src/index/indexer.js';
import { Queries } from '../src/index/queries.js';
import { VaultWatcher } from '../src/index/watcher.js';
import { NoteService } from '../src/notes/service.js';
import { Vault } from '../src/vault/fs.js';

// Vitest's 5s default is tight for `waitUntil` below: this machine runs
// several agents' test suites at once, and a couple of tests wait twice in
// sequence (write, assert, delete, assert). Raised only for this file.
vi.setConfig({ testTimeout: 20_000 });

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

/**
 * Waits until `check()` reports the state a test actually cares about, not
 * until the watcher happens to have emitted some number of batches.
 *
 * A batch count is the wrong thing to wait on: a burst of external writes can
 * land in several batches instead of one, and under system load the first
 * batch can simply take a while to arrive — either way, "one batch happened"
 * says nothing about whether the change under test has reached the index yet.
 * So this polls the real outcome, forcing whatever chokidar has queued so far
 * to flush on every attempt.
 *
 * After a first, generous window it falls back to `reconcile()` — the same
 * correctness backstop production leans on — instead of continuing to wait on
 * the watcher alone. That is not a retry of the same flaky wait: a bare
 * chokidar watcher, no app code involved, was confirmed (via a standalone
 * script, run outside this suite) to sometimes never emit `add` for a file
 * written right after start-up — most likely the narrow window between
 * chokidar's `ready` and the native OS watch actually being armed. No amount
 * of waiting closes that window; only reconcile()'s direct filesystem walk
 * does, which is exactly the guarantee `watcher.ts` documents ("the watcher
 * provides latency, reconcile() provides correctness"). If the state still
 * doesn't hold after that, it is a real bug, not a timing fluke, and the
 * error names the state that never arrived.
 */
async function waitUntil(description: string, check: () => boolean): Promise<void> {
  const watcherDeadline = Date.now() + 4_000;
  while (Date.now() < watcherDeadline) {
    await watcher.flushNow();
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  await watcher.reconcile();
  if (check()) return;

  throw new Error(`timed out waiting for: ${description}`);
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
    await waitUntil('Extern.md indexed', () => q.countNotes('julian') === 1);

    expect(q.countNotes('julian')).toBe(1);
    expect(q.search('julian', 'einzigartiges')).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('picks up a change made outside the server', async () => {
    await notes.createNote('julian', 'A.md', 'erste fassung\n');
    await indexer.sync('julian');

    await externalWrite('julian', 'A.md', 'zweite fassung mit merkwort\n');
    await waitUntil('A.md reindexed with the new content', () => q.search('julian', 'merkwort').length === 1);

    expect(q.search('julian', 'merkwort')).toHaveLength(1);
    expect(q.search('julian', 'erste')).toHaveLength(0);
  });

  it('removes a note deleted outside the server', async () => {
    await externalWrite('julian', 'Weg.md', 'verschwindet\n');
    await waitUntil('Weg.md indexed', () => q.countNotes('julian') === 1);
    expect(q.countNotes('julian')).toBe(1);

    await externalDelete('julian', 'Weg.md');
    await waitUntil('Weg.md removed from the index', () => q.countNotes('julian') === 0);

    expect(q.countNotes('julian')).toBe(0);
  });

  it('resolves links that an externally added note satisfies', async () => {
    await notes.createNote('julian', 'A.md', 'Siehe [[Später]].\n');
    await indexer.sync('julian');
    expect(q.deadLinks('julian')).toHaveLength(1);

    await externalWrite('julian', 'Später.md', 'Jetzt da.\n');
    await waitUntil('link to Später resolved', () => q.deadLinks('julian').length === 0);

    expect(q.deadLinks('julian')).toHaveLength(0);
  });

  it('keeps each owner separate', async () => {
    await externalWrite('ramona', 'Privat.md', 'ramonas geheimnis\n');
    await waitUntil('Privat.md indexed under ramona', () => q.countNotes('ramona') === 1);

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
    await waitUntil('Ruhe.md indexed', () => q.countNotes('julian') === 1);

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
    await waitUntil('Echt.md indexed', () => q.countNotes('julian') === 1);

    expect(q.countNotes('julian')).toBe(1);
    expect(q.getNote('julian', 'julian', '.obsidian/workspace.md')).toBeUndefined();
  });

  it('ignores files that are not notes', async () => {
    await fs.writeFile(path.join(dataDir, 'vaults', 'julian', 'bild.png'), 'x', 'utf8');
    await externalWrite('julian', 'Echt.md', 'sichtbar\n');
    await waitUntil('Echt.md indexed', () => q.countNotes('julian') === 1);

    expect(q.countNotes('julian')).toBe(1);
  });

  it('ignores a directory that is not a valid vault name', async () => {
    const strange = path.join(dataDir, 'vaults', 'nicht gültig');
    await fs.mkdir(strange, { recursive: true });
    await fs.writeFile(path.join(strange, 'Note.md'), 'x', 'utf8');
    await externalWrite('julian', 'Echt.md', 'sichtbar\n');
    await waitUntil('Echt.md indexed', () => q.countNotes('julian') === 1);

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
    await waitUntil('Still.md indexed', () => q.search('julian', 'alt').length === 1);
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
    await waitUntil('A.md indexed', () => q.countNotes('julian') === 1);
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
    await waitUntil('all 25 burst notes indexed', () => q.countNotes('julian') === 25);

    expect(q.countNotes('julian')).toBe(25);
    expect(q.notesWithTag('julian', 'bulk')).toHaveLength(25);
    expect(errors).toEqual([]);
  });
});
