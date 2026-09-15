/**
 * The task view's two hard parts: the folder-filtered, all-or-open list behind
 * it (`Queries.tasks`/`taskCount`), and the toggle that has to refuse a stale
 * line rather than guess (`markdown/tasks.ts`, wired up as `App.toggleTask`).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../src/app.js';
import { Database } from '../src/db/database.js';
import { migrate } from '../src/db/schema.js';
import { TaskChangedError } from '../src/errors.js';
import { Indexer } from '../src/index/indexer.js';
import { NoteService } from '../src/notes/service.js';
import { toggleTask } from '../src/markdown/tasks.js';
import { Vault } from '../src/vault/fs.js';

describe('toggleTask (pure)', () => {
  it('flips the checkbox and changes nothing else, byte for byte', () => {
    const source = '# Notes\n\n- [ ] first\n- [ ] second\n';
    expect(toggleTask(source, 3, { done: false, text: 'first' }, true)).toEqual({
      ok: true,
      content: '# Notes\n\n- [x] first\n- [ ] second\n',
    });
  });

  it('refuses when the text at that line has changed', () => {
    const source = '- [ ] first\n';
    expect(toggleTask(source, 1, { done: false, text: 'something else' }, true)).toEqual({
      ok: false,
      reason: 'changed',
    });
  });

  it('refuses when the done state at that line has changed', () => {
    const source = '- [x] first\n';
    expect(toggleTask(source, 1, { done: false, text: 'first' }, true)).toEqual({
      ok: false,
      reason: 'changed',
    });
  });

  it('refuses when the line no longer exists', () => {
    const source = '- [ ] first\n';
    expect(toggleTask(source, 40, { done: false, text: 'first' }, true)).toEqual({
      ok: false,
      reason: 'changed',
    });
  });

  it('picks the addressed line among duplicate task text, not the first match', () => {
    const source = '- [ ] testen\n- [ ] testen\n';
    expect(toggleTask(source, 2, { done: false, text: 'testen' }, true)).toEqual({
      ok: true,
      content: '- [ ] testen\n- [x] testen\n',
    });
  });

  it('counts lines file-relative, frontmatter included', () => {
    // 1 ---, 2 tags, 3 ---, 4 blank, 5 the task.
    const source = '---\ntags: [a]\n---\n\n- [ ] task\n';
    const result = toggleTask(source, 5, { done: false, text: 'task' }, true);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe('---\ntags: [a]\n---\n\n- [x] task\n');
  });

  it('is a no-op, still ok, when already in the requested state', () => {
    const source = '- [x] done already\n';
    expect(toggleTask(source, 1, { done: true, text: 'done already' }, true)).toEqual({
      ok: true,
      content: source,
    });
  });

  it('preserves CRLF line endings', () => {
    const source = '- [ ] first\r\n- [ ] second\r\n';
    expect(toggleTask(source, 1, { done: false, text: 'first' }, true)).toEqual({
      ok: true,
      content: '- [x] first\r\n- [ ] second\r\n',
    });
  });

  it('unticks as well as ticks', () => {
    const source = '- [x] first\n';
    expect(toggleTask(source, 1, { done: true, text: 'first' }, false)).toEqual({
      ok: true,
      content: '- [ ] first\n',
    });
  });
});

let dataDir: string;
let db: Database;
let notes: NoteService;
let app: App;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-tasks-'));
  const vault = new Vault(dataDir);
  notes = new NoteService(vault);
  await vault.ensureVault('julian');

  db = new Database(':memory:');
  migrate(db);
  app = new App(db, notes, new Indexer(db, notes));
});

afterEach(async () => {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function read(notePath: string): Promise<string> {
  return (await notes.getNote('julian', notePath)).content;
}

describe('Queries.tasks / taskCount', () => {
  beforeEach(async () => {
    await app.createNote('julian', 'Homelab/Proxmox.md', '- [ ] RAM prüfen\n- [x] Quorum ok\n');
    await app.createNote('julian', 'Journal/Heute.md', '- [ ] Journal schreiben\n');
  });

  it('defaults to open tasks only, ordered by note path then line', () => {
    expect(app.queries.tasks('julian').map((t) => t.text)).toEqual(['RAM prüfen', 'Journal schreiben']);
  });

  it('includes finished tasks when asked', () => {
    const texts = app.queries.tasks('julian', { includeDone: true }).map((t) => t.text);
    expect(texts.sort()).toEqual(['Journal schreiben', 'Quorum ok', 'RAM prüfen'].sort());
  });

  it('filters by folder, without matching a sibling of the same prefix', async () => {
    // The documented `substr` + trailing-slash trap: `Homelab2` must not match
    // a filter for `Homelab`.
    await app.createNote('julian', 'Homelab2/Other.md', '- [ ] should not match\n');

    expect(app.queries.tasks('julian', { dir: 'Homelab' }).map((t) => t.path)).toEqual([
      'Homelab/Proxmox.md',
    ]);
  });

  it('reports the true total separately from a capped list', async () => {
    for (let i = 0; i < 5; i += 1) {
      await app.createNote('julian', `Bulk/Task-${i}.md`, '- [ ] eins\n');
    }

    const rows = app.queries.tasks('julian', { limit: 3 });
    const total = app.queries.taskCount('julian', { limit: 3 });

    expect(rows).toHaveLength(3);
    expect(total).toBe(7); // 5 bulk + Proxmox + Journal, done task excluded
  });
});

describe('App.toggleTask', () => {
  beforeEach(async () => {
    await app.createNote(
      'julian',
      'Homelab/Proxmox.md',
      '---\ntags: [homelab]\n---\n# Proxmox\n\n- [ ] RAM prüfen\n- [ ] RAM prüfen\n',
    );
  });

  it('flips only the addressed line, leaving the rest of the file byte-identical', async () => {
    const beforeLines = (await read('Homelab/Proxmox.md')).split('\n');

    await app.toggleTask('julian', 'Homelab/Proxmox.md', 7, { done: false, text: 'RAM prüfen' }, true, 'julian');

    const afterLines = (await read('Homelab/Proxmox.md')).split('\n');
    expect(afterLines[6]).toBe('- [x] RAM prüfen');
    beforeLines[6] = afterLines[6] ?? '';
    expect(afterLines).toEqual(beforeLines);
  });

  it('toggles the second of two identical tasks, not the first', async () => {
    await app.toggleTask('julian', 'Homelab/Proxmox.md', 7, { done: false, text: 'RAM prüfen' }, true, 'julian');
    expect(await read('Homelab/Proxmox.md')).toContain('- [ ] RAM prüfen\n- [x] RAM prüfen');
  });

  it('refuses and writes nothing when the note changed since the list was loaded', async () => {
    await app.updateNote(
      'julian',
      'Homelab/Proxmox.md',
      '---\ntags: [homelab]\n---\n# Proxmox\n\n- [ ] RAM geprüft\n- [ ] RAM prüfen\n',
      'ramona',
    );
    const before = await read('Homelab/Proxmox.md');

    await expect(
      app.toggleTask('julian', 'Homelab/Proxmox.md', 6, { done: false, text: 'RAM prüfen' }, true, 'julian'),
    ).rejects.toBeInstanceOf(TaskChangedError);

    expect(await read('Homelab/Proxmox.md')).toBe(before);
  });

  it('refuses and writes nothing when the task was already ticked off by somebody else', async () => {
    await app.updateNote(
      'julian',
      'Homelab/Proxmox.md',
      '---\ntags: [homelab]\n---\n# Proxmox\n\n- [x] RAM prüfen\n- [ ] RAM prüfen\n',
      'ramona',
    );
    const before = await read('Homelab/Proxmox.md');

    await expect(
      app.toggleTask('julian', 'Homelab/Proxmox.md', 6, { done: false, text: 'RAM prüfen' }, true, 'julian'),
    ).rejects.toBeInstanceOf(TaskChangedError);

    expect(await read('Homelab/Proxmox.md')).toBe(before);
  });

  it('updates the index, so the toggled task drops out of the open list', async () => {
    await app.toggleTask('julian', 'Homelab/Proxmox.md', 6, { done: false, text: 'RAM prüfen' }, true, 'julian');
    expect(app.queries.openTasks('julian').map((t) => t.line)).toEqual([7]);
  });

  it('records the actor like any other write', async () => {
    await app.toggleTask('julian', 'Homelab/Proxmox.md', 6, { done: false, text: 'RAM prüfen' }, true, 'agent-x');
    const row = db.get<{ actor: string }>(
      "SELECT actor FROM edits WHERE path = ? AND action = 'update' ORDER BY at DESC LIMIT 1",
      'Homelab/Proxmox.md',
    );
    expect(row?.actor).toBe('agent-x');
  });

  it('writes nothing and keeps the same mtime when the task is already in the requested state', async () => {
    await app.toggleTask('julian', 'Homelab/Proxmox.md', 6, { done: false, text: 'RAM prüfen' }, true, 'julian');
    const before = await notes.getNote('julian', 'Homelab/Proxmox.md');

    const result = await app.toggleTask(
      'julian',
      'Homelab/Proxmox.md',
      6,
      { done: true, text: 'RAM prüfen' },
      true,
      'julian',
    );

    expect(result.note.mtimeMs).toBe(before.mtimeMs);
    expect(result.created).toBe(false);
  });
});
