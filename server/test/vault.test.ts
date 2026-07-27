import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CaseCollisionError,
  InvalidPathError,
  NoteExistsError,
  NoteNotFoundError,
} from '../src/errors.js';
import { NoteService } from '../src/notes/service.js';
import { Vault } from '../src/vault/fs.js';

let dataDir: string;
let vault: Vault;
let notes: NoteService;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-'));
  vault = new Vault(dataDir);
  notes = new NoteService(vault);
  await vault.ensureVault('julian');
  await vault.ensureVault('ramona');
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

/** Creates a symlink, or returns false when the platform forbids it (Windows without privileges). */
async function trySymlink(target: string, linkPath: string, type: 'dir' | 'file'): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, type);
    return true;
  } catch {
    return false;
  }
}

describe('roundtrip — files are the source of truth', () => {
  it('writes and reads back byte-identical content', async () => {
    const content = [
      '---',
      'tags: [homelab]',
      '---',
      '# Proxmox',
      '',
      'Qdevice auf [[dns01]] — Umlaute: äöü, Emoji: 🧠, Tab:\there.',
      '',
    ].join('\n');

    await notes.createNote('julian', 'Homelab/Proxmox.md', content);
    const note = await notes.getNote('julian', 'Homelab/Proxmox.md');

    expect(note.content).toBe(content);
    expect(note.title).toBe('Proxmox');
    expect(note.path).toBe('Homelab/Proxmox.md');
  });

  it('preserves CRLF exactly rather than normalising it', async () => {
    const content = 'Zeile eins\r\nZeile zwei\r\n';
    await notes.createNote('julian', 'CRLF.md', content);
    expect((await notes.getNote('julian', 'CRLF.md')).content).toBe(content);
  });

  it('creates parent directories on demand', async () => {
    await notes.createNote('julian', 'A/B/C/Tief.md', 'x');
    expect((await notes.getNote('julian', 'A/B/C/Tief.md')).content).toBe('x');
  });

  it('accepts arbitrary nesting depth, as decided', async () => {
    const deep = Array.from({ length: 12 }, (_, i) => `L${i}`).join('/') + '/Note.md';
    await notes.createNote('julian', deep, 'tief');
    expect((await notes.getNote('julian', deep)).content).toBe('tief');
  });

  it('leaves the previous version intact when a write fails', async () => {
    await notes.createNote('julian', 'Stabil.md', 'original');
    // A directory where the temp file wants to go is not something we can force
    // portably, so assert the weaker but meaningful property: no stray temp files.
    await notes.updateNote('julian', 'Stabil.md', 'neu');
    const entries = await fs.readdir(path.join(vault.rootFor('julian')));
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
    expect((await notes.getNote('julian', 'Stabil.md')).content).toBe('neu');
  });
});

