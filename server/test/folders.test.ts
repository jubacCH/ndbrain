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
import { InvalidPathError, NotAFileError, NoteNotFoundError } from '../src/errors.js';

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
    const result = await runtime.app.renameFolder('julian', 'Homelab', 'Infrastruktur', 'julian');

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
    await runtime.app.renameFolder('julian', 'Homelab', 'Infrastruktur', 'julian');
    const dirs = await runtime.app.notes.listDirs('julian');

    expect(dirs).toContain('Infrastruktur/Leer');
    expect(dirs.filter((d) => d.startsWith('Homelab'))).toEqual([]);
  });

  it('handles a pure change of letter case', async () => {
    await runtime.app.renameFolder('julian', 'Homelab', 'homelab', 'julian');

    const paths = (await runtime.app.notes.listNotes('julian')).map((n) => n.path).sort();
    expect(paths).toContain('homelab/Proxmox.md');
    expect(paths).toContain('homelab/Netz/VLANs.md');
    // No leftovers from the temporary name the two-step move goes through.
    expect(paths.filter((p) => p.includes('.tmp'))).toEqual([]);
  });

  it('refuses to move a folder inside itself', async () => {
    await expect(
      runtime.app.renameFolder('julian', 'Homelab', 'Homelab/Unterordner', 'julian'),
    ).rejects.toThrow(InvalidPathError);
  });

  it('refuses a folder that is not there', async () => {
    await expect(runtime.app.renameFolder('julian', 'GibtEsNicht', 'Neu', 'julian')).rejects.toThrow(
      NoteNotFoundError,
    );
  });

  it('moves a folder into another folder', async () => {
    await runtime.app.createFolder('julian', 'Archiv');
    await runtime.app.renameFolder('julian', 'Homelab', 'Archiv/Homelab', 'julian');

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
      runtime.app.renameFolder('julian', '../ramona/Privat', 'Geklaut', 'julian'),
    ).rejects.toThrow(InvalidPathError);

    expect((await runtime.app.notes.listNotes('ramona')).map((n) => n.path)).toEqual([
      'Privat/Tagebuch.md',
    ]);
  });
});
