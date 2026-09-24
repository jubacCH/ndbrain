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
import { appended } from '../markdown/edit.js';
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
import { contentHash } from '../auth/noteBindings.js';
import type { NoteLifecycle } from '../auth/shares.js';

export interface Note {
  path: string;
  /** File name without `.md` — the title, as decided: the file name *is* the title. */
  title: string;
  content: string;
  size: number;
  mtimeMs: number;
  /**
   * Which version of the text this is — the hash of `content`.
   *
   * Handed out with every read so that a writer can name the version it started
   * from as something other than a clock reading; see `PutOptions.baseHash`.
   * Opaque to every client: nothing outside this server computes it, so the
   * algorithm can change without a single caller knowing.
   */
  hash: string;
}

export interface ParsedNoteRecord extends Note {
  parsed: ParsedNote;
}

/**
 * The permission check, run again inside the note's lock.
 *
 * A route decides whether the caller may write long before the write reaches
 * the file, and in between `confirm` may withdraw the very note share the route
 * said yes to — a file replaced behind ndBrain's back is recognised only once
 * the lock is held. Everything the caller would get out of that gap (the
 * stranger's bytes overwritten, deleted, moved into a folder the caller can
 * read for good, or handed straight back in a response body) happens after this
 * runs, so the withdrawal takes effect on the operation that is already under
 * way rather than on the next one.
 *
 * It throws the same `NoteNotFoundError` the route's own check throws:
 * refusal looks like absence, here as everywhere.
 */
export interface Authorized {
  /** Called in the note's lock, after `confirm` and before anything is written. */
  authorize?: () => void;
}

export interface PutOptions extends Authorized {
  /**
   * The `hash` of the text the writer started from, as a read handed it out.
   *
   * The version the writer saw, said in the only terms that cannot lie: when
   * the note on disk no longer holds that text, the version about to be
   * overwritten is kept as a conflict copy.
   */
  baseHash?: string;
  /**
   * The `mtimeMs` the client last saw — the same question asked of the clock.
   *
   * Only consulted when no `baseHash` is given, and only for as long as clients
   * that predate the hash are still out there; see `#preserveDisplaced`.
   */
  baseMtimeMs?: number;
}

export interface AppendOptions extends Authorized {
  /**
   * The heading the text goes under, by its own words. Without it the text goes
   * at the end of the note; see `appended` for what a missing section does.
   */
  section?: string;
  /**
   * What the note is created with when it is not there — the text the addition
   * is then appended to. Absent means an absent note is refused, which is what
   * every caller that means "add to this note" wants.
   */
  ifAbsent?: string;
}

