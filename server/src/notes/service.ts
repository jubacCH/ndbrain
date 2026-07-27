/**
 * The single write path.
 *
 * Nothing else in the server may write to the vault. Everything that changes a
 * note — the REST API, the MCP tools, later the tidy-up bulk actions — goes
 * through here, so invariants like the case-collision guard and the write lock
 * exist in exactly one place.
 *
 * v1 arrived at the same rule after the fact and it prevented a whole class of
 * bugs; here it is the starting point.
 */

import { CaseCollisionError, NoteExistsError, NoteNotFoundError } from '../errors.js';
import { parseNote, type ParsedNote } from '../markdown/parse.js';
import { caseKey, isNotePath, NOTE_EXTENSION, normalizeVaultPath, parentDir } from '../vault/paths.js';
import { Vault, type VaultEntry } from '../vault/fs.js';
import { InvalidPathError } from '../errors.js';
import { KeyedMutex } from './mutex.js';

export interface Note {
  path: string;
  /** File name without `.md` — the title, as decided: the file name *is* the title. */
  title: string;
  content: string;
  size: number;
  mtimeMs: number;
}

export interface ParsedNoteRecord extends Note {
  parsed: ParsedNote;
}

export class NoteService {
  readonly #vault: Vault;
  readonly #locks = new KeyedMutex();

  constructor(vault: Vault) {
    this.#vault = vault;
  }

  get vault(): Vault {
    return this.#vault;
  }

  async listNotes(owner: string): Promise<VaultEntry[]> {
    return this.#vault.listNotes(owner);
  }

  async listDirs(owner: string): Promise<string[]> {
    return this.#vault.listDirs(owner);
  }

