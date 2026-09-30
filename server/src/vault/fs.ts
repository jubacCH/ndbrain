/**
 * Owner-scoped filesystem access to the vault.
 *
 * Every method takes an owner. There is deliberately no variant that does not:
 * a function without an owner argument is a tenant leak waiting to be written, and
 * the compiler is a cheaper reviewer than a person.
 *
 * `paths.ts` proves containment arithmetically; this layer re-checks it against
 * the real filesystem, because a symlink can point anywhere no matter how sound
 * the string handling was.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { InvalidPathError, NotAFileError, NoteExistsError, NoteNotFoundError } from '../errors.js';
import { caseKey, isNotePath, normalizeVaultPath, resolveInVault, vaultRoot } from './paths.js';

export interface VaultEntry {
  /** Canonical vault-relative path, always POSIX-style. */
  path: string;
  size: number;
  mtimeMs: number;
}

/** Any file in the vault, whether or not it is a note. */
export interface VaultFile extends VaultEntry {
  isNote: boolean;
}

/** Entries a vault ignores entirely: dotfiles, `.git`, `.obsidian`, `.trash`. */
function isHidden(name: string): boolean {
  return name.startsWith('.');
}

export class Vault {
  readonly #dataDir: string;

  constructor(dataDir: string) {
    this.#dataDir = path.resolve(dataDir);
  }

