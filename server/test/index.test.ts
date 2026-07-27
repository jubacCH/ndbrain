import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../src/db/database.js';
import { migrate } from '../src/db/schema.js';
import { Indexer } from '../src/index/indexer.js';
import { Queries, toMatchQuery } from '../src/index/queries.js';
import { NoteService } from '../src/notes/service.js';
import { Vault } from '../src/vault/fs.js';

let dataDir: string;
let db: Database;
let notes: NoteService;
let indexer: Indexer;
let q: Queries;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-idx-'));
  const vault = new Vault(dataDir);
  notes = new NoteService(vault);
  await vault.ensureVault('julian');
  await vault.ensureVault('ramona');

  db = new Database(':memory:');
  migrate(db);
  indexer = new Indexer(db, notes);
  q = new Queries(db);
});

afterEach(async () => {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function seedJulian(): Promise<void> {
  await notes.createNote(
    'julian',
    'Homelab/Proxmox.md',
    '---\ntags: [homelab, proxmox]\n---\n# Proxmox\n\nQdevice auf [[dns01]], Storage in [[LXC Storage]].\n\n- [ ] RAM prüfen\n- [x] Quorum ok\n',
  );
  await notes.createNote(
    'julian',
    'Homelab/LXC Storage.md',
    '# LXC Storage\n\nZurück zu [[Proxmox]]. #homelab\n',
  );
  await notes.createNote('julian', 'Journal/2026-07-27.md', 'Ohne Tags, ohne Links.\n');
}

/** A stable snapshot of everything the index holds, for comparing rebuilds. */
function dump(owner: string): unknown {
  return {
    notes: db.all('SELECT path, title, size, hash FROM notes WHERE owner = ? ORDER BY path', owner),
    tags: db.all('SELECT path, key FROM tags WHERE owner = ? ORDER BY path, key', owner),
    links: db.all(
      'SELECT source, target_raw, target_path FROM links WHERE owner = ? ORDER BY source, offset',
      owner,
    ),
    tasks: db.all('SELECT path, line, done, text FROM tasks WHERE owner = ? ORDER BY path, line', owner),
  };
}

describe('the index is a cache — losing it costs nothing', () => {
  it('produces the identical state when rebuilt from scratch', async () => {
    await seedJulian();
    await indexer.rebuild('julian');
    const first = dump('julian');

    await indexer.rebuild('julian');
    expect(dump('julian')).toEqual(first);
  });

  it('reproduces the same state in a brand-new database file', async () => {
    await seedJulian();
    await indexer.rebuild('julian');
    const before = dump('julian');

    // Simulate "somebody deleted the index" — the promise is that this is
    // recoverable without touching the vault.
    db.close();
    db = new Database(':memory:');
    migrate(db);
    indexer = new Indexer(db, notes);
    q = new Queries(db);
    await indexer.rebuild('julian');

    expect(dump('julian')).toEqual(before);
  });

  it('applies migrations from empty and is safe to run twice', () => {
    const fresh = new Database(':memory:');
    migrate(fresh);
    const version = fresh.userVersion;
    migrate(fresh);
    expect(fresh.userVersion).toBe(version);
    expect(version).toBeGreaterThan(0);
    fresh.close();
  });
});

describe('sync', () => {
  it('adds, updates and removes only what changed', async () => {
    await seedJulian();
    expect(await indexer.sync('julian')).toMatchObject({ added: 3 });
    expect(await indexer.sync('julian')).toMatchObject({ added: 0, updated: 0, unchanged: 3 });

    await notes.updateNote('julian', 'Journal/2026-07-27.md', 'Geändert.\n');
    expect(await indexer.sync('julian')).toMatchObject({ updated: 1, unchanged: 2 });

    await notes.deleteNote('julian', 'Journal/2026-07-27.md');
    expect(await indexer.sync('julian')).toMatchObject({ removed: 1, unchanged: 2 });
    expect(q.countNotes('julian')).toBe(2);
  });

  it('notices a change even when the timestamp went backwards', async () => {
    await notes.createNote('julian', 'A.md', 'original');
    await indexer.sync('julian');

    await notes.updateNote('julian', 'A.md', 'restauriert aus einem Backup');
    // A restore, a git checkout or an rsync can leave an older mtime behind.
    const file = path.join(dataDir, 'vaults', 'julian', 'A.md');
    const past = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    await fs.utimes(file, past, past);

    expect(await indexer.sync('julian')).toMatchObject({ updated: 1 });
    expect(q.search('julian', 'restauriert')).toHaveLength(1);
  });

  it('removes a note from search when it is deleted', async () => {
    await notes.createNote('julian', 'Weg.md', 'einzigartiges stichwort\n');
    await indexer.sync('julian');
    expect(q.search('julian', 'einzigartiges')).toHaveLength(1);

    await notes.deleteNote('julian', 'Weg.md');
    await indexer.sync('julian');
    expect(q.search('julian', 'einzigartiges')).toHaveLength(0);
  });
});

describe('link resolution', () => {
  it('resolves by title, by path and with an explicit .md', async () => {
    await notes.createNote('julian', 'Homelab/Proxmox.md', '# P\n');
    await notes.createNote(
      'julian',
      'A.md',
      'Per Titel [[Proxmox]], per Pfad [[Homelab/Proxmox]], mit Endung [[Homelab/Proxmox.md]].\n',
    );
    await indexer.rebuild('julian');

    const links = q.outgoingLinks('julian', 'A.md');
    expect(links).toHaveLength(3);
    expect(links.every((l) => l.targetPath === 'Homelab/Proxmox.md')).toBe(true);
  });

  it('keeps a link into the void unresolved, and resolves it once the note appears', async () => {
    await notes.createNote('julian', 'A.md', 'Siehe [[Qdevice Wartung]].\n');
    await indexer.rebuild('julian');

    expect(q.deadLinks('julian')).toHaveLength(1);
    expect(q.outgoingLinks('julian', 'A.md')[0]?.targetPath).toBeNull();

    await notes.createNote('julian', 'Qdevice Wartung.md', 'Da bin ich.\n');
    await indexer.sync('julian');

    expect(q.deadLinks('julian')).toHaveLength(0);
    expect(q.backlinks('julian', 'Qdevice Wartung.md').map((l) => l.source)).toEqual(['A.md']);
  });

  it('breaks the link again when the target is deleted', async () => {
    await notes.createNote('julian', 'Ziel.md', 'x');
    await notes.createNote('julian', 'A.md', '[[Ziel]]\n');
    await indexer.rebuild('julian');
    expect(q.deadLinks('julian')).toHaveLength(0);

    await notes.deleteNote('julian', 'Ziel.md');
    await indexer.sync('julian');
    expect(q.deadLinks('julian')).toHaveLength(1);
  });

  it('prefers an exact path over a title match, then the shortest path', async () => {
    await notes.createNote('julian', 'Proxmox.md', 'oben');
    await notes.createNote('julian', 'Archiv/Alt/Proxmox.md', 'tief');
    await notes.createNote('julian', 'A.md', '[[Proxmox]]\n');
    await indexer.rebuild('julian');

    expect(q.outgoingLinks('julian', 'A.md')[0]?.targetPath).toBe('Proxmox.md');
  });

  it('resolves case-insensitively', async () => {
    await notes.createNote('julian', 'Proxmox.md', 'x');
    await notes.createNote('julian', 'A.md', '[[proxmox]] und [[PROXMOX]]\n');
    await indexer.rebuild('julian');
    expect(q.outgoingLinks('julian', 'A.md').every((l) => l.targetPath === 'Proxmox.md')).toBe(true);
  });

  it('keeps heading and alias for display', async () => {
    await notes.createNote('julian', 'Proxmox.md', 'x');
    await notes.createNote('julian', 'A.md', '[[Proxmox#Storage|dort]]\n');
    await indexer.rebuild('julian');

    expect(q.outgoingLinks('julian', 'A.md')[0]).toMatchObject({
      heading: 'Storage',
      alias: 'dort',
      targetPath: 'Proxmox.md',
    });
  });
});

describe('tenant isolation in the index', () => {
  beforeEach(async () => {
    await seedJulian();
    await notes.createNote('ramona', 'Privat/Tagebuch.md', 'Ramonas geheimes stichwort\n');
    await notes.createNote('ramona', 'Proxmox.md', 'Ramona hat auch eine Proxmox-Notiz\n');
    await indexer.rebuild('julian');
    await indexer.rebuild('ramona');
  });

  it('never returns another user\'s note from search', () => {
    expect(q.search('julian', 'geheimes')).toHaveLength(0);
    expect(q.search('ramona', 'geheimes')).toHaveLength(1);
  });

  it('keeps notes with the same name apart', () => {
    expect(q.countNotes('julian')).toBe(3);
    expect(q.countNotes('ramona')).toBe(2);
    expect(q.getNote('ramona', 'Homelab/Proxmox.md')).toBeUndefined();
  });

  it('does not leak the existence of a foreign note through a wikilink', async () => {
    // Julian links to a title only Ramona has. The link must stay dead —
    // resolving it would confirm that she owns a note by that name.
    await notes.createNote('julian', 'Neugier.md', 'Siehe [[Tagebuch]].\n');
    await indexer.sync('julian');

    const link = q.outgoingLinks('julian', 'Neugier.md')[0];
    expect(link?.targetPath).toBeNull();
    expect(q.deadLinks('julian').map((l) => l.targetRaw)).toContain('Tagebuch');
  });

  it('does not produce cross-tenant backlinks', async () => {
    await notes.createNote('ramona', 'Verweis.md', 'Siehe [[Proxmox]].\n');
    await indexer.sync('ramona');

    // Ramona's link resolves to *her* Proxmox note, not Julian's.
    expect(q.outgoingLinks('ramona', 'Verweis.md')[0]?.targetPath).toBe('Proxmox.md');
    expect(q.backlinks('julian', 'Homelab/Proxmox.md').map((l) => l.source)).toEqual([
      'Homelab/LXC Storage.md',
    ]);
  });

  it('scopes tags, tasks and hygiene findings to the owner', () => {
    expect(q.tagCounts('ramona')).toEqual([]);
    expect(q.openTasks('ramona')).toEqual([]);
    expect(q.orphans('ramona').map((n) => n.path).sort()).toEqual(['Privat/Tagebuch.md', 'Proxmox.md']);
  });
});

describe('librarian queries', () => {
  beforeEach(async () => {
    await seedJulian();
    await indexer.rebuild('julian');
  });

  it('finds notes by full text and ranks the title higher', () => {
    const hits = q.search('julian', 'Proxmox');
    expect(hits[0]?.path).toBe('Homelab/Proxmox.md');
    expect(hits[0]?.snippet.length).toBeGreaterThan(0);
  });

  it('matches a prefix while typing', () => {
    expect(q.search('julian', 'Qdev').length).toBeGreaterThan(0);
  });

  it('ignores diacritics, which matters for a German vault', async () => {
    await notes.createNote('julian', 'Kueche.md', 'Rezept für Müller-Brot\n');
    await indexer.sync('julian');
    expect(q.search('julian', 'Muller').length).toBe(1);
  });

  it('lists backlinks', () => {
    expect(q.backlinks('julian', 'Homelab/Proxmox.md').map((l) => l.source)).toEqual([
      'Homelab/LXC Storage.md',
    ]);
  });

  it('finds orphans, untagged and stale notes', async () => {
    // Proxmox is linked from LXC Storage; LXC Storage is linked from Proxmox;
    // the journal note is linked from nowhere.
    expect(q.orphans('julian').map((n) => n.path)).toEqual(['Journal/2026-07-27.md']);
    expect(q.untagged('julian').map((n) => n.path)).toEqual(['Journal/2026-07-27.md']);

    const future = Date.now() + 100 * 24 * 3600 * 1000;
    expect(q.stale('julian', 42, future)).toHaveLength(3);
    expect(q.stale('julian', 42)).toHaveLength(0);
  });

  it('lists open tasks with a file line number to jump to', () => {
    expect(q.openTasks('julian')).toEqual([
      { path: 'Homelab/Proxmox.md', line: 8, done: false, text: 'RAM prüfen' },
    ]);
  });

  it('counts tags and finds notes by tag', () => {
    expect(q.tagCounts('julian')).toEqual([
      { tag: 'homelab', count: 2 },
      { tag: 'proxmox', count: 1 },
    ]);
    expect(q.notesWithTag('julian', 'Homelab').map((n) => n.path).sort()).toEqual([
      'Homelab/LXC Storage.md',
      'Homelab/Proxmox.md',
    ]);
  });

  it('lists recently edited notes first', () => {
    expect(q.recentNotes('julian', 2)).toHaveLength(2);
  });
});

describe('search input is never trusted', () => {
  it('turns free text into a safe MATCH expression', () => {
    expect(toMatchQuery('proxmox cluster')).toBe('"proxmox" AND "cluster"*');
    expect(toMatchQuery('   ')).toBeNull();
    expect(toMatchQuery('')).toBeNull();
  });

  it.each([
    'foo AND',
    'OR OR OR',
    '"unbalanced',
    'NEAR(a b',
    'a* * *',
    '^',
    'col:value',
    '-negation',
    "'; DROP TABLE notes; --",
  ])('does not throw on hostile input %s', async (hostile) => {
    await seedJulian();
    await indexer.rebuild('julian');
    expect(() => q.search('julian', hostile)).not.toThrow();
  });

  it('still has the notes after a query that looks like SQL injection', async () => {
    await seedJulian();
    await indexer.rebuild('julian');
    q.search('julian', "'; DROP TABLE notes; --");
    expect(q.countNotes('julian')).toBe(3);
  });
});
