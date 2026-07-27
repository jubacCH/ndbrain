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

import { InvalidPathError, NotAFileError, NoteNotFoundError } from '../errors.js';
import { caseKey, isNotePath, normalizeVaultPath, resolveInVault, vaultRoot } from './paths.js';

export interface VaultEntry {
  /** Canonical vault-relative path, always POSIX-style. */
  path: string;
  size: number;
  mtimeMs: number;
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
   */
  async writeNote(owner: string, vaultPath: string, content: string): Promise<void> {
    const absolute = await this.resolve(owner, vaultPath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });

    const temporary = `${absolute}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temporary, content, 'utf8');
      await fs.rename(temporary, absolute);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
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

  /** Removes directories that became empty after a move or delete. */
  async pruneEmptyDirs(owner: string, vaultPath: string): Promise<void> {
    const root = this.rootFor(owner);
    let dir = path.dirname(await this.resolve(owner, vaultPath));

    while (dir !== root && dir.startsWith(root + path.sep)) {
      try {
        const entries = await fs.readdir(dir);
        if (entries.length > 0) return;
        await fs.rmdir(dir);
      } catch {
        return;
      }
      dir = path.dirname(dir);
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