  rootFor(owner: string): string {
    return vaultRoot(this.#dataDir, owner);
  }

  /** Creates the owner's vault directory if it does not exist yet. */
  async ensureVault(owner: string): Promise<string> {
    const root = this.rootFor(owner);
    await fs.mkdir(root, { recursive: true });
    return root;
  }

  /**
   * Resolves a vault path and verifies that the *real* location is still inside
   * the owner's vault.
   *
   * A symlink is followed as far as it exists: `realpath` on the deepest existing
   * ancestor catches both a symlinked file and a symlinked parent directory,
   * which string checks alone cannot.
   */
  async resolve(owner: string, vaultPath: string): Promise<string> {
    const root = this.rootFor(owner);
    const absolute = resolveInVault(this.#dataDir, owner, vaultPath);

    const realRoot = await realpathOrSelf(root);
    let probe = absolute;
    let real: string | null = null;

    while (real === null) {
      try {
        real = await fs.realpath(probe);
      } catch {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }

    if (real !== null) {
      const stillInside = real === realRoot || real.startsWith(realRoot + path.sep);
      if (!stillInside) {
        throw new InvalidPathError('path escapes the vault root');
      }
    }

    return absolute;
  }

  async exists(owner: string, vaultPath: string): Promise<boolean> {
    try {
      await fs.stat(await this.resolve(owner, vaultPath));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Which file sits at a path: device, inode and birth time, or null when
   * nothing does.
   *
   * The inode alone is not enough — a filesystem hands a freed inode number to
   * the next file created, which is exactly the file that replaces a deleted
   * note. The birth time tells those two apart.
   *
   * Where the filesystem keeps no birth time — NFS, some FUSE and SMB mounts,
   * older tmpfs — Node reports zero, and the inode alone would decide. There
   * the change time stands in: it moves with every write and every rename, so
   * the identity changes more often than the file does, never less. An edit
   * made in place from outside then withdraws a note share instead of letting
   * a replacement inherit it; ndBrain's own writes and renames rebind.
   */
  async fileIdentity(owner: string, vaultPath: string): Promise<string | null> {
    const absolute = await this.resolve(owner, vaultPath);
    try {
      const stat = await fs.stat(absolute, { bigint: true });
      if (!stat.isFile()) return null;
      const born = stat.birthtimeNs === 0n ? `c${stat.ctimeNs}` : `${stat.birthtimeNs}`;
      return `${stat.dev}:${stat.ino}:${born}`;
    } catch {
      return null;
    }
  }

  async readNote(owner: string, vaultPath: string): Promise<string> {
    const absolute = await this.resolve(owner, vaultPath);
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) throw new NotAFileError('path is not a file');
      return await fs.readFile(absolute, 'utf8');
    } catch (error) {
      if (error instanceof NotAFileError) throw error;
      throw new NoteNotFoundError('note does not exist');
    }
  }

  async statNote(owner: string, vaultPath: string): Promise<VaultEntry> {
    const absolute = await this.resolve(owner, vaultPath);
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) throw new NotAFileError('path is not a file');
      return {
        path: normalizeVaultPath(vaultPath),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    } catch (error) {
      if (error instanceof NotAFileError) throw error;
      throw new NoteNotFoundError('note does not exist');
    }
  }

  /** Every note in the owner's vault, depth-first, hidden entries skipped. */
  async listNotes(owner: string): Promise<VaultEntry[]> {
    const root = this.rootFor(owner);
    const out: VaultEntry[] = [];

    const walk = async (dir: string, prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // vault not created yet, or removed underneath us
      }

      for (const entry of entries) {
        if (isHidden(entry.name)) continue;
        const child = path.join(dir, entry.name);
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

        // Do not follow symlinked directories: they can point outside the vault,
        // and a loop would hang the walk.
        if (entry.isDirectory()) {
          await walk(child, relative);
        } else if (entry.isFile() && isNotePath(entry.name)) {
          const stat = await fs.stat(child);
          out.push({ path: relative, size: stat.size, mtimeMs: stat.mtimeMs });
        }
      }
    };

    await walk(root, '');
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  /**
   * Every file in the vault, notes and everything else, plus the folders.
   *
   * `listNotes` deliberately filters to `.md` because the index only means
   * anything for notes. The file browser is the other half of the same truth: a
   * vault is a folder of files, and an attachment nobody can see is an
   * attachment nobody can remove. Folders come back separately so an empty one
   * does not silently disappear from the browser.
   *
   * Capped rather than unbounded — a vault that has grown a `node_modules` by
   * accident should degrade into "showing the first 5000" rather than into a
   * request that never finishes.
   */
  async listAll(
    owner: string,
    limit = 5000,
  ): Promise<{ files: VaultFile[]; dirs: string[]; truncated: boolean }> {
    const root = this.rootFor(owner);
    const files: VaultFile[] = [];
    const dirs: string[] = [];
    let truncated = false;

    const walk = async (dir: string, prefix: string): Promise<void> => {
      if (truncated) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (isHidden(entry.name)) continue;
        const child = path.join(dir, entry.name);
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

        if (entry.isDirectory()) {
          dirs.push(relative);
          await walk(child, relative);
        } else if (entry.isFile()) {
          if (files.length >= limit) {
            truncated = true;
            return;
          }
          const stat = await fs.stat(child);
          files.push({
            path: relative,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            isNote: isNotePath(entry.name),
          });
        }
      }
    };

    await walk(root, '');
    files.sort((a, b) => a.path.localeCompare(b.path));
    dirs.sort((a, b) => a.localeCompare(b));
    return { files, dirs, truncated };
  }

  /**
   * Raw bytes of any file in the vault.
   *
   * Separate from `readNote` because that one decodes UTF-8, which would corrupt
   * a PNG on the way through. Nothing here interprets the content at all.
   */
  async readFileBytes(owner: string, vaultPath: string): Promise<Buffer> {
    const absolute = await this.resolve(owner, vaultPath);
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) throw new NotAFileError('path is not a file');
      return await fs.readFile(absolute);
    } catch (error) {
      if (error instanceof NotAFileError) throw error;
      throw new NoteNotFoundError('file does not exist');
    }
  }

  /**
   * Writes any file, replacing it if present.
   *
   * Same temp-file-then-rename as `writeNote`, for the same reason: an upload
   * that dies halfway must not leave a half-written attachment where a whole one
   * used to be.
   *
   * Flushed like a note, too. An attachment is user data that exists nowhere
   * else — no conflict copy, no git sidecar, nothing to rebuild it from — and
   * an upload happens once, not on every keystroke, so the flush costs nothing
   * anybody waits for twice.
   */
  async writeFileBytes(owner: string, vaultPath: string, bytes: Buffer): Promise<void> {
    const absolute = await this.resolve(owner, vaultPath);
    await ensureDirFor(absolute);
    await writeDurably(absolute, bytes);
  }

  /** Directory names directly under `dir`, used to build the tree. */
  async listDirs(owner: string): Promise<string[]> {
    const root = this.rootFor(owner);
    const out: string[] = [];

    const walk = async (dir: string, prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (isHidden(entry.name) || !entry.isDirectory()) continue;
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        out.push(relative);
        await walk(path.join(dir, entry.name), relative);
      }
    };

    await walk(root, '');
    out.sort((a, b) => a.localeCompare(b));
    return out;
  }

  /**
   * Names already present in the target's directory, as case-folded keys.
   *
   * Used to refuse a write that would create a second file differing only in
   * case — see `CaseCollisionError`.
   */
  async siblingCaseKeys(owner: string, vaultPath: string): Promise<Map<string, string>> {
    const absolute = await this.resolve(owner, vaultPath);
    const dir = path.dirname(absolute);
    const map = new Map<string, string>();

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return map; // directory does not exist yet — nothing to collide with
    }

    for (const entry of entries) {
      map.set(caseKey(entry.name), entry.name);
    }
    return map;
  }

  /**
   * Writes a note, replacing it if present.
   *
   * Written to a temporary file in the same directory and renamed into place, so
   * a crash mid-write leaves the previous version intact rather than a truncated
   * file. Same directory matters: rename is only atomic within one filesystem.
   *
   * Flushed as well as renamed — see `writeDurably`. A rename alone is the right
   * answer to a process that dies and no answer at all to a host that loses
   * power.
   */
  async writeNote(owner: string, vaultPath: string, content: string): Promise<void> {
    const absolute = await this.resolve(owner, vaultPath);
    await ensureDirFor(absolute);
    await writeDurably(absolute, content);
  }

  async deleteNote(owner: string, vaultPath: string): Promise<void> {
    const absolute = await this.resolve(owner, vaultPath);
    try {
      await fs.unlink(absolute);
    } catch {
      throw new NoteNotFoundError('note does not exist');
    }
  }

  async moveNote(owner: string, from: string, to: string): Promise<void> {
    const source = await this.resolve(owner, from);
    const target = await this.resolve(owner, to);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(source, target);
  }

  /**
   * Moves a file that is not a note, refusing to land on one that is there.
   *
   * `moveNote` is the counterpart for notes and goes through the note lock and
   * the share bindings; an attachment has neither, so this is the whole of it.
   * What it must not do is what a bare `rename(2)` does happily: replace the
   * file at the target and lose it. A folder move is not something anybody
   * expects to delete a file.
   */
  async moveFile(owner: string, from: string, to: string): Promise<void> {
    const target = normalizeVaultPath(to);
    if (await this.exists(owner, target)) {
      throw new NoteExistsError(`a file already exists at ${target}`);
    }
    await this.moveNote(owner, from, target);
  }

  /**
   * Creates a folder, including its parents.
   *
   * A folder with no notes in it has nowhere else to be recorded — the index is
   * built from notes, so an empty folder exists only as a directory on disk.
   * That is also why it survives a full reindex: the filesystem is the truth.
   */
  async createDir(owner: string, vaultPath: string): Promise<void> {
    const absolute = await this.resolve(owner, vaultPath);
    await fs.mkdir(absolute, { recursive: true });
  }

  /** True if the path exists and is a directory. */
  async isDir(owner: string, vaultPath: string): Promise<boolean> {
    try {
      const absolute = await this.resolve(owner, vaultPath);
      return (await fs.stat(absolute)).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Moves a folder wholesale, after its notes have been moved one by one.
   *
   * Only ever called on what is left over: empty subdirectories that no note
   * move would have carried across. Refuses to overwrite an existing target
   * rather than merging two trees silently.
   */
  async moveDir(owner: string, from: string, to: string): Promise<void> {
    const source = await this.resolve(owner, from);
    const target = await this.resolve(owner, to);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(source, target);
  }

  /**
   * Removes a directory only if nothing is left in it.
   *
   * Asked for, never guessed. There used to be a `pruneEmptyDirs` beside this
   * which walked up from a deleted or moved note and removed every folder it
   * had left empty — the one operation here that destroyed something nobody
   * had named. A folder prepared with `createDir` is indistinguishable on disk
   * from one that only ever held the note which has just left, so it deleted
   * both, chain and all. An empty folder is a finding in the tidy view now:
   * the vault says what stands out and the person decides, and this is the
   * route that decision takes.
   */
  async removeDirIfEmpty(owner: string, vaultPath: string): Promise<boolean> {
    const absolute = await this.resolve(owner, vaultPath);
    try {
      await fs.rmdir(absolute);
      return true;
    } catch {
      return false;
    }
  }
}

async function realpathOrSelf(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return target;
  }
}