  async getNote(owner: string, notePath: string): Promise<Note> {
    const canonical = this.#assertNotePath(notePath);
    const content = await this.#vault.readNote(owner, canonical);
    const stat = await this.#vault.statNote(owner, canonical);
    return {
      path: canonical,
      title: titleOf(canonical),
      content,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  }

  async getParsedNote(owner: string, notePath: string): Promise<ParsedNoteRecord> {
    const note = await this.getNote(owner, notePath);
    return { ...note, parsed: parseNote(note.content) };
  }

  async createNote(owner: string, notePath: string, content = ''): Promise<Note> {
    const canonical = this.#assertNotePath(notePath);

    return this.#locks.run(lockKey(owner, canonical), async () => {
      await this.#assertTargetFree(owner, canonical);
      await this.#vault.writeNote(owner, canonical, content);
      return this.getNote(owner, canonical);
    });
  }

  async updateNote(owner: string, notePath: string, content: string): Promise<Note> {
    const canonical = this.#assertNotePath(notePath);

    return this.#locks.run(lockKey(owner, canonical), async () => {
      await this.#assertExactNoteExists(owner, canonical);
      await this.#vault.writeNote(owner, canonical, content);
      return this.getNote(owner, canonical);
    });
  }

  /**
   * Writes a note, creating it if it is not there yet.
   *
   * The create-or-update decision belongs here, not in the caller. Deciding it
   * with an existence check means asking `stat`, and `stat` folds letter case on
   * Windows and macOS but not on Linux — so the same request would create a note
   * on one platform and overwrite a differently-cased one on another. Reading the
   * real directory entry answers "create, update or refuse" in one step,
   * identically everywhere.
   */
  async putNote(owner: string, notePath: string, content: string): Promise<{ note: Note; created: boolean }> {
    const canonical = this.#assertNotePath(notePath);

    return this.#locks.run(lockKey(owner, canonical), async () => {
      const siblings = await this.#vault.siblingCaseKeys(owner, canonical);
      const name = canonical.slice(canonical.lastIndexOf('/') + 1);
      const existing = siblings.get(caseKey(name));

      if (existing !== undefined && existing !== name) {
        throw new CaseCollisionError(
          `"${existing}" already exists and differs only in letter case; ` +
            'that pair cannot survive on Windows or macOS',
        );
      }

      await this.#vault.writeNote(owner, canonical, content);
      return { note: await this.getNote(owner, canonical), created: existing === undefined };
    });
  }

  async deleteNote(owner: string, notePath: string): Promise<void> {
    const canonical = this.#assertNotePath(notePath);

    await this.#locks.run(lockKey(owner, canonical), async () => {
      await this.#assertExactNoteExists(owner, canonical);
      await this.#vault.deleteNote(owner, canonical);
      await this.#vault.pruneEmptyDirs(owner, canonical);
    });
  }

  /**
   * Moves or renames a note.
   *
   * Phase 0 moves the file and nothing else. Rewriting `[[wikilinks]]` that point
   * at the old name needs the backlink index, so it lands in phase 2 — and it is
   * scheduled there rather than later precisely because renaming without it
   * silently breaks links the moment the tool is used daily.
   */
  async renameNote(owner: string, from: string, to: string): Promise<Note> {
    const source = this.#assertNotePath(from);
    const target = this.#assertNotePath(to);

    if (source === target) {
      return this.getNote(owner, source);
    }

    const move = async (): Promise<Note> => {
      await this.#assertExactNoteExists(owner, source);
      // A pure case change (`proxmox.md` → `Proxmox.md`) is a legitimate rename,
      // so the file being renamed is excluded from the check.
      await this.#assertTargetFree(owner, target, source);

      await this.#vault.moveNote(owner, source, target);
      await this.#vault.pruneEmptyDirs(owner, source);
      return this.getNote(owner, target);
    };

    // Lock both names, lowest first, so two concurrent swaps cannot deadlock.
    // A case-only rename folds to a single key — taking it twice would be the
    // mutex waiting on itself, so the duplicate is dropped.
    const keys = [...new Set([lockKey(owner, source), lockKey(owner, target)])].sort();

    if (keys.length === 1) {
      return this.#locks.run(keys[0]!, move);
    }
    return this.#locks.run(keys[0]!, async () => this.#locks.run(keys[1]!, move));
  }

  #assertNotePath(notePath: string): string {
    const canonical = normalizeVaultPath(notePath);
    if (!isNotePath(canonical)) {
      throw new InvalidPathError(`a note path must end in ${NOTE_EXTENSION}`);
    }
    return canonical;
  }

  /**
   * Asserts that a note exists under exactly this spelling.
   *
   * `stat` is not enough: on Windows and macOS it succeeds for `proxmox.md` when
   * the file is really called `Proxmox.md`, so a mutation aimed at a
   * misspelled path would silently hit a different note there while failing on
   * Linux. Mutations therefore compare against the real directory entry.
   */
  async #assertExactNoteExists(owner: string, notePath: string): Promise<void> {
    const siblings = await this.#vault.siblingCaseKeys(owner, notePath);
    const name = notePath.slice(notePath.lastIndexOf('/') + 1);

    if (siblings.get(caseKey(name)) !== name) {
      throw new NoteNotFoundError('note does not exist');
    }
  }

  /**
   * Asserts that nothing occupies `target`, neither exactly nor by letter case.
   *
   * Deliberately based on a directory listing rather than `stat`: on Windows and
   * macOS a `stat` for `proxmox.md` succeeds when `Proxmox.md` exists, so an
   * existence check there would mask the collision and report the wrong error —
   * and on Linux the same code would take a different branch. Reading the real
   * names makes the behaviour identical everywhere.
   *
   * `exclude` names a file that may legitimately occupy the slot: the note being
   * renamed, so that `proxmox.md` → `Proxmox.md` is allowed.
   */
  async #assertTargetFree(owner: string, target: string, exclude?: string): Promise<void> {
    const siblings = await this.#vault.siblingCaseKeys(owner, target);
    const name = target.slice(target.lastIndexOf('/') + 1);
    const existing = siblings.get(caseKey(name));

    if (existing === undefined) return;

    if (exclude !== undefined && parentDir(exclude) === parentDir(target)) {
      const excludedName = exclude.slice(exclude.lastIndexOf('/') + 1);
      if (existing === excludedName) return;
    }

    if (existing === name) {
      throw new NoteExistsError('a note already exists at that path');
    }

    throw new CaseCollisionError(
      `"${existing}" already exists and differs only in letter case; ` +
        'that pair cannot survive on Windows or macOS',
    );
  }
}

function titleOf(notePath: string): string {
  const base = notePath.slice(notePath.lastIndexOf('/') + 1);
  return base.slice(0, -NOTE_EXTENSION.length);
}

function lockKey(owner: string, notePath: string): string {
  return `${owner}:${caseKey(notePath)}`;
}
