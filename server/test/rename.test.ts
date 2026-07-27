import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../src/app.js';
import { Database } from '../src/db/database.js';
import { migrate } from '../src/db/schema.js';
import { Indexer } from '../src/index/indexer.js';
import { NoteExistsError } from '../src/errors.js';
import { NoteService } from '../src/notes/service.js';
import { Vault } from '../src/vault/fs.js';

let dataDir: string;
let db: Database;
let notes: NoteService;
let app: App;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-rename-'));
  const vault = new Vault(dataDir);
  notes = new NoteService(vault);
  await vault.ensureVault('julian');
  await vault.ensureVault('ramona');

  db = new Database(':memory:');
  migrate(db);
  app = new App(db, notes, new Indexer(db, notes));
});

afterEach(async () => {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function read(owner: string, notePath: string): Promise<string> {
  return (await notes.getNote(owner, notePath)).content;
}

describe('rename rewrites the links that pointed at the note', () => {
  it('follows a plain title link', async () => {
    await app.createNote('julian', 'Proxmox.md', '# Proxmox\n');
    await app.createNote('julian', 'Homelab.md', 'Siehe [[Proxmox]] für Details.\n');

    const result = await app.renameNote('julian', 'Proxmox.md', 'Proxmox Cluster.md');

    expect(result.updatedLinks).toEqual(['Homelab.md']);
    expect(await read('julian', 'Homelab.md')).toBe('Siehe [[Proxmox Cluster]] für Details.\n');
  });

  it('keeps alias and heading intact', async () => {
    await app.createNote('julian', 'Proxmox.md', '# P\n');
    await app.createNote('julian', 'A.md', '[[Proxmox#Storage|dort nachlesen]]\n');

    await app.renameNote('julian', 'Proxmox.md', 'Cluster.md');

    expect(await read('julian', 'A.md')).toBe('[[Cluster#Storage|dort nachlesen]]\n');
  });

  it('writes the link back in the style the author used', async () => {
    await app.createNote('julian', 'Homelab/Proxmox.md', '# P\n');
    await app.createNote(
      'julian',
      'A.md',
      'Titel [[Proxmox]], Pfad [[Homelab/Proxmox]], mit Endung [[Homelab/Proxmox.md]].\n',
    );

    await app.renameNote('julian', 'Homelab/Proxmox.md', 'Homelab/Cluster.md');

    // Somebody who wrote a bare title keeps a bare title; somebody who wrote a
    // path keeps their path and their extension.
    expect(await read('julian', 'A.md')).toBe(
      'Titel [[Cluster]], Pfad [[Homelab/Cluster]], mit Endung [[Homelab/Cluster.md]].\n',
    );
  });

  it('updates several links in one note and several notes at once', async () => {
    await app.createNote('julian', 'Ziel.md', '# Z\n');
    await app.createNote('julian', 'A.md', 'Einmal [[Ziel]] und nochmal [[Ziel|anders]].\n');
    await app.createNote('julian', 'B.md', 'Auch hier: [[Ziel]].\n');

    const result = await app.renameNote('julian', 'Ziel.md', 'Neues Ziel.md');

    expect(result.updatedLinks.sort()).toEqual(['A.md', 'B.md']);
    expect(await read('julian', 'A.md')).toBe(
      'Einmal [[Neues Ziel]] und nochmal [[Neues Ziel|anders]].\n',
    );
    expect(await read('julian', 'B.md')).toBe('Auch hier: [[Neues Ziel]].\n');
  });

  it('does not touch text inside code blocks', async () => {
    await app.createNote('julian', 'Ziel.md', '# Z\n');
    await app.createNote(
      'julian',
      'A.md',
      'Echt: [[Ziel]]\n\n```md\nBeispiel: [[Ziel]]\n```\n\nInline `[[Ziel]]` auch nicht.\n',
    );

    await app.renameNote('julian', 'Ziel.md', 'Anders.md');

    const content = await read('julian', 'A.md');
    expect(content).toContain('Echt: [[Anders]]');
    expect(content).toContain('Beispiel: [[Ziel]]'); // the code sample is left alone
    expect(content).toContain('Inline `[[Ziel]]`');
  });

  it('does not touch links that point somewhere else', async () => {
    await app.createNote('julian', 'Ziel.md', '# Z\n');
    await app.createNote('julian', 'Anderes.md', '# A\n');
    await app.createNote('julian', 'A.md', '[[Ziel]] und [[Anderes]]\n');

    await app.renameNote('julian', 'Ziel.md', 'Neu.md');

    expect(await read('julian', 'A.md')).toBe('[[Neu]] und [[Anderes]]\n');
  });

  it('handles a note that links to itself', async () => {
    await app.createNote('julian', 'Selbst.md', 'Ich verweise auf [[Selbst]].\n');

    await app.renameNote('julian', 'Selbst.md', 'Ich.md');

    expect(await read('julian', 'Ich.md')).toBe('Ich verweise auf [[Ich]].\n');
  });

  it('moves a note into another folder and keeps the links working', async () => {
    await app.createNote('julian', 'Inbox/Schnell.md', '# S\n');
    await app.createNote('julian', 'A.md', 'Siehe [[Schnell]].\n');

    await app.renameNote('julian', 'Inbox/Schnell.md', 'Homelab/Sortiert.md');

    expect(await read('julian', 'A.md')).toBe('Siehe [[Sortiert]].\n');
    expect(app.queries.backlinks('julian', 'Homelab/Sortiert.md').map((l) => l.source)).toEqual([
      'A.md',
    ]);
    expect(app.queries.deadLinks('julian')).toHaveLength(0);
  });

  it('leaves the index consistent afterwards', async () => {
    await app.createNote('julian', 'Ziel.md', '# Z\n');
    await app.createNote('julian', 'A.md', '[[Ziel]]\n');

    await app.renameNote('julian', 'Ziel.md', 'Neu.md');

    expect(app.queries.getNote('julian', 'Ziel.md')).toBeUndefined();
    expect(app.queries.getNote('julian', 'Neu.md')).toBeDefined();
    expect(app.queries.search('julian', 'Ziel')).toHaveLength(0);
  });

  it('refuses to overwrite an existing note and changes nothing', async () => {
    await app.createNote('julian', 'A.md', 'a');
    await app.createNote('julian', 'B.md', 'b');
    await app.createNote('julian', 'Verweis.md', 'Siehe [[A]].\n');

    await expect(app.renameNote('julian', 'A.md', 'B.md')).rejects.toThrow(NoteExistsError);

    expect(await read('julian', 'B.md')).toBe('b');
    expect(await read('julian', 'A.md')).toBe('a');
  });

  it('never rewrites another user\'s notes', async () => {
    await app.createNote('julian', 'Ziel.md', '# Z\n');
    await app.createNote('ramona', 'Ziel.md', '# Ramonas Z\n');
    await app.createNote('ramona', 'Ihre Notiz.md', 'Siehe [[Ziel]].\n');

    await app.renameNote('julian', 'Ziel.md', 'Neu.md');

    // Ramona's link still points at her own note, untouched.
    expect(await read('ramona', 'Ihre Notiz.md')).toBe('Siehe [[Ziel]].\n');
    expect(app.queries.outgoingLinks('ramona', 'Ihre Notiz.md')[0]?.targetPath).toBe('Ziel.md');
  });
});