/**
 * Writes a file so that a power cut leaves either the old content or the new one.
 *
 * Temp file, rename, and — the part that was missing — two flushes around the
 * rename. Without them the rename is only durable against a *process* dying:
 * the kernel has the bytes in its page cache and the directory entry in its
 * journal, and the two reach the platter in whatever order the filesystem
 * likes. The order it likes is famously the wrong one — the metadata is small
 * and goes out with the next journal commit, the data is large and waits for
 * writeback — which is why the classic sighting after an unclean reboot is a
 * note of zero bytes at the right name. The vault's host has no UPS, so that
 * is the likelier of the two failures, not the exotic one.
 *
 * So, in order, and the order is the guarantee:
 *
 * 1. **Flush the temporary file** while it is still invisible. Its content is
 *    on the disk before anything points at it, so the worst a crash can do at
 *    this point is leave a `.tmp` nobody reads.
 * 2. **Rename** it over the target. Atomic within one directory, as before.
 * 3. **Flush the directory.** The new name lives in the directory, and that is
 *    a write of its own: a rename whose directory block never reached the disk
 *    is a rename that did not happen, which after the reboot means the *old*
 *    note is back. One flush covers both halves of the rename — the name
 *    appearing and the temporary name going — because both are entries in the
 *    same directory, which is the same reason the temporary has to be written
 *    beside the target rather than in `/tmp`.
 *
 * `sync()` and not `datasync()`: `fdatasync(2)` is allowed to leave the inode
 * metadata behind, and for a file created a moment ago the size *is* the
 * content. A durable inode of length zero pointing at durable bytes is the same
 * lost note by a more interesting route.
 *
 * What this cannot promise is anything about the hardware. On Linux, where this
 * runs, `fsync(2)` on ext4 issues a device cache flush and the guarantee is
 * real. On macOS, where the tests run, it hands the data to the drive and
 * returns without waiting for the drive's own cache; only
 * `fcntl(F_FULLFSYNC)` waits, and Node exposes no way to ask for it. The calls
 * are therefore correct everywhere and binding only on the platform that
 * matters — and the test says so rather than implying more.
 *
 * **What it costs**, measured rather than guessed, 120 writes of a note-sized
 * file per variant:
 *
 * - Production (ext4 in the LXC, against `/data`): 0.16 ms without the flushes,
 *   **6.98 ms mean / 6.92 ms median** with both.
 * - The development machine (macOS, APFS on the internal SSD): 0.87 ms without,
 *   9.32 ms with — split about evenly between the two flushes, 4.65 ms for the
 *   file and 5.37 ms for the directory.
 *
 * So the platform where the flush actually reaches the device is the *cheaper*
 * of the two, and an autosave pays around seven milliseconds for surviving a
 * power cut. That is the trade, in numbers, in the place somebody will look.
 */