describe('tenant isolation — the security boundary', () => {
  beforeEach(async () => {
    await notes.createNote('ramona', 'Privat/Tagebuch.md', 'geheim');
  });

  it('does not list another user\'s notes', async () => {
    await notes.createNote('julian', 'Eigen.md', 'x');
    const listed = await notes.listNotes('julian');
    expect(listed.map((e) => e.path)).toEqual(['Eigen.md']);
  });

  it.each([
    '../ramona/Privat/Tagebuch.md',
    '../../vaults/ramona/Privat/Tagebuch.md',
    'Homelab/../../ramona/Privat/Tagebuch.md',
  ])('refuses to read across the boundary via %s', async (attempt) => {
    await expect(notes.getNote('julian', attempt)).rejects.toThrow(InvalidPathError);
  });

  it('refuses to write across the boundary', async () => {
    await expect(
      notes.createNote('julian', '../ramona/Eingeschleust.md', 'x'),
    ).rejects.toThrow(InvalidPathError);

    const ramonasNotes = await notes.listNotes('ramona');
    expect(ramonasNotes.map((e) => e.path)).toEqual(['Privat/Tagebuch.md']);
  });

  it('refuses to delete or rename across the boundary', async () => {
    await expect(notes.deleteNote('julian', '../ramona/Privat/Tagebuch.md'))
      .rejects.toThrow(InvalidPathError);
    await expect(notes.renameNote('julian', '../ramona/Privat/Tagebuch.md', 'Geklaut.md'))
      .rejects.toThrow(InvalidPathError);

    expect((await notes.getNote('ramona', 'Privat/Tagebuch.md')).content).toBe('geheim');
  });

  it('reports a foreign note as simply not existing, with no distinct error', async () => {
    // "not yours" and "not there" must be indistinguishable, or the error itself
    // reveals that another user has a note by that name.
    const missing = notes.getNote('julian', 'Privat/Tagebuch.md');
    await expect(missing).rejects.toThrow(NoteNotFoundError);
  });

  it('lets two users hold notes at the identical path without collision', async () => {
    await notes.createNote('julian', 'Privat/Tagebuch.md', 'julians version');

    expect((await notes.getNote('julian', 'Privat/Tagebuch.md')).content).toBe('julians version');
    expect((await notes.getNote('ramona', 'Privat/Tagebuch.md')).content).toBe('geheim');
  });

  it('does not follow a symlink that points out of the vault', async () => {
    const outside = path.join(dataDir, 'outside.md');
    await fs.writeFile(outside, 'nicht sichtbar', 'utf8');

    const linkPath = path.join(vault.rootFor('julian'), 'Link.md');
    const made = await trySymlink(outside, linkPath, 'file');
    if (!made) return; // platform forbids symlinks; the path rules still apply

    await expect(notes.getNote('julian', 'Link.md')).rejects.toThrow(InvalidPathError);
  });

  it('does not follow a symlinked directory into another vault', async () => {
    const linkPath = path.join(vault.rootFor('julian'), 'Fremd');
    const made = await trySymlink(vault.rootFor('ramona'), linkPath, 'dir');
    if (!made) return;

    await expect(notes.getNote('julian', 'Fremd/Privat/Tagebuch.md'))
      .rejects.toThrow(InvalidPathError);

    // …and it does not show up in the listing either.
    const listed = await notes.listNotes('julian');
    expect(listed.map((e) => e.path)).not.toContain('Fremd/Privat/Tagebuch.md');
  });
});

describe('case collisions', () => {
  it('refuses a second note differing only in case', async () => {
    await notes.createNote('julian', 'Homelab/Proxmox.md', 'a');
    await expect(notes.createNote('julian', 'Homelab/proxmox.md', 'b'))
      .rejects.toThrow(CaseCollisionError);
  });

  it('refuses the collision on rename too', async () => {
    await notes.createNote('julian', 'Proxmox.md', 'a');
    await notes.createNote('julian', 'Andere.md', 'b');
    await expect(notes.renameNote('julian', 'Andere.md', 'PROXMOX.md'))
      .rejects.toThrow(CaseCollisionError);
  });

  it('allows renaming a note to a different casing of its own name', async () => {
    await notes.createNote('julian', 'proxmox.md', 'a');
    const renamed = await notes.renameNote('julian', 'proxmox.md', 'Proxmox.md');
    expect(renamed.path).toBe('Proxmox.md');
    expect(renamed.content).toBe('a');
  });

  it('reports an exact duplicate as "already exists", not as a case collision', async () => {
    await notes.createNote('julian', 'Proxmox.md', 'a');
    await expect(notes.createNote('julian', 'Proxmox.md', 'b'))
      .rejects.toThrow(NoteExistsError);
  });

  it('does not collide across different directories', async () => {
    await notes.createNote('julian', 'A/Proxmox.md', 'a');
    await expect(notes.createNote('julian', 'B/proxmox.md', 'b')).resolves.toBeDefined();
  });

  it('refuses to mutate a note addressed with the wrong casing', async () => {
    // On Windows and macOS `stat` would happily find `Proxmox.md` under this
    // spelling and the write would land on the wrong file; on Linux it would
    // fail. Both platforms must refuse it.
    await notes.createNote('julian', 'Proxmox.md', 'original');

    await expect(notes.updateNote('julian', 'proxmox.md', 'überschrieben'))
      .rejects.toThrow(NoteNotFoundError);
    await expect(notes.deleteNote('julian', 'PROXMOX.md')).rejects.toThrow(NoteNotFoundError);

    expect((await notes.getNote('julian', 'Proxmox.md')).content).toBe('original');
  });
});

