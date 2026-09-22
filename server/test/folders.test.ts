/**
 * Folders as first-class things.
 *
 * They used to exist only as a side effect of saving a note into one, which
 * meant you could not prepare a structure or correct one. The part that matters
 * for correctness is the rename: a folder move is the operation that relocates
 * the most links at once, so doing it as a plain directory rename would break
 * them wholesale — exactly the damage the note-level rename exists to prevent.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { InvalidPathError, NotAFileError, NoteExistsError, NoteNotFoundError } from '../src/errors.js';

/** Part of the name the two-pass case change parks a folder under; see `renameFolder`. */
const INTERIM_MARKER = '.moving-';

let dataDir: string;
let runtime: Runtime;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-dirs-'));
  runtime = await createRuntime({ ...loadConfig(), dataDir });
  await runtime.users.create('julian', 'ein gutes passwort');
});

afterEach(async () => {
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('creating a folder', () => {
  it('makes one that has no notes in it, and it survives a full rebuild', async () => {
    await runtime.app.createFolder('julian', '10_Projects/11_Active');
    expect(await runtime.app.notes.listDirs('julian')).toContain('10_Projects/11_Active');

    // The index is a cache built from notes, so an empty folder can only come
    // from the filesystem. That is the point of the check.
    await runtime.indexer.rebuild('julian');
    expect(await runtime.app.notes.listDirs('julian')).toContain('10_Projects/11_Active');
  });

  it('is idempotent and refuses a name that looks like a note', async () => {
    await runtime.app.createFolder('julian', 'Archiv');
    await expect(runtime.app.createFolder('julian', 'Archiv')).resolves.toBe('Archiv');
    await expect(runtime.app.createFolder('julian', 'Archiv.md')).rejects.toThrow(InvalidPathError);
  });
});

describe('renaming a folder', () => {
  beforeEach(async () => {
    await runtime.app.createNote('julian', 'Homelab/Proxmox.md', '# Proxmox\n\nZwei Nodes.\n');
    await runtime.app.createNote('julian', 'Homelab/Netz/VLANs.md', '# VLANs\n\nVLAN 30.\n');
    await runtime.app.createFolder('julian', 'Homelab/Leer');
    await runtime.app.createNote(
      'julian',
      'MOC.md',
      'Siehe [[Homelab/Proxmox]] und [[Homelab/Netz/VLANs|die VLANs]].\n',
    );
  });

  it('carries the notes and rewrites the links that pointed into it', async () => {
    const result = await runtime.app.renameFolder('julian', 'Homelab', 'Infrastruktur', { view: 'julian', actor: 'julian' });

    expect(result.movedNotes).toContain('Infrastruktur/Proxmox.md');
    expect(result.movedNotes).toContain('Infrastruktur/Netz/VLANs.md');

    // The whole reason this is not a directory rename.
    const moc = await runtime.app.notes.getNote('julian', 'MOC.md');
    expect(moc.content).toContain('[[Infrastruktur/Proxmox]]');
    expect(moc.content).toContain('[[Infrastruktur/Netz/VLANs|die VLANs]]');
    expect(moc.content).not.toContain('Homelab');

    const dead = runtime.app.queries.deadLinks('julian');
    expect(dead).toEqual([]);
  });

  it('takes empty subfolders with it instead of flattening the structure', async () => {
    await runtime.app.renameFolder('julian', 'Homelab', 'Infrastruktur', { view: 'julian', actor: 'julian' });
    const dirs = await runtime.app.notes.listDirs('julian');

    expect(dirs).toContain('Infrastruktur/Leer');
    expect(dirs.filter((d) => d.startsWith('Homelab'))).toEqual([]);
  });

  it('handles a pure change of letter case', async () => {
    await runtime.app.renameFolder('julian', 'Homelab', 'homelab', { view: 'julian', actor: 'julian' });

    const paths = (await runtime.app.notes.listNotes('julian')).map((n) => n.path).sort();
    expect(paths).toContain('homelab/Proxmox.md');
    expect(paths).toContain('homelab/Netz/VLANs.md');
    // No leftovers from the interim name the two-step move goes through. This
    // used to be spelled `.tmp`, which is why the check was written against
    // that suffix; see the test below for what that name cost when a pass did
    // not finish.
    expect(paths.filter((p) => p.includes(INTERIM_MARKER))).toEqual([]);
    expect(await runtime.app.notes.listDirs('julian')).toEqual(['homelab', 'homelab/Leer', 'homelab/Netz']);
  });

  it('refuses to move a folder inside itself', async () => {
    await expect(
      runtime.app.renameFolder('julian', 'Homelab', 'Homelab/Unterordner', { view: 'julian', actor: 'julian' }),
    ).rejects.toThrow(InvalidPathError);
  });

  it('refuses a folder that is not there', async () => {
    await expect(runtime.app.renameFolder('julian', 'GibtEsNicht', 'Neu', { view: 'julian', actor: 'julian' })).rejects.toThrow(
      NoteNotFoundError,
    );
  });

  /**
   * An attachment is not a note, and `listNotes` only ever reported notes — so
   * a folder move used to take the `.md` files and leave the pictures behind.
   * Two things broke at once: the old folder could not be removed because it
   * was not empty, and `![[rack.png]]` resolves against the folder the note is
   * in, so every embed pointed at a file that was no longer beside it.
   */
  it('carries the attachments beside the notes, so an embed still resolves', async () => {
    await runtime.app.writeFile('julian', 'Homelab/rack.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await runtime.app.writeFile('julian', 'Homelab/Netz/plan.pdf', Buffer.from('%PDF-1.4'));
    await runtime.app.putNote('julian', 'Homelab/Proxmox.md', '# Proxmox\n\n![[rack.png]]\n');

    const result = await runtime.app.renameFolder('julian', 'Homelab', 'Infrastruktur', {
      view: 'julian',
      actor: 'julian',
    });

    expect(result.movedFiles.sort()).toEqual(['Infrastruktur/Netz/plan.pdf', 'Infrastruktur/rack.png']);
    expect(result.failed).toEqual([]);

    const { files, dirs } = await runtime.app.listFiles('julian');
    const paths = files.map((f) => f.path);
    expect(paths).toContain('Infrastruktur/rack.png');
    expect(paths).toContain('Infrastruktur/Netz/plan.pdf');
    expect(paths.filter((p) => p.startsWith('Homelab'))).toEqual([]);
    // The old tree is gone entirely, which it could not be while an attachment
    // was still sitting in it.
    expect(dirs.filter((d) => d.startsWith('Homelab'))).toEqual([]);

    // The embed is written as a bare name and resolves against the note's own
    // folder, so "still resolves" means the file is in that folder.
    const note = await runtime.app.notes.getNote('julian', 'Infrastruktur/Proxmox.md');
    expect(note.content).toContain('![[rack.png]]');
    expect(paths).toContain('Infrastruktur/rack.png');
  });

  it('never writes an attachment over a file already standing at its target', async () => {
    await runtime.app.writeFile('julian', 'Homelab/rack.png', Buffer.from('neu'));
    await runtime.app.writeFile('julian', 'Archiv/Homelab/rack.png', Buffer.from('alt'));

    const result = await runtime.app.renameFolder('julian', 'Homelab', 'Archiv/Homelab', {
      view: 'julian',
      actor: 'julian',
    });

    expect(result.failed.map((f) => f.path)).toEqual(['Homelab/rack.png']);
    // `rename(2)` replaces the target without a word, which for an attachment
    // is a file deleted by a folder move nobody thought was destructive.
    expect((await runtime.app.readFile('julian', 'Archiv/Homelab/rack.png')).toString()).toBe('alt');
    expect((await runtime.app.readFile('julian', 'Homelab/rack.png')).toString()).toBe('neu');
  });

  /**
   * The loop used to run without a `try`, so a collision on the seventh note of
   * fifty threw out of `renameFolder` and took `movedNotes` and `updatedLinks`
   * with it. Six notes had moved, forty-four had not, and the caller was told
   * only "a note already exists at that path" — a rerun then met a half-migrated
   * tree. Carrying on and naming what did not go is the same answer the bulk
   * actions give, for the same reason: rolling back the moves that worked would
   * be worse for the person tidying up, and a rollback that fails halfway has
   * nowhere left to go.
   */
  it('keeps going past a note it cannot move and names the ones it left', async () => {
    await runtime.app.createNote('julian', 'Infrastruktur/Proxmox.md', 'schon da');

    const result = await runtime.app.renameFolder('julian', 'Homelab', 'Infrastruktur', {
      view: 'julian',
      actor: 'julian',
    });

    expect(result.movedNotes).toEqual(['Infrastruktur/Netz/VLANs.md']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.path).toBe('Homelab/Proxmox.md');
    expect(result.failed[0]?.reason).toMatch(/exist/i);

    // Neither note was lost, and neither was overwritten.
    expect((await runtime.app.notes.getNote('julian', 'Homelab/Proxmox.md')).content).toContain('Zwei Nodes');
    expect((await runtime.app.notes.getNote('julian', 'Infrastruktur/Proxmox.md')).content).toBe('schon da');
  });

  /**
   * The dangerous one. A pure case change goes through an interim directory,
   * and if the second pass does not finish, whatever is left sits under that
   * interim name with every link pointing at it. It used to be called
   * `Homelab.<stamp>.tmp`, the one shape the watcher skips while `reconcile`
   * indexes it through `listNotes` — half-visible, and nothing ever came back
   * for it. The interim name is now an ordinary one, and what is left under it
   * is reported at the path it really has.
   */
  it('says where the notes really are when a case change cannot finish', async () => {
    const real = runtime.app.renameNote.bind(runtime.app);
    runtime.app.renameNote = async (owner, from, to, options) => {
      if (to === 'homelab/Proxmox.md') throw new NoteExistsError('a note already exists at that path');
      return real(owner, from, to, options);
    };

    const result = await runtime.app.renameFolder('julian', 'Homelab', 'homelab', {
      view: 'julian',
      actor: 'julian',
    });

    expect(result.movedNotes).toEqual(['homelab/Netz/VLANs.md']);
    expect(result.failed).toHaveLength(1);

    const stranded = result.failed[0]?.path ?? '';
    expect(stranded.endsWith('/Proxmox.md')).toBe(true);
    // Named where it is, and it is really there.
    expect((await runtime.app.notes.getNote('julian', stranded)).content).toContain('Zwei Nodes');
    // And not under a name the watcher and `reconcile` disagree about.
    expect(stranded.slice(0, stranded.lastIndexOf('/')).endsWith('.tmp')).toBe(false);
  });

  it('moves a folder into another folder', async () => {
    await runtime.app.createFolder('julian', 'Archiv');
    await runtime.app.renameFolder('julian', 'Homelab', 'Archiv/Homelab', { view: 'julian', actor: 'julian' });

    const paths = (await runtime.app.notes.listNotes('julian')).map((n) => n.path);
    expect(paths).toContain('Archiv/Homelab/Proxmox.md');

    const moc = await runtime.app.notes.getNote('julian', 'MOC.md');
    expect(moc.content).toContain('[[Archiv/Homelab/Proxmox]]');
  });
});

describe('deleting a folder', () => {
  it('removes an empty one', async () => {
    await runtime.app.createFolder('julian', 'Leer');
    await runtime.app.deleteFolder('julian', 'Leer');
    expect(await runtime.app.notes.listDirs('julian')).not.toContain('Leer');
  });

  /**
   * No recursive delete. Removing a folder together with notes somebody forgot
   * were in it is the one destructive action here that the interface cannot
   * undo, and the bulk view already deletes notes deliberately, listed.
   */
  it('refuses one that still holds a note', async () => {
    await runtime.app.createNote('julian', 'Voll/Notiz.md', 'x');
    await expect(runtime.app.deleteFolder('julian', 'Voll')).rejects.toThrow(NotAFileError);
    expect((await runtime.app.notes.listNotes('julian')).map((n) => n.path)).toContain('Voll/Notiz.md');
  });
});

describe('the tenant boundary still holds', () => {
  it('does not let one user touch another vault through a folder call', async () => {
    await runtime.users.create('ramona', 'ihr gutes passwort');
    await runtime.app.createNote('ramona', 'Privat/Tagebuch.md', 'geheim');

    await expect(runtime.app.createFolder('julian', '../ramona/Privat')).rejects.toThrow(
      InvalidPathError,
    );
    await expect(
      runtime.app.renameFolder('julian', '../ramona/Privat', 'Geklaut', { view: 'julian', actor: 'julian' }),
    ).rejects.toThrow(InvalidPathError);

    expect((await runtime.app.notes.listNotes('ramona')).map((n) => n.path)).toEqual([
      'Privat/Tagebuch.md',
    ]);
  });
});
