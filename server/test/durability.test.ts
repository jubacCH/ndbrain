/**
 * What the write path promises when the machine loses power mid-save.
 *
 * **What these tests actually assure, and what they do not.** A power cut
 * cannot be staged from a test, so nothing here proves that a note survives
 * one. What is checkable is the only thing under our control: that the calls
 * which make the guarantee possible happen at all, and in the one order that
 * yields it — the file's bytes flushed *before* the rename publishes the name,
 * the directory flushed *after* it, so the new name cannot reach the platter
 * ahead of the content it points at. That ordering is the whole of the
 * classic rename-without-fsync failure, where a reboot leaves a note of zero
 * bytes: the directory entry made it, the data did not.
 *
 * Whether the drive then honours the flush is the drive's business and the
 * platform's. On Linux — where this runs in production — `fsync(2)` on ext4
 * issues a cache flush and the guarantee is real. On macOS, where these tests
 * run, `fsync(2)` hands the data to the device and does not wait for its cache
 * to be written out; only `fcntl(F_FULLFSYNC)` does, and Node exposes no way
 * to ask for it. So a green run here means "we ask correctly", never "the disk
 * obeyed" — which is exactly why these assertions are about call order and
 * carry no claim beyond it.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Vault } from '../src/vault/fs.js';

let dataDir: string;
let vault: Vault;
let log: string[];

const realOpen = fs.open;
const realRename = fs.rename;

/** The path as the log names it: vault-relative, with the random temp suffix folded away. */
function label(target: string): string {
  const root = path.join(dataDir, 'vaults', 'julian');
  const relative = path.relative(root, target).split(path.sep).join('/');
  const name = relative === '' ? '.' : relative;
  return name.replace(/\.[0-9a-f]{12}\.tmp$/, '.tmp');
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-durability-'));
  vault = new Vault(dataDir);
  await vault.ensureVault('julian');
  log = [];

  // Spied rather than mocked: every call does the real thing, and only says so
  // on the way past. A mock would test the spy.
  vi.spyOn(fs, 'open').mockImplementation(async (file, ...rest) => {
    const handle = await (realOpen as typeof fs.open)(file, ...(rest as []));
    const name = label(String(file));
    log.push(`open:${name}`);

    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      log.push(`sync:${name}`);
      await sync();
    };
    const datasync = handle.datasync.bind(handle);
    handle.datasync = async () => {
      log.push(`datasync:${name}`);
      await datasync();
    };
    return handle;
  });

  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    log.push(`rename:${label(String(from))}->${label(String(to))}`);
    await realRename(from, to);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('writing a note', () => {
  it('flushes the content before the rename and the directory after it', async () => {
    await vault.createDir('julian', 'Homelab');
    log.length = 0;

    await vault.writeNote('julian', 'Homelab/Proxmox.md', '# Proxmox\n');

    expect(log).toEqual([
      'open:Homelab/Proxmox.md.tmp',
      'sync:Homelab/Proxmox.md.tmp',
      'rename:Homelab/Proxmox.md.tmp->Homelab/Proxmox.md',
      'open:Homelab',
      'sync:Homelab',
    ]);
    expect(await vault.readNote('julian', 'Homelab/Proxmox.md')).toBe('# Proxmox\n');
  });

  it('flushes the whole file, not only its data', async () => {
    await vault.writeNote('julian', 'Notiz.md', 'x');

    // `datasync` omits the size and the timestamps, and for a file that did not
    // exist a moment ago the size *is* the content: a durable inode of length
    // zero pointing at durable bytes is the same lost note by another route.
    expect(log.filter((entry) => entry.startsWith('datasync:'))).toEqual([]);
  });

  it('flushes each directory it had to create, from the root down', async () => {
    await vault.writeNote('julian', 'Projekte/2026/Q1/Plan.md', '# Plan\n');

    // A durable entry inside a directory whose own entry never reached the disk
    // is still a lost note, so a freshly created chain is flushed link by link
    // — top down, so no child is promised before its parent exists.
    expect(log.slice(0, 6)).toEqual([
      'open:.',
      'sync:.',
      'open:Projekte',
      'sync:Projekte',
      'open:Projekte/2026',
      'sync:Projekte/2026',
    ]);
    expect(log.slice(6)).toEqual([
      'open:Projekte/2026/Q1/Plan.md.tmp',
      'sync:Projekte/2026/Q1/Plan.md.tmp',
      'rename:Projekte/2026/Q1/Plan.md.tmp->Projekte/2026/Q1/Plan.md',
      'open:Projekte/2026/Q1',
      'sync:Projekte/2026/Q1',
    ]);
  });

  it('leaves no temporary behind and does not publish the name when the flush fails', async () => {
    vi.spyOn(fs, 'open').mockImplementation(async (file, ...rest) => {
      const handle = await (realOpen as typeof fs.open)(file, ...(rest as []));
      handle.sync = async () => {
        throw Object.assign(new Error('simulated I/O error'), { code: 'EIO' });
      };
      return handle;
    });

    await expect(vault.writeNote('julian', 'Notiz.md', 'neu')).rejects.toThrow(/simulated/);

    // Nothing was renamed into place, so there is no half-written note — and no
    // temporary file sitting next to it either.
    const entries = await fs.readdir(path.join(dataDir, 'vaults', 'julian'));
    expect(entries.filter((name) => !name.startsWith('.'))).toEqual([]);
  });
});

describe('writing an attachment', () => {
  /**
   * An attachment is user data that exists nowhere else — no conflict copy, no
   * git sidecar, no index to rebuild it from — so it gets the same treatment as
   * a note. It is not on the autosave path, so the cost is paid once per upload.
   */
  it('gets the same flushes in the same order', async () => {
    await vault.createDir('julian', 'Bilder');
    log.length = 0;

    await vault.writeFileBytes('julian', 'Bilder/rack.png', Buffer.from([0x89, 0x50]));

    expect(log).toEqual([
      'open:Bilder/rack.png.tmp',
      'sync:Bilder/rack.png.tmp',
      'rename:Bilder/rack.png.tmp->Bilder/rack.png',
      'open:Bilder',
      'sync:Bilder',
    ]);
  });
});