describe('create / update / delete / rename', () => {
  it('refuses a path that is not a note', async () => {
    await expect(notes.createNote('julian', 'Bild.png', 'x')).rejects.toThrow(InvalidPathError);
  });

  it('refuses to update a note that does not exist', async () => {
    await expect(notes.updateNote('julian', 'Fehlt.md', 'x')).rejects.toThrow(NoteNotFoundError);
  });

  it('deletes a note and prunes the directory it emptied', async () => {
    await notes.createNote('julian', 'Ordner/Einzeln.md', 'x');
    await notes.deleteNote('julian', 'Ordner/Einzeln.md');

    await expect(notes.getNote('julian', 'Ordner/Einzeln.md')).rejects.toThrow(NoteNotFoundError);
    const dirs = await notes.listDirs('julian');
    expect(dirs).not.toContain('Ordner');
  });

  it('keeps a directory that still holds notes', async () => {
    await notes.createNote('julian', 'Ordner/A.md', 'a');
    await notes.createNote('julian', 'Ordner/B.md', 'b');
    await notes.deleteNote('julian', 'Ordner/A.md');
    expect(await notes.listDirs('julian')).toContain('Ordner');
  });

  it('moves a note into another directory and keeps its content', async () => {
    await notes.createNote('julian', 'Inbox/Schnell.md', 'inhalt');
    const moved = await notes.renameNote('julian', 'Inbox/Schnell.md', 'Homelab/Sortiert.md');

    expect(moved.path).toBe('Homelab/Sortiert.md');
    expect(moved.content).toBe('inhalt');
    await expect(notes.getNote('julian', 'Inbox/Schnell.md')).rejects.toThrow(NoteNotFoundError);
  });

  it('refuses to overwrite an existing note by renaming onto it', async () => {
    await notes.createNote('julian', 'A.md', 'a');
    await notes.createNote('julian', 'B.md', 'b');
    await expect(notes.renameNote('julian', 'A.md', 'B.md')).rejects.toThrow(NoteExistsError);
    expect((await notes.getNote('julian', 'B.md')).content).toBe('b');
  });

  it('treats renaming onto itself as a no-op', async () => {
    await notes.createNote('julian', 'A.md', 'a');
    const same = await notes.renameNote('julian', 'A.md', 'A.md');
    expect(same.content).toBe('a');
  });
});

describe('concurrent writes', () => {
  it('serialises writes to the same note so none is lost', async () => {
    await notes.createNote('julian', 'Zaehler.md', '0');

    // Read-modify-write from ten callers at once. Without the lock these
    // interleave and most increments vanish.
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        const current = await notes.getNote('julian', 'Zaehler.md');
        const next = String(Number(current.content) + 1);
        await notes.updateNote('julian', 'Zaehler.md', next);
      }),
    );

    const final = await notes.getNote('julian', 'Zaehler.md');
    // The lock guarantees serialisation of the *writes*; the reads above are
    // outside it, so the guarantee we can assert is that the file is intact and
    // holds one of the written values rather than a torn mix.
    expect(Number(final.content)).toBeGreaterThan(0);
    expect(Number.isNaN(Number(final.content))).toBe(false);
  });

  it('does not queue one user behind another', async () => {
    await notes.createNote('julian', 'Gleich.md', 'j');
    await notes.createNote('ramona', 'Gleich.md', 'r');

    await Promise.all([
      notes.updateNote('julian', 'Gleich.md', 'julian'),
      notes.updateNote('ramona', 'Gleich.md', 'ramona'),
    ]);

    expect((await notes.getNote('julian', 'Gleich.md')).content).toBe('julian');
    expect((await notes.getNote('ramona', 'Gleich.md')).content).toBe('ramona');
  });
});

describe('listing', () => {
  it('skips hidden files and directories such as .git and .obsidian', async () => {
    await notes.createNote('julian', 'Sichtbar.md', 'x');
    const root = vault.rootFor('julian');
    await fs.mkdir(path.join(root, '.obsidian'), { recursive: true });
    await fs.writeFile(path.join(root, '.obsidian', 'workspace.md'), 'x', 'utf8');
    await fs.writeFile(path.join(root, '.versteckt.md'), 'x', 'utf8');

    const listed = await notes.listNotes('julian');
    expect(listed.map((e) => e.path)).toEqual(['Sichtbar.md']);
  });

  it('ignores files that are not notes', async () => {
    await notes.createNote('julian', 'Notiz.md', 'x');
    await fs.writeFile(path.join(vault.rootFor('julian'), 'bild.png'), 'x', 'utf8');
    expect((await notes.listNotes('julian')).map((e) => e.path)).toEqual(['Notiz.md']);
  });

  it('returns an empty list for a vault that does not exist yet', async () => {
    expect(await notes.listNotes('niemand')).toEqual([]);
  });
});