async function writeDurably(target: string, content: string | Buffer): Promise<void> {
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    // 'wx' — created by us or not at all. The name is random, so an existing one
    // means something is badly wrong and guessing is worse than failing.
    const handle = await fs.open(temporary, 'wx', 0o644);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.rename(temporary, target);
  } catch (error) {
    // A flush that fails before the rename is a write that must fail: nothing
    // points at the temporary yet, so reporting success would be a lie about a
    // note that is not there.
    await fs.rm(temporary, { force: true });
    throw error;
  }

  await syncDir(path.dirname(target));
}

/**
 * Flushes a directory's entries, as far as the platform allows.
 *
 * Deliberately silent about failure, which is the one place here that swallows
 * an error. By the time this runs the rename has already taken effect, so
 * throwing would report a failed save for a note that is on disk and readable —
 * and the caller would show a conflict or retry over something that worked.
 * There is also no filesystem to retry on: where flushing a directory is not
 * supported at all (some network and FUSE mounts), every single note write
 * would fail instead, which is a worse outcome than a weaker promise about
 * power loss. Opening a directory for reading is likewise not portable, so that
 * too is allowed to come to nothing.
 */
async function syncDir(dir: string): Promise<void> {
  let handle;
  try {
    handle = await fs.open(dir, 'r');
  } catch {
    return;
  }
  try {
    await handle.sync();
  } catch {
    // see above
  } finally {
    await handle.close();
  }
}

/**
 * Creates the directory a file is about to be written into.
 *
 * `mkdir` recursively and then flush whatever it had to create, parent first. A
 * durable file inside a directory whose own entry never reached the disk is
 * still a lost file, so the chain is only as strong as its topmost new link.
 * `mkdir` says which link that was — it returns the first path it created, and
 * nothing at all when the directory was already there, which is the common case
 * and costs nothing.
 *
 * Each directory's *parent* is what gets flushed: a directory's entry lives in
 * its parent, not in itself. The innermost one is left out because the write
 * that follows flushes it anyway, after the rename.
 */
async function ensureDirFor(target: string): Promise<string | undefined> {
  const dir = path.dirname(target);
  const created = await fs.mkdir(dir, { recursive: true });
  if (created === undefined) return undefined;

  const parents: string[] = [];
  for (let current = dir; ; current = path.dirname(current)) {
    parents.push(path.dirname(current));
    if (current === created || path.dirname(current) === current) break;
  }
  for (const parent of parents.reverse()) {
    await syncDir(parent);
  }

  return created;
}