/** Both ends of a move are checked again in the lock; see `Authorized`. */
export interface RenameOptions {
  authorizeSource?: () => void;
  authorizeTarget?: () => void;
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
 *
 * `ordinal` is which copy of that minute this is, and it is why the minute can
 * stay: two conflicts inside one minute — and the autumn hour, which hands the
 * same minute out a second time — otherwise want the same name, and the second
 * copy would replace the first. The first of a minute carries no suffix, so
 * every name written before this existed is still exactly what this produces
 * and still reads back; see `parseConflictPath`.
 *
 * Exported so `parseConflictPath` below, and the tidy-up finding that uses it,
 * can be checked against exactly what this writes rather than a second,
 * hand-copied pattern that could drift from it.
 */
export function conflictPath(notePath: string, when: Date, ordinal = 1): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp =
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}.${pad(when.getMinutes())}`;
  const nth = ordinal > 1 ? `-${ordinal}` : '';

  return `${notePath.replace(/\.md$/i, '')} (Konflikt ${stamp}${nth})${NOTE_EXTENSION}`;
}

/** What a conflict copy's name says about the version it displaced. */
export interface ConflictInfo {
  /** Path of the note the copy was made from, reconstructed from its own name. */
  originalPath: string;
  /** The moment named in the copy's filename, read as local time — see `conflictPath`. */
  at: number;
  /** Which copy of that minute this is. 1 for a name that carries no count. */
  ordinal: number;
}

/**
 * The exact shape `conflictPath` writes, read back.
 *
 * Kept next to `conflictPath` rather than as a second pattern somewhere else in
 * the codebase: a query that finds these copies has to recognise precisely what
 * this function produces, and the two drifting apart would mean either missed
 * copies or false positives on an ordinary note that happens to have "(Konflikt"
 * in its title. `null` for anything that is not that exact shape, including a
 * note whose name merely contains the word.
 */
export function parseConflictPath(notePath: string): ConflictInfo | null {
  const match = /^(.+) \(Konflikt (\d{4})-(\d{2})-(\d{2}) (\d{2})\.(\d{2})(?:-(\d+))?\)\.md$/.exec(
    notePath,
  );
  if (match === null) return null;

  const base = match[1] ?? '';
  const year = Number(match[2] ?? '');
  const month = Number(match[3] ?? '');
  const day = Number(match[4] ?? '');
  const hour = Number(match[5] ?? '');
  const minute = Number(match[6] ?? '');
  // Optional, because that is what a name written before the count existed
  // looks like — and every copy already lying in a vault is one of those. A
  // name that stopped parsing would drop out of the tidy-up view, which is the
  // one place these files are ever reported.
  const ordinal = match[7] === undefined ? 1 : Number(match[7]);

  const at = new Date(year, month - 1, day, hour, minute);
  if (Number.isNaN(at.getTime())) return null;

  const originalPath = `${base}${NOTE_EXTENSION}`;

  // `new Date` does not reject an impossible calendar value, it rolls it over —
  // "2026-13-45 99.99" quietly becomes some date the following year rather than
  // NaN. Regenerating the name from what was just parsed and comparing it back
  // to the input catches that: a rolled-over `at` renders a different stamp, so
  // the two will not match, and this is not a conflict copy after all. The same
  // round trip rules out a count this would never write — `-1`, `-0`, `-02` —
  // without a second rule for it.
  if (conflictPath(originalPath, at, ordinal) !== notePath) return null;

  return { originalPath, at: at.getTime(), ordinal };
}

/** For a service nobody listens to — the unit tests that build one bare. */
const UNOBSERVED: NoteLifecycle = {
  created: () => {},
  moved: () => {},
  removed: () => {},
  confirm: async () => null,
  rebind: async () => {},
};

export class NoteService {
  readonly #vault: Vault;
  readonly #locks = new KeyedMutex();
  readonly #lifecycle: NoteLifecycle;

  /**
   * `lifecycle` hears about notes appearing, moving and disappearing, from
   * inside the lock that makes the change. That is where note shares follow
   * their note: anywhere later, and a request in between could find the file
   * moved and the share not, or a new note already carrying an old grant.
   */
  constructor(vault: Vault, lifecycle: NoteLifecycle = UNOBSERVED) {
    this.#vault = vault;
    this.#lifecycle = lifecycle;
  }

  /**
   * Runs `fn` holding the write lock of one note.
   *
   * For decisions that have to see the note as the write path sees it — a
   * note share may only be granted on a note that exists, and "exists" must not
   * change between the look and the grant.
   */
  async withLock<T>(owner: string, notePath: string, fn: () => Promise<T>): Promise<T> {
    return this.#locks.run(lockKey(owner, this.#assertNotePath(notePath)), fn);
  }

  /** Whether a note exists under exactly this spelling. Call it inside `withLock`. */
  async exists(owner: string, notePath: string): Promise<boolean> {
    const canonical = this.#assertNotePath(notePath);
    try {
      await this.#assertExactNoteExists(owner, canonical);
      return true;
    } catch {
      return false;
    }
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
      hash: contentHash(content),
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
      this.#lifecycle.created(owner, canonical);
      return this.getNote(owner, canonical);
    });
  }

  /**
   * Creates a note unless it already exists, and never writes over one.
   *
   * For writers that mean "make sure this note is there": the daily note that a
   * button, a shortcut and a second tab may all ask for in the same second.
   * `putNote` is wrong for that — the second request would overwrite whatever
   * the first one's person had typed since, silently, because it carries no
   * base version. `createNote` is right about the write but answers the second
   * request with an error, which leaves the caller to guess whether the note it
   * wanted is the one that is there.
   *
   * The existence check and the write sit inside the same lock, so of any number
   * of concurrent calls exactly one writes and every other one reads back what
   * that one wrote. A differently-cased sibling is still refused: opening it
   * would hand back a note under a name the caller did not ask for.
   */
  async createNoteIfAbsent(
    owner: string,
    notePath: string,
    content: string,
    options: Authorized = {},
  ): Promise<PutResult> {
    const canonical = this.#assertNotePath(notePath);

    return this.#locks.run(lockKey(owner, canonical), async () => {
      const siblings = await this.#vault.siblingCaseKeys(owner, canonical);
      const name = canonical.slice(canonical.lastIndexOf('/') + 1);
      const existing = siblings.get(caseKey(name));

      // The binding first, then the permission, and only then anything at all
      // about what is on this path. The note that is there is handed back in
      // full, and the collision below would name a file — a note renamed to
      // another letter case behind ndBrain's back would otherwise tell a
      // grantee its new name, where an unshared note answers 404.
      await this.#lifecycle.confirm(owner, canonical);
      options.authorize?.();

      if (existing === name) {
        return { note: await this.getNote(owner, canonical), created: false };
      }
      if (existing !== undefined) {
        throw new CaseCollisionError(
          `"${existing}" already exists and differs only in letter case; ` +
            'that pair cannot survive on Windows or macOS',
        );
      }

      assertLinkableName(canonical);
      await this.#vault.writeNote(owner, canonical, content);
      this.#lifecycle.created(owner, canonical);
      return { note: await this.getNote(owner, canonical), created: true };
    });
  }

  /**
   * Overwrites an existing note.
   *
   * Takes the same base version as `putNote`, and for the same reason: an agent
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
      // Before anything is written: a note replaced behind ndBrain's back
      // since the watcher last looked must not have its shares carried over
      // to the stranger by this write.
      const confirmed = await this.#lifecycle.confirm(owner, canonical);
      options.authorize?.();
      const conflictCopy = await this.#preserveDisplaced(owner, canonical, content, options);
      await this.#vault.writeNote(owner, canonical, content);
      await this.#lifecycle.rebind(owner, canonical, confirmed);

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

      // Before anything is said about what is on this path, including the
      // collision below: it names the file that is there, and a note renamed
      // to another letter case behind ndBrain's back would otherwise tell a
      // grantee its new name where an unshared note answers 404. `confirm`
      // returns null of its own accord when no note exists under exactly this
      // spelling — having withdrawn the shares that named one.
      const confirmed = await this.#lifecycle.confirm(owner, canonical);
      options.authorize?.();

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

      // A write that names the version it started from is an edit of that
      // version, never a create. Without this, a save racing a rename of the
      // same note lands after the move and brings a new note into being at the
      // old path — outside whatever share the writer holds on the moved one.
      if (existing === undefined && namesAVersion(options)) {
        throw new NoteNotFoundError('note does not exist');
      }

      // Everything about the conflict check happens inside the lock. Outside it,
      // the file could change between the comparison and the write, which is
      // precisely the case being guarded against.
      const conflictCopy =
        existing === undefined ? null : await this.#preserveDisplaced(owner, canonical, content, options);

      await this.#vault.writeNote(owner, canonical, content);
      if (existing === undefined) this.#lifecycle.created(owner, canonical);
      else await this.#lifecycle.rebind(owner, canonical, confirmed);

      const result: PutResult = {
        note: await this.getNote(owner, canonical),
        created: existing === undefined,
      };
      if (conflictCopy !== null) result.conflictCopy = conflictCopy;
      return result;
    });
  }

  /**
   * Adds text to a note, creating it from `ifAbsent` when it is not there.
   *
   * Read and write happen inside one hold of the note's lock, and that is the
   * whole point of the method existing at all. The same operation done as a
   * read-modify-write by a caller — GET the note, splice, PUT it back — has a
   * window between the two calls in which anybody else's write is lost: the
   * editor in another tab, an agent through MCP, a second capture typed
   * quickly. Here there is no window. Of two appends racing, one waits and then
   * reads what the other wrote, so the second addition lands after the first
   * and neither is gone.
   *
   * That is also why there is no `baseMtimeMs` and no conflict copy. A conflict
   * copy preserves a version a write is about to *displace*, and an append
   * displaces nothing: it only ever grows the note. The editor's own save still
   * carries its base version, so a tab that was holding this note from before
   * the append and saves afterwards makes a copy as it always did — the
   * appended text is protected by the mechanism that already existed, not by a
   * second one here.
   */
  async appendNote(
    owner: string,
    notePath: string,
    addition: string,
    options: AppendOptions = {},
  ): Promise<PutResult> {
    const canonical = this.#assertNotePath(notePath);

    return this.#locks.run(lockKey(owner, canonical), async () => {
      const siblings = await this.#vault.siblingCaseKeys(owner, canonical);
      const name = canonical.slice(canonical.lastIndexOf('/') + 1);
      const existing = siblings.get(caseKey(name));

      // The binding first, then the permission, then anything about what is on
      // this path — the order `putNote` explains at length and for the same
      // reason: the collision below names a file.
      const confirmed = await this.#lifecycle.confirm(owner, canonical);
      options.authorize?.();

      if (existing !== undefined && existing !== name) {
        throw new CaseCollisionError(
          `"${existing}" already exists and differs only in letter case; ` +
            'that pair cannot survive on Windows or macOS',
        );
      }

      // "Add to this note" is not "create this note". A caller that means both
      // says so by sending the text a new note starts with.
      if (existing === undefined && options.ifAbsent === undefined) {
        throw new NoteNotFoundError('note does not exist');
      }

      // Read through the vault rather than through `getNote`: this is the read
      // half of the read-modify-write the lock exists to protect, and it should
      // read as one.
      const before =
        existing === undefined ? options.ifAbsent! : await this.#vault.readNote(owner, canonical);
      const content = appended(before, addition, options.section);

      if (existing === undefined) assertLinkableName(canonical);
      await this.#vault.writeNote(owner, canonical, content);
      if (existing === undefined) this.#lifecycle.created(owner, canonical);
      else await this.#lifecycle.rebind(owner, canonical, confirmed);

      return { note: await this.getNote(owner, canonical), created: existing === undefined };
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
   *
   * **Which version that is, is asked of the text and not of the clock.** This
   * used to compare timestamps — `current.mtimeMs <= base`, overwrite without a
   * copy — and the project already knew better elsewhere: the README says change
   * detection compares content hashes because a restore, a `git checkout` or an
   * rsync leaves changed text behind an *older* stamp. A tab holding the version
   * from before such a restore then found `mtimeMs <= base` true and silently
   * overwrote what had just been brought back. A filesystem with whole-second
   * stamps loses a version the same way without anybody restoring anything.
   *
   * So `baseHash` is the contract: the hash a read handed out, sent back by the
   * writer, compared against the text that is on disk now. It answers the
   * question that actually matters — "is the file still holding what you started
   * from" — in both directions, and it also stops the copies a bare `touch` used
   * to produce, where the stamp moved and not a word did.
   *
   * `baseMtimeMs` stays as the fallback, for one narrow reason: a deploy does not
   * close the browser tabs that are already open, and those tabs send nothing
   * else. Its comparison is `!==` rather than `<=`, which is the most that can be
   * had from a clock — "the stamp is not the one you read" catches the restore
   * too, and the only thing it gets wrong is a `touch`, which is what the old
   * comparison already got wrong. It is not a second contract for callers to
   * choose from: everything inside this server that reads before it writes sends
   * `baseHash`.
   */
  async #preserveDisplaced(
    owner: string,
    canonical: string,
    incoming: string,
    options: PutOptions,
  ): Promise<string | null> {
    if (!namesAVersion(options)) return null;

    const current = await this.getNote(owner, canonical);

    // Identical content is not a conflict, whatever anything else says. Two
    // clients autosaving the same text would otherwise litter the folder.
    if (current.content === incoming) return null;

    const displaced =
      options.baseHash !== undefined
        ? current.hash !== options.baseHash
        : current.mtimeMs !== options.baseMtimeMs;
    if (!displaced) return null;

    const copyPath = await this.#freeConflictPath(owner, canonical, new Date());
    await this.#vault.writeNote(owner, copyPath, current.content);
    // A new note like any other: whatever was once shared under that name is
    // not this copy's to inherit.
    this.#lifecycle.created(owner, copyPath);
    return copyPath;
  }

  /**
   * The name for a copy: the first one of that minute nothing has taken.
   *
   * `conflictPath` names by the minute because a person reads that name, so two
   * conflicts of the same note inside one minute ask for the same one — and
   * `writeNote` replaces what is there. That would be a conflict copy lost to a
   * conflict copy: the one file in the vault that nothing else holds a version
   * of, overwritten by the mechanism built to stop exactly that. The hour that
   * repeats itself when the clocks go back in autumn produces the same
   * collision a good deal more slowly.
   *
   * Whoever took the name does not matter — an earlier copy, a restore, a file
   * written by hand — only whether it is free. One directory listing answers it
   * for every candidate, compared case-insensitively because a name differing
   * from an existing file only in case is not free either: that pair cannot
   * survive on Windows or macOS, which is why `#assertTargetFree` refuses it
   * everywhere. The loop ends because every round rules out one more of the
   * finitely many names in that directory.
   *
   * Called inside the note's lock, like everything else about the copy: two
   * writes to one note are serialised, so between looking and writing nothing
   * of ndBrain's can take the name that was just found free.
   */
  async #freeConflictPath(owner: string, notePath: string, when: Date): Promise<string> {
    const siblings = await this.#vault.siblingCaseKeys(owner, notePath);

    for (let ordinal = 1; ; ordinal += 1) {
      const candidate = conflictPath(notePath, when, ordinal);
      const name = candidate.slice(candidate.lastIndexOf('/') + 1);
      if (!siblings.has(caseKey(name))) return candidate;
    }
  }

  async deleteNote(owner: string, notePath: string, options: Authorized = {}): Promise<void> {
    const canonical = this.#assertNotePath(notePath);

    await this.#locks.run(lockKey(owner, canonical), async () => {
      await this.#assertExactNoteExists(owner, canonical);
      // A delete destroys a file as thoroughly as a write overwrites one, so it
      // asks the same question first: is the file on this path still the one
      // the caller's note share was given for?
      await this.#lifecycle.confirm(owner, canonical);
      options.authorize?.();
      await this.#vault.deleteNote(owner, canonical);
      this.#lifecycle.removed(owner, canonical);
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
  async renameNote(owner: string, from: string, to: string, options: RenameOptions = {}): Promise<Note> {
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

      // Only shares still naming the file that is moved go with it.
      const confirmed = await this.#lifecycle.confirm(owner, source);
      // Both ends, after the confirmation: a share withdrawn here is exactly
      // the one that would otherwise carry a stranger's file into a folder the
      // caller can read for good.
      options.authorizeSource?.();
      options.authorizeTarget?.();
      await this.#vault.moveNote(owner, source, target);
      this.#lifecycle.moved(owner, source, target);
      // A rename may change what identifies the file (the change time, where a
      // filesystem has no birth time); the shares follow the file, not the stamp.
      await this.#lifecycle.rebind(owner, target, confirmed);
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

/**
 * Whether this write says which version it is an edit of.
 *
 * One answer for both forms, because two places asking it separately is how the
 * create guard in `putNote` and the conflict check below would come to disagree
 * about what "an edit" is. A non-positive `baseMtimeMs` is not a version: it is
 * what a client sends when it has none.
 */
function namesAVersion(options: PutOptions): boolean {
  if (options.baseHash !== undefined) return true;
  return options.baseMtimeMs !== undefined && options.baseMtimeMs > 0;
}

function titleOf(notePath: string): string {
  const base = notePath.slice(notePath.lastIndexOf('/') + 1);
  return base.slice(0, -NOTE_EXTENSION.length);
}

function lockKey(owner: string, notePath: string): string {
  return `${owner}:${caseKey(notePath)}`;
}
