/**
 * "Empty folder": the finding that used to be a deletion.
 *
 * Deleting or moving the last note out of a folder used to remove the folder,
 * and every folder above it that was left empty by it. That destroyed prepared
 * structure — nothing on disk tells a folder somebody laid out from one that
 * only ever held the note which has just left — so the vault now says what
 * stands out and leaves the decision where it belongs. This is that finding:
 * the same shape as orphaned notes, broken links and conflict copies, read off
 * the filesystem because an empty folder has no note for the index to hold.
 *
 * Most of what is checked below is what it must *not* report. A finding that
 * offers a delete button which then fails is worse than no finding, so the
 * answer is exactly the set of folders `removeDirIfEmpty` can actually remove
 * — hidden leftovers like a `.DS_Store` an rsync brought along included, which
 * `rmdir` refuses as surely as it refuses a note.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Vault } from '../src/vault/fs.js';
import { startHarness, type Harness } from './support/harness.js';

let dataDir: string;
let vault: Vault;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-empty-'));
  vault = new Vault(dataDir);
  await vault.ensureVault('julian');
  await vault.ensureVault('ramona');
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

/** Creates a directory the way anything outside ndBrain would. */
const mkdir = (owner: string, dir: string): Promise<string | undefined> =>
  fs.mkdir(path.join(dataDir, 'vaults', owner, dir), { recursive: true });

describe('which folders are reported', () => {
  it('reports one with nothing in it', async () => {
    await vault.createDir('julian', 'Projekte');

    expect(await vault.listEmptyDirs('julian')).toEqual(['Projekte']);
  });

  it('says nothing about a folder holding a note, or one holding an attachment', async () => {
    await vault.writeNote('julian', 'Homelab/Proxmox.md', '# Proxmox\n');
    await vault.writeFileBytes('julian', 'Bilder/rack.png', Buffer.from([0x89, 0x50]));

    expect(await vault.listEmptyDirs('julian')).toEqual([]);
  });

  /**
   * An empty vault is a new vault, not an untidy one. The root is also the one
   * directory nothing here may offer to remove.
   */
  it('says nothing about the vault root of an empty vault', async () => {
    expect(await vault.listEmptyDirs('julian')).toEqual([]);
  });

  /**
   * A prepared chain surfaces a folder at a time, deepest first, because that
   * is the shape of the removal it leads to: `rmdir` refuses a folder with a
   * subfolder in it, so reporting `Projekte` while `Q1` is inside it would be a
   * finding whose action cannot work.
   */
  it('reports the deepest of a prepared chain, then the next one up', async () => {
    await vault.createDir('julian', 'Projekte/2026/Q1');

    expect(await vault.listEmptyDirs('julian')).toEqual(['Projekte/2026/Q1']);

    expect(await vault.removeDirIfEmpty('julian', 'Projekte/2026/Q1')).toBe(true);
    expect(await vault.listEmptyDirs('julian')).toEqual(['Projekte/2026']);
  });

  it('reports every empty folder of a wide tree, sorted', async () => {
    await vault.createDir('julian', 'B/Leer');
    await vault.createDir('julian', 'A');
    await vault.writeNote('julian', 'B/Notiz.md', 'x');

    expect(await vault.listEmptyDirs('julian')).toEqual(['A', 'B/Leer']);
  });

  /**
   * The promise that keeps the finding honest: everything it names can be
   * removed. A folder holding only a hidden file looks empty in every listing
   * ndBrain shows — they all skip dotfiles — and `rmdir` would still refuse it,
   * so this one listing counts hidden entries as content.
   */
  it('says nothing about a folder holding only a hidden file, which rmdir refuses too', async () => {
    await mkdir('julian', 'Vom Mac');
    await fs.writeFile(path.join(dataDir, 'vaults', 'julian', 'Vom Mac', '.DS_Store'), 'x');

    expect(await vault.listEmptyDirs('julian')).toEqual([]);
    expect(await vault.removeDirIfEmpty('julian', 'Vom Mac')).toBe(false);
  });

  it('names only folders that can really be removed', async () => {
    await vault.createDir('julian', 'A/B');
    await vault.createDir('julian', 'C');
    await vault.writeNote('julian', 'D/Notiz.md', 'x');

    const reported = await vault.listEmptyDirs('julian');
    for (const dir of reported) {
      expect({ dir, removed: await vault.removeDirIfEmpty('julian', dir) }).toEqual({
        dir,
        removed: true,
      });
    }
  });

  it('keeps the two vaults apart', async () => {
    await vault.createDir('ramona', 'Privat');

    expect(await vault.listEmptyDirs('julian')).toEqual([]);
    expect(await vault.listEmptyDirs('ramona')).toEqual(['Privat']);
  });
});

describe('the finding in the tidy view', () => {
  let h: Harness;

  let julian: string;
  let ramona: string;

  beforeEach(async () => {
    h = await startHarness('tidy-empty');
    julian = (await h.runtime.users.create('julian', 'ein gutes passwort')).id;
    ramona = (await h.runtime.users.create('ramona', 'ihr gutes passwort')).id;
    await h.login('julian', 'ein gutes passwort');
  });

  afterEach(async () => {
    await h.close();
  });

  it('is carried by /api/v1/tidy, with its real total', async () => {
    await h.runtime.app.createFolder(julian, 'Projekte');

    const reply = await h.as('julian', { url: '/api/v1/tidy' });
    expect(reply.status).toBe(200);
    expect(reply.body.emptyFolders).toEqual(['Projekte']);
    expect(reply.body.totals.emptyFolders).toBe(1);
  });

  it('goes away once the folder is deleted, which is the action offered for it', async () => {
    await h.runtime.app.createFolder(julian, 'Projekte');

    const deleted = await h.as('julian', { method: 'DELETE', url: '/api/v1/folders/Projekte' });
    expect(deleted.status).toBe(204);

    const reply = await h.as('julian', { url: '/api/v1/tidy' });
    expect(reply.body.emptyFolders).toEqual([]);
    expect(reply.body.totals.emptyFolders).toBe(0);
  });

  it('appears when the last note leaves the folder, instead of the folder disappearing', async () => {
    await h.runtime.app.createNote(julian, 'Inbox/Schnell.md', 'x', julian);
    await h.runtime.app.deleteNote(julian, 'Inbox/Schnell.md', julian);

    const reply = await h.as('julian', { url: '/api/v1/tidy' });
    expect(reply.body.emptyFolders).toEqual(['Inbox']);
  });

  /**
   * The same rule the other findings follow: "untidy" is a verdict on how
   * somebody keeps their own notes, and a guest is not offered a list of
   * folders to delete in a vault that is not theirs.
   */
  it('is the caller’s own vault only, even under a share that may write', async () => {
    await h.runtime.app.createFolder(julian, 'Projekt');
    await h.runtime.app.createFolder(julian, 'Projekt/Leer');
    await h.runtime.app.grantShare(julian, ramona, { kind: 'folder', path: 'Projekt' }, true);

    await h.login('ramona', 'ihr gutes passwort');
    const reply = await h.as('ramona', { url: '/api/v1/tidy' });
    expect(reply.status).toBe(200);
    expect(reply.body.emptyFolders).toEqual([]);
  });
});
