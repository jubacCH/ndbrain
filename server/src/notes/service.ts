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
import {
  assertLinkableName,
  caseKey,
  isNotePath,
  NOTE_EXTENSION,
  normalizeVaultPath,
  parentDir,
} from '../vault/paths.js';
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

export interface PutOptions {
  /**
   * The `mtimeMs` the client last saw. When the note on disk is newer, the
   * version about to be overwritten is kept as a conflict copy.
   */
  baseMtimeMs?: number;
}

export interface PutResult {
  note: Note;
  created: boolean;
  /** Path of the copy holding the displaced version, when there was one. */
  conflictCopy?: string;
}

/**
 * Names the copy that holds a displaced version.
 *
 * Local time and minute precision, because the name is read by a person deciding
 * which of two files to keep. Seconds would be noise, and UTC would make the
 * timestamp disagree with the one shown everywhere else in the UI.
 */
function conflictPath(notePath: string, when: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp =
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}.${pad(when.getMinutes())}`;

  return `${notePath.replace(/\.md$/i, '')} (Konflikt ${stamp})${NOTE_EXTENSION}`;
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
    assertLinkableName(canonical);

    return this.#locks.run(lockKey(owner, canonical), async () => {
      await this.#assertTargetFree(owner, canonical);
      await this.#vault.writeNote(owner, canonical, content);
      return this.getNote(owner, canonical);
    });
  }

  /**
   * Overwrites an existing note.
   *
   * Takes the same `baseMtimeMs` as `putNote`, and for the same reason: an agent
   * writing through MCP reads a note, thinks about it, and writes it back, and
   * everything a person typed in between is inside that window. Without the base
   * version this call cannot tell "I am the only writer" from "somebody else
   * changed this since I read it", so it silently wins.
   */
  async updateNote(
    owner: string,
    notePath: string,
    content: string,
    options: PutOptions = {},
  ): Promise<PutResult> {
    const canonical = this.#assertNotePath(notePath);

    return this.#locks.run(lockKey(owner, canonical), async () => {
      await this.#assertExactNoteExists(owner, canonical);
      const conflictCopy = await this.#preserveDisplaced(owner, canonical, content, options);
      await this.#vault.writeNote(owner, canonical, content);

      const result: PutResult = { note: await this.getNote(owner, canonical), created: false };
      if (conflictCopy !== null) result.conflictCopy = conflictCopy;
      return result;
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
  async putNote(
    owner: string,
    notePath: string,
    content: string,
    options: PutOptions = {},
  ): Promise<PutResult> {
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

      // Only a *new* note is held to the linkable-name rule. An existing note
      // that arrived from another tool with brackets in its name must stay
      // writable, or the import would leave notes that cannot be edited.
      if (existing === undefined) assertLinkableName(canonical);

      // Everything about the conflict check happens inside the lock. Outside it,
      // the file could change between the comparison and the write, which is
      // precisely the case being guarded against.
      const conflictCopy =
        existing === undefined ? null : await this.#preserveDisplaced(owner, canonical, content, options);

      await this.#vault.writeNote(owner, canonical, content);

      const result: PutResult = {
        note: await this.getNote(owner, canonical),
        created: existing === undefined,
      };
      if (conflictCopy !== null) result.conflictCopy = conflictCopy;
      return result;
    });
  }

  /**
   * Keeps the version this write is about to displace, if it is not the version
   * the writer had in front of them.
   *
   * The rule stays last-writer-wins — the incoming content lands, nobody is told
   * "someone else got there first, try again". But the version being overwritten
   * is written out beside the note first, so a shared note cannot silently eat
   * somebody's paragraph. Nothing is merged: a merge that gets it wrong is worse
   * than two files, because it looks finished.
   *
   * Only meaningful when the client says which version it started from; a client
   * that sends nothing gets the old behaviour, which is right for a single-user
   * vault where the only writer is the person watching.
   */
  async #preserveDisplaced(
    owner: string,
    canonical: string,
    incoming: string,
    options: PutOptions,
  ): Promise<string | null> {
    const base = options.baseMtimeMs;
    if (base === undefined || base <= 0) return null;

    const current = await this.getNote(owner, canonical);
    if (current.mtimeMs <= base) return null;

    // Identical content is not a conflict, whatever the timestamps say. Two
    // clients autosaving the same text would otherwise litter the folder.
    if (current.content === incoming) return null;

    const copyPath = conflictPath(canonical, new Date());
    await this.#vault.writeNote(owner, copyPath, current.content);
    return copyPath;
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
    // Only the destination. A note that arrived from another tool with an
    // unlinkable name must stay renameable — that rename is the way *out* of the
    // problem, and blocking it would trap the note in it.
    assertLinkableName(target);

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
