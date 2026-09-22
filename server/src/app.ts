/**
 * The application core: every operation that changes a vault, with the index kept
 * in step.
 *
 * `NoteService` owns the files and `Indexer` owns the index; something has to own
 * the pair, or callers end up writing a file and forgetting to reindex it. The
 * HTTP layer and, later, the MCP endpoint both go through here — they differ in
 * how a request arrives, never in what a write means.
 */

import type { Indexer } from './index/indexer.js';
import { Queries, toView, type NoteRow, type Viewable } from './index/queries.js';
import { inScope, shareTarget, type Share, type ShareKind, type ShareService } from './auth/shares.js';
import { addTag, removeTag } from './markdown/edit.js';
import { toggleTask as applyTaskToggle, type TaskExpectation } from './markdown/tasks.js';
import { proposeFor, type TopicProposal } from './notes/topics.js';
import { parseNote } from './markdown/parse.js';
import type {
  AppendOptions,
  Authorized,
  Note,
  NoteService,
  PutOptions,
  PutResult,
  RenameOptions,
} from './notes/service.js';
import { NoteBindings } from './auth/noteBindings.js';
import type { Database } from './db/database.js';
import type { VaultFile } from './vault/fs.js';
import {
  assertLinkableName,
  caseKey,
  isNotePath,
  NOTE_EXTENSION,
  normalizeVaultPath,
  noteTitle,
} from './vault/paths.js';
import { InvalidPathError, NotAFileError, NoteNotFoundError, TaskChangedError } from './errors.js';

export interface RenameResult {
  note: Note;
  /**
   * Notes whose links were rewritten to follow the move — restricted to the
   * ones the caller may read. See `renameNote` for why the list is reported
   * narrower than the rewrite it describes.
   */
  updatedLinks: string[];
}

export type EditAction = 'create' | 'update' | 'delete' | 'rename';

/** A folder in the tree, with the vault it belongs to. */
export interface DirRow {
  owner: string;
  path: string;
}

export interface BulkResult {
  /** Final paths of the notes that succeeded — a move changes the path. */
  ok: string[];
  failed: Array<{ path: string; reason: string }>;
}

export interface FolderRenameResult {
  /** Where the folder ended up. */
  folder: string;
  /** Final paths of the notes that made it, bounded by the caller's view. */
  movedNotes: string[];
  /** Final paths of the attachments that made it, bounded the same way. */
  movedFiles: string[];
  /** Notes whose links were rewritten to follow the move. */
  updatedLinks: string[];
  /**
   * What stayed behind, at the path it really has now, and why.
   *
   * A folder move is not a transaction — see `renameFolder`. Without this the
   * caller learned of a partial move only through an exception that also threw
   * away the list of what had already succeeded.
   */
  failed: Array<{ path: string; reason: string }>;
}

/**
 * How many files a folder move is willing to look at before it refuses.
 *
 * The same ceiling the file listing uses. High enough that no real vault meets
 * it, and a refusal is the only safe answer if one does: a partial listing
 * would move part of a folder and report it as the whole of it.
 */
const LISTING_CEILING = 100_000;

/** The message to record for something that would not move. */
function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

export class App {
  readonly notes: NoteService;
  readonly indexer: Indexer;
  readonly queries: Queries;
  readonly shares: ShareService;
  readonly #db: Database;

  /** Which file each note share names; see `NoteBindings`. */
  readonly bindings: NoteBindings;

  constructor(db: Database, notes: NoteService, indexer: Indexer, shares: ShareService) {
    this.#db = db;
    this.notes = notes;
    this.indexer = indexer;
    this.shares = shares;
    this.queries = new Queries(db);
    this.bindings = new NoteBindings(shares, notes.vault);
  }

  /* ---- shares -----------------------------------------------------------
   *
   * Who may see what is decided in `ShareService`. What lives here is the part
   * that needs the vault: a note share must name a note that is there, and
   * must go when the note does.
   */

  /**
   * Grants a share on `owner`'s vault — a person's own, or a space's.
   *
   * A note share is only granted on a note that exists under exactly that
   * name, checked and granted under the note's own write lock. Checked outside
   * it, a delete landing between the look and the insert would leave a share
   * on a path with nothing behind it, waiting for the next note of that name.
   * A missing note answers like every other missing note.
   */
  async grantShare(
    owner: string,
    grantee: string,
    target: string | { kind: ShareKind; path: string },
    canWrite: boolean,
  ): Promise<Share> {
    const resolved = shareTarget(target);
    if (resolved.kind !== 'note') return this.shares.grant(owner, target, grantee, canWrite);

    return this.notes.withLock(owner, resolved.prefix, async () => {
      if (!(await this.notes.exists(owner, resolved.prefix))) {
        throw new NoteNotFoundError('note does not exist');
      }
      // Whatever the other shares on this path were bound to is confirmed
      // first: a share given today must not make an older one's stale binding
      // look current, nor be withdrawn for a replacement that came before it.
      await this.bindings.confirm(owner, resolved.prefix);
      const share = this.shares.grant(owner, { kind: 'note', path: resolved.prefix }, grantee, canWrite);
      await this.bindings.bindAll(owner, resolved.prefix);
      return share;
    });
  }

  /**
   * A note vanished without going through ndBrain — the watcher saw it go.
   *
   * Its note shares are withdrawn, not kept for whatever turns up under that
   * name next: from outside, "deleted and recreated" and "replaced by some
   * other file" look identical, and only one of them would be safe to carry a
   * grant over to.
   */
  noteVanished(owner: string, notePath: string): void {
    this.shares.dropNote(owner, notePath);
  }

  /**
   * A note's file changed without going through ndBrain — the watcher saw a
   * `change`. Whether it is the same note edited or a different file under the
   * same name, only the file can say; see `NoteBindings.confirm`.
   */
  async noteChanged(owner: string, notePath: string): Promise<void> {
    if (this.shares.noteBindings(owner, notePath).length === 0) return;
    await this.notes.withLock(owner, notePath, () => this.bindings.confirm(owner, notePath));
  }

  /**
   * Withdraws note shares whose note is gone or was replaced, for everything
   * the watcher's events did not report.
   *
   * Each one is looked at under its note's lock, so a rename, a create or a
   * save in flight is seen either before or after, never half-done.
   */
  async dropDanglingShares(owner: string): Promise<void> {
    for (const notePath of this.shares.notePaths(owner)) {
      await this.notes.withLock(owner, notePath, () => this.bindings.confirm(owner, notePath));
    }
  }

  /**
   * Records who changed what.
   *
   * `actor` defaults to the owner because a person editing their own vault is
   * the ordinary case; agents will pass their key name instead. Failing to log
   * must never fail the write — the note is the valuable thing, the log entry is
   * not.
   */
  #recordEdit(owner: string, notePath: string, action: EditAction, actor?: string): void {
    try {
      this.#db.run(
        'INSERT INTO edits (owner, path, actor, action, at) VALUES (?, ?, ?, ?, ?)',
        owner,
        notePath,
        actor ?? owner,
        action,
        Date.now(),
      );
    } catch {
      // Intentionally swallowed; see above.
    }
  }

  async createNote(owner: string, notePath: string, content = '', actor?: string): Promise<Note> {
    const note = await this.notes.createNote(owner, notePath, content);
    await this.indexer.indexNote(owner, note.path);
    this.#recordEdit(owner, note.path, 'create', actor);
    return note;
  }

  async updateNote(
    owner: string,
    notePath: string,
    content: string,
    actor?: string,
    options: PutOptions = {},
  ): Promise<PutResult> {
    const result = await this.notes.updateNote(owner, notePath, content, options);
    await this.indexer.indexNote(owner, result.note.path);
    this.#recordEdit(owner, result.note.path, 'update', actor);
    await this.#recordConflictCopy(owner, result, actor);
    return result;
  }

  /**
   * A displaced version is indexed and logged like any other note.
   *
   * A conflict copy the search cannot find is a file somebody discovers months
   * later in a folder and cannot explain.
   */
  async #recordConflictCopy(owner: string, result: PutResult, actor?: string): Promise<void> {
    if (result.conflictCopy === undefined) return;
    await this.indexer.indexNote(owner, result.conflictCopy);
    this.#recordEdit(owner, result.conflictCopy, 'create', actor);
  }

  /**
   * Creates a note only if nothing is there yet; see `NoteService.createNoteIfAbsent`.
   *
   * Indexed and logged only when it wrote. A call that found the note is a read,
   * and recording it as a create would put a second "new note" into today's
   * counts for every extra click on the button.
   */
  async createNoteIfAbsent(
    owner: string,
    notePath: string,
    content: string,
    actor?: string,
    options: Authorized = {},
  ): Promise<PutResult> {
    const result = await this.notes.createNoteIfAbsent(owner, notePath, content, options);
    if (result.created) {
      await this.indexer.indexNote(owner, result.note.path);
      this.#recordEdit(owner, result.note.path, 'create', actor);
    }
    return result;
  }

  /**
   * Adds text to a note; see `NoteService.appendNote` for why it is one call.
   *
   * Logged as a create or an update by what actually happened, so a capture
   * that started today's note counts as one new note and every later one as an
   * edit of it — the same distinction `putNote` draws.
   */
  async appendNote(
    owner: string,
    notePath: string,
    addition: string,
    actor?: string,
    options: AppendOptions = {},
  ): Promise<PutResult> {
    const result = await this.notes.appendNote(owner, notePath, addition, options);
    await this.indexer.indexNote(owner, result.note.path);
    this.#recordEdit(owner, result.note.path, result.created ? 'create' : 'update', actor);
    return result;
  }

  /** Create-or-update in one call; see `NoteService.putNote` for why it is one call. */
  async putNote(
    owner: string,
    notePath: string,
    content: string,
    actor?: string,
    options: PutOptions = {},
  ): Promise<PutResult> {
    const result = await this.notes.putNote(owner, notePath, content, options);
    await this.indexer.indexNote(owner, result.note.path);
    this.#recordEdit(owner, result.note.path, result.created ? 'create' : 'update', actor);
    await this.#recordConflictCopy(owner, result, actor);
    return result;
  }

  /**
   * Flips one task's checkbox, verified against the line it is expected to
   * still be.
   *
   * The task list addresses a task by path and file-relative line number, and
   * both come from whatever answer the client last loaded — which can be
   * stale by the time somebody clicks. `applyTaskToggle` re-parses the note
   * fresh and refuses when the line no longer holds the exact task (same text,
   * same done state); this is the same "verify or refuse, never guess" rule
   * `edit_note` already applies to MCP edits, applied here to the one write
   * this view is allowed to make.
   *
   * Goes through `updateNote` like every other write — this is not a second
   * write path, only a second way of computing the next `content` before
   * handing it to the one that exists. `baseHash` is set from the same read the
   * toggle was checked against, so a write landing in the gap between that read
   * and this one still produces a conflict copy instead of overwriting it.
   */
  async toggleTask(
    owner: string,
    notePath: string,
    line: number,
    expected: TaskExpectation,
    done: boolean,
    actor?: string,
    options: Authorized = {},
  ): Promise<PutResult> {
    // Read the way the write path reads: this answer is made of the file's
    // content — the note in a 200, and the 409 that says the expected task is
    // not on that line, which asks the file a yes/no question about its text.
    const note = await this.readAuthorized(owner, notePath, options.authorize);
    const result = applyTaskToggle(note.content, line, expected, done);

    if (!result.ok) {
      throw new TaskChangedError(
        'that task has changed since the list was loaded — reload the task list and try again',
      );
    }

    // Already in the requested state: nothing to write, and writing anyway
    // would bump the note's modified time for a change that never happened.
    if (result.content === note.content) {
      return { note, created: false };
    }

    const write: PutOptions = { baseHash: note.hash };
    if (options.authorize !== undefined) write.authorize = options.authorize;
    return this.updateNote(owner, notePath, result.content, actor, write);
  }

  /**
   * A note's content, read as the write path sees it.
   *
   * The lock, then `confirm`, then the caller's permission, then the bytes. A
   * read that reaches the file directly would answer out of a file replaced
   * behind ndBrain's back in the moment before the watcher says so — which is
   * the whole of what a note share protects against. For an owner reading their
   * own vault `authorize` is absent and `confirm` finds no note share, so this
   * is the plain read it always was.
   */
  async readAuthorized(owner: string, notePath: string, authorize?: () => void): Promise<Note> {
    return this.notes.withLock(owner, notePath, async () => {
      await this.bindings.confirm(owner, notePath);
      authorize?.();
      return this.notes.getNote(owner, notePath);
    });
  }

  /* ---- topics -------------------------------------------------------------
   *
   * A one-off migration offered as a tool rather than performed on somebody's
   * behalf. See notes/topics.ts for why the parsing is deliberately narrow and
   * why nothing here removes the line it read.
   */

  /** What the metadata lines in this vault would contribute, if applied. */
  async topicProposals(owner: string): Promise<TopicProposal[]> {
    const out: TopicProposal[] = [];
    for (const entry of await this.notes.listNotes(owner)) {
      const note = await this.notes.getNote(owner, entry.path);
      const proposal = proposeFor(entry.path, noteTitle(entry.path), note.content);
      if (proposal !== null) out.push(proposal);
    }
    return out;
  }

  /**
   * Adds the proposed tags to the named notes.
   *
   * Re-derived rather than taking the tags from the request: a proposal the
   * client is holding may be minutes old, and writing tags a client sends would
   * make this endpoint a way to put arbitrary words into a note. The client
   * chooses *which notes*; the server decides what that means.
   */
  async applyTopics(owner: string, paths: string[], actor?: string): Promise<{ path: string; added: string[] }[]> {
    const wanted = new Set(paths.map((path) => normalizeVaultPath(path)));
    const done: { path: string; added: string[] }[] = [];

    for (const proposal of await this.topicProposals(owner)) {
      if (!wanted.has(proposal.path)) continue;

      const note = await this.notes.getNote(owner, proposal.path);
      let content = note.content;
      for (const tag of proposal.proposed) content = addTag(content, tag);
      if (content === note.content) continue;

      await this.putNote(owner, proposal.path, content, actor);
      done.push({ path: proposal.path, added: proposal.proposed });
    }
    return done;
  }

  /* ---- files -------------------------------------------------------------
   *
   * A vault is a folder of files, and until now the tool could only see the
   * `.md` ones. Everything else — a screenshot pasted next to a note, a PDF, a
   * config dump — existed on disk and was invisible and unreachable, which also
   * meant unremovable through the tool that owns the folder.
   *
   * These four go through `App` rather than straight to `Vault` for the same
   * reason note writes do: uploading a `.md` has to reach the index, or the note
   * would exist on disk and be unfindable by search until the watcher happened
   * to notice. Everything that is not a note skips the index entirely — there is
   * nothing in a PNG for full-text search to hold.
   */

  async listFiles(
    owner: string,
    limit?: number,
  ): Promise<{ files: VaultFile[]; dirs: string[]; truncated: boolean }> {
    return this.notes.vault.listAll(owner, limit);
  }

  /**
   * The files of `owner`'s vault that `view` may read, and the folders around
   * them — for a grantee's file browser.
   *
   * The same regions as every note query (`inScope`), so a file listing never
   * says more than the tree: a folder share lists what lies below the folder,
   * a note share lists its one note if it is there. A folder is named when a
   * folder or vault share covers it, or when it lies on the path to something
   * listed; an empty folder beside a shared note is not.
   *
   * The walk is bounded like the owner's own listing, and `truncated` speaks
   * about what the caller may see — not about the size of the vault behind it.
   * It also speaks about the walk: a vault larger than the walk's own ceiling
   * ends the listing early, and reporting that as complete would say the files
   * left out are not there.
   *
   * Takes the caller rather than a ready-made view, because the bindings are
   * confirmed first and the confirmation may withdraw a share the view would
   * still be carrying.
   */
  async listFilesIn(
    caller: string,
    owner: string,
    limit = 5000,
  ): Promise<{ files: VaultFile[]; dirs: string[]; truncated: boolean } | null> {
    // A note share names a file, and this listing describes files: until the
    // watcher reports a replacement, the size and the modification time here
    // would be the stranger's. The same refusal a read of the note itself
    // makes, through the other door.
    for (const notePath of this.shares.noteSharePaths(caller, owner)) {
      await this.noteChanged(owner, notePath);
    }

    const regions = this.shares.view(caller).filter((scope) => scope.owner === owner);
    if (regions.length === 0) return null;

    const all = await this.notes.vault.listAll(owner, 100_000);
    const visible = all.files.filter((file) => regions.some((region) => inScope(region, file.path)));
    const files = visible.slice(0, limit);

    const dirs = new Set<string>();
    const withAncestors = (dir: string): void => {
      const segments = dir.split('/');
      for (let i = 1; i <= segments.length; i += 1) dirs.add(segments.slice(0, i).join('/'));
    };
    for (const dir of all.dirs) {
      if (regions.some((region) => !region.exact && inScope(region, `${dir}/`))) withAncestors(dir);
    }
    for (const file of files) {
      const at = file.path.lastIndexOf('/');
      if (at > 0) withAncestors(file.path.slice(0, at));
    }

    return {
      files,
      dirs: [...dirs].sort((a, b) => a.localeCompare(b)),
      truncated: visible.length > limit || all.truncated,
    };
  }

  async readFile(owner: string, filePath: string): Promise<Buffer> {
    return this.notes.vault.readFileBytes(owner, filePath);
  }

  /**
   * Where a file really is on disk, for a caller that means to stream it.
   *
   * `readFile` is how you get a file's bytes; this is how you get at them
   * without holding them, and the export route is the reason it exists — an
   * archive of a whole vault must not be the size of the vault in memory.
   * Containment is checked exactly as a read checks it, so a symlink pointing
   * out of the vault is refused here too.
   */
  async fileOnDisk(owner: string, filePath: string): Promise<string> {
    return this.notes.vault.resolve(owner, filePath);
  }

  /**
   * Writes any file, and indexes it when it is a note.
   *
   * `assertLinkableName` is applied to notes only, and only here where the name
   * is being *chosen*. An imported vault may legitimately be full of names no
   * wikilink can reach; refusing those on the way in would lose files rather
   * than protect anything. But a name typed into this tool today is a name the
   * tool can still talk somebody out of.
   */
  async writeFile(
    owner: string,
    filePath: string,
    bytes: Buffer,
    actor?: string,
    options: Authorized = {},
  ): Promise<{ path: string; size: number; replaced: boolean }> {
    const canonical = normalizeVaultPath(filePath);

    // A note arriving as a file is still a note appearing: it takes the note's
    // lock, and a new one inherits no share that once named its path.
    const write = async (): Promise<boolean> => {
      const existed = await this.notes.vault.exists(owner, canonical);
      const note = isNotePath(canonical);
      if (note && !existed) assertLinkableName(canonical);
      // As for every write over a note: shares given for some other file are
      // withdrawn before the bytes land, and only the confirmed ones follow.
      const confirmed = note && existed ? await this.bindings.confirm(owner, canonical) : null;
      options.authorize?.();
      await this.notes.vault.writeFileBytes(owner, canonical, bytes);
      if (note && !existed) this.shares.dropNote(owner, canonical);
      if (note && existed) await this.bindings.rebind(owner, canonical, confirmed);
      return existed;
    };
    const replaced = isNotePath(canonical)
      ? await this.notes.withLock(owner, canonical, write)
      : await write();

    if (isNotePath(canonical)) {
      await this.indexer.indexNote(owner, canonical);
      this.indexer.resolveLinks(owner);
      this.#recordEdit(owner, canonical, replaced ? 'update' : 'create', actor);
    }

    return { path: canonical, size: bytes.length, replaced };
  }

  async deleteFile(owner: string, filePath: string, actor?: string, options: Authorized = {}): Promise<void> {
    const canonical = normalizeVaultPath(filePath);

    if (isNotePath(canonical)) {
      await this.deleteNote(owner, canonical, actor, options);
      return;
    }

    await this.notes.vault.deleteNote(owner, canonical);
    await this.notes.vault.pruneEmptyDirs(owner, canonical);
  }

  async deleteNote(owner: string, notePath: string, actor?: string, options: Authorized = {}): Promise<void> {
    await this.notes.deleteNote(owner, notePath, options);
    const canonical = normalizeVaultPath(notePath);
    this.indexer.removeNote(owner, canonical);
    this.indexer.resolveLinks(owner);
    this.#recordEdit(owner, canonical, 'delete', actor);
  }

  /**
   * Renames or moves a note and rewrites every `[[wikilink]]` that pointed at it.
   *
   * Scheduled here rather than in a later phase on purpose: as soon as the tool is
   * used daily, notes get renamed, and a rename without this quietly turns working
   * links into dead ones. That is data damage discovered weeks later, which is why
   * it counts as correctness rather than convenience.
   *
   * Order matters, and it is: read who links here, **move**, then rewrite.
   *
   * The backlink index still points at the old path until the move is indexed,
   * so the question "who links to this note" has to be asked before the move —
   * but only asked. Rewriting before it meant that a move refused in the lock
   * (a note share withdrawn by `confirm`, a destination already taken) left
   * every referrer in the owner's vault pointing at a path nothing was ever
   * moved to, and left them unindexed on top, because the reindex is at the
   * end. A broken link somebody can repair; half a rename is not something
   * they can even see. So the rewrite is now the part that only happens once
   * the file has really moved.
   *
   * Each source note is rewritten by replacing the exact `[[…]]` text at its
   * recorded offset, back to front so earlier offsets stay valid. Replacing by
   * search-and-replace would also hit occurrences inside code blocks, which the
   * parser deliberately does not treat as links.
   *
   * **`view` bounds what is reported, never what is rewritten.** The rewrite has
   * to cover the whole vault or the owner is left with dead links, but the list
   * of notes it touched is a set of paths derived from links — the same thing a
   * backlink list is, and it obeys the same boundary. A grantee of one folder
   * renaming a note in it was handed `Privat/Heimlich.md` in this field: a full
   * path out of the private half of somebody else's vault, for free, on a write
   * she was entitled to make.
   *
   * The **count** is filtered rather than dropped, because it is derived from
   * the filtered list and not computed separately. "Links updated in 2 notes"
   * where only one is nameable would say the second exists — the leak the node
   * degree in `graph()` had. Reported as the length of what is named, the number
   * says exactly as much as the list, which is what the caller could already
   * count for herself from `/api/v1/backlinks`. Suppressing it entirely would
   * take a real piece of feedback away from the owner — whose view is the whole
   * vault, and who is nearly always the person renaming — to protect nothing.
   *
   * Absence carries no information here either: the notes left out are precisely
   * the ones `backlinks` would already have left out, so a rename tells the
   * caller nothing a read did not.
   *
   * **`view` is required, and named rather than positional.** It began as an
   * optional parameter defaulting to the owner's own vault, on the argument that
   * every internal caller renames inside one — which was simply wrong.
   * `bulkMove` renames on behalf of whoever sent the request, `owner` included
   * in the body, and it took the default silently: the filter was off for every
   * bulk move a grantee made. Nothing leaked, because `BulkResult` happens not
   * to carry the list — which is safety by throwing the answer away, and lasts
   * exactly until somebody adds a field.
   *
   * Making it a required *positional* parameter was not enough, and that is why
   * it is an object. `Viewable` is `string | View`, and `actor` is a string, so
   * the existing `bulkMove(owner, paths, dir, caller)` went on compiling with
   * the caller's name silently rebound as the view and the actor lost — a wrong
   * answer and a wrong audit entry, from a call nobody had to touch. Two
   * interchangeable string parameters next to each other are a trap whoever
   * reorders them next falls into; named ones cannot be swapped by accident.
   */
  async renameNote(
    owner: string,
    from: string,
    to: string,
    options: {
      view: Viewable;
      actor?: string;
      /** Re-checked in the lock, after `confirm`; see `Authorized`. */
      authorizeSource?: () => void;
      authorizeTarget?: () => void;
    },
  ): Promise<RenameResult> {
    const { view, actor, authorizeSource, authorizeTarget } = options;
    const source = normalizeVaultPath(from);
    const target = normalizeVaultPath(to);

    if (!isNotePath(source) || !isNotePath(target)) {
      throw new InvalidPathError(`a note path must end in ${NOTE_EXTENSION}`);
    }

    // Renaming a note to its own name is a read of it — the note comes back in
    // the answer — so it is read like one.
    if (source === target) {
      return { note: await this.readAuthorized(owner, source, authorizeSource), updatedLinks: [] };
    }

    // Owner's own vault on both sides, even when the person doing the renaming is
    // someone the folder was shared with: a rename must never rewrite a line in a
    // third party's file. Links do not cross vaults, so there is nothing outside
    // this owner that could have needed following anyway.
    const referrers = [
      ...new Set(this.queries.backlinks(owner, owner, source).map((l) => l.source)),
    ];

    const move: RenameOptions = {};
    if (authorizeSource !== undefined) move.authorizeSource = authorizeSource;
    if (authorizeTarget !== undefined) move.authorizeTarget = authorizeTarget;
    const note = await this.notes.renameNote(owner, source, target, move);

    const updated: string[] = [];
    for (const referrer of referrers) {
      // A note that links to itself has moved with the rest: its links are at
      // the new path now, and so is the one pointing at its own old name.
      const at = referrer === source ? target : referrer;
      const rewritten = await this.#rewriteLinksIn(owner, at, source, target);
      if (rewritten) updated.push(at);
    }

    this.indexer.removeNote(owner, source);
    await this.indexer.indexNote(owner, target);
    for (const path of updated) {
      // The moved note itself is already indexed, above, with its self-link
      // rewritten — every rewrite happens before any of this.
      if (path !== target) await this.indexer.indexNote(owner, path);
    }
    this.indexer.resolveLinks(owner);
    this.#recordEdit(owner, target, 'rename', actor);

    return {
      note: await this.notes.getNote(owner, target),
      updatedLinks: visibleIn(view, owner, updated),
    };
  }

  /** Rewrites links in one note. Returns whether anything changed. */
  async #rewriteLinksIn(
    owner: string,
    notePath: string,
    oldTarget: string,
    newTarget: string,
  ): Promise<boolean> {
    const note = await this.notes.getNote(owner, notePath);
    const parsed = parseNote(note.content);

    const replacements = parsed.wikilinks
      .filter((link) => pointsAt(link.target, oldTarget))
      .map((link) => ({
        offset: link.offset,
        length: link.raw.length,
        text: buildWikilink(link.target, newTarget, link.heading, link.alias),
      }))
      .sort((a, b) => b.offset - a.offset); // back to front keeps earlier offsets valid

    if (replacements.length === 0) return false;

    let content = note.content;
    for (const replacement of replacements) {
      content =
        content.slice(0, replacement.offset) +
        replacement.text +
        content.slice(replacement.offset + replacement.length);
    }

    await this.notes.updateNote(owner, notePath, content);
    return true;
  }

  /**
   * Runs an operation over a selection, reporting each note separately.
   *
   * Not a transaction, and deliberately so. Twenty notes where three fail must
   * leave seventeen done and say which three did not — rolling back seventeen
   * successful moves because of one name collision would be worse for the person
   * doing the tidying, who would have to start over with no idea which item was
   * the problem.
   *
   * Notes are processed in a stable order so that a rerun behaves the same way.
   */
  async #overSelection(
    paths: string[],
    run: (notePath: string) => Promise<string | undefined>,
  ): Promise<BulkResult> {
    const result: BulkResult = { ok: [], failed: [] };

    for (const notePath of [...paths].sort()) {
      try {
        const finalPath = await run(notePath);
        result.ok.push(finalPath ?? notePath);
      } catch (error) {
        result.failed.push({
          path: notePath,
          reason: error instanceof Error ? error.message : 'unbekannter Fehler',
        });
      }
    }

    return result;
  }

  /**
   * Moves a selection into a folder, rewriting the links that follow them.
   *
   * The only one of the four bulk actions that takes a view, because it is the
   * only one that rewrites links: it renames, and a rename reports which notes
   * it touched. The others return the caller's own selection back to her and
   * have nothing to bound. The view is the *caller's*, never the owner's — this
   * route accepts an `owner` in the body, so the two are routinely different
   * people.
   */
  async bulkMove(
    owner: string,
    paths: string[],
    targetDir: string,
    options: { view: Viewable; actor?: string; caller: string },
  ): Promise<BulkResult> {
    const folder = targetDir.replace(/^\/+|\/+$/g, '');
    const { caller } = options;

    return this.#overSelection(paths, async (notePath) => {
      const name = notePath.slice(notePath.lastIndexOf('/') + 1);
      const target = folder === '' ? name : `${folder}/${name}`;
      if (target === notePath) return notePath;

      // Both ends, for each note, on the path it would really have — the same
      // check a single rename makes. Asking about the folder instead, through
      // some stand-in note inside it, is answered "yes" by a share on exactly
      // that stand-in, and a grantee walks notes out of her folder with it.
      // A refusal reads like a missing note, as everywhere else.
      const authorizeSource = (): void => this.shares.check(caller, owner, notePath, 'write');
      const authorizeTarget = (): void => this.shares.check(caller, owner, target, 'write');
      authorizeSource();
      authorizeTarget();

      // And again inside the lock, once `confirm` has had its say about the
      // file on the source path — see `Authorized`. The caller is somebody
      // else's grantee here often enough that this is the ordinary case.
      const { note } = await this.renameNote(owner, notePath, target, {
        ...options,
        authorizeSource,
        authorizeTarget,
      });
      return note.path;
    });
  }

  /**
   * Adds a tag to a selection. Notes that already carry it are left untouched.
   *
   * `authorize` is a function of the path, because a bulk action is a list of
   * separate operations and each one asks about its own note — the same shape
   * the per-note permission check outside already has.
   */
  async bulkTag(
    owner: string,
    paths: string[],
    tag: string,
    actor?: string,
    authorize?: (notePath: string) => void,
  ): Promise<BulkResult> {
    return this.#overSelection(paths, async (notePath) => {
      const gate = authorize === undefined ? undefined : (): void => authorize(notePath);
      const note = await this.readAuthorized(owner, notePath, gate);
      const updated = addTag(note.content, tag);

      // Unchanged means the tag was already there. Writing anyway would bump the
      // modification date and make an untouched note look edited.
      if (updated !== note.content) {
        await this.updateNote(owner, notePath, updated, actor, gate === undefined ? {} : { authorize: gate });
      }
      return notePath;
    });
  }

  async bulkUntag(
    owner: string,
    paths: string[],
    tag: string,
    actor?: string,
    authorize?: (notePath: string) => void,
  ): Promise<BulkResult> {
    return this.#overSelection(paths, async (notePath) => {
      const gate = authorize === undefined ? undefined : (): void => authorize(notePath);
      const note = await this.readAuthorized(owner, notePath, gate);
      const updated = removeTag(note.content, tag);
      if (updated !== note.content) {
        await this.updateNote(owner, notePath, updated, actor, gate === undefined ? {} : { authorize: gate });
      }
      return notePath;
    });
  }

  async bulkDelete(
    owner: string,
    paths: string[],
    actor?: string,
    authorize?: (notePath: string) => void,
  ): Promise<BulkResult> {
    return this.#overSelection(paths, async (notePath) => {
      const gate = authorize === undefined ? undefined : (): void => authorize(notePath);
      await this.deleteNote(owner, notePath, actor, gate === undefined ? {} : { authorize: gate });
      return notePath;
    });
  }

  // ---- folders ------------------------------------------------------------
  //
  // Folders were second-class until now: they came into being when a note was
  // saved into them and vanished when the last one left. That is fine for a
  // vault that only grows, and wrong for one somebody keeps — a structure you
  // cannot prepare or correct is a structure you work around.

  /** Creates an empty folder. Idempotent: an existing folder is not an error. */
  async createFolder(owner: string, dirPath: string): Promise<string> {
    const canonical = normalizeVaultPath(dirPath);
    if (isNotePath(canonical)) {
      throw new InvalidPathError('a folder name may not end in .md');
    }
    await this.notes.vault.createDir(owner, canonical);
    return canonical;
  }

  /**
   * Renames or moves a folder, carrying its notes and their links with it.
   *
   * Deliberately not a single `rename(2)` on the directory. Every note inside
   * goes through `renameNote`, which is what rewrites the `[[wikilinks]]` that
   * pointed at it by path. Renaming the directory in one step would be faster
   * and would silently break every one of those links — the exact damage the
   * note-level rename exists to prevent, only multiplied by the size of the
   * folder.
   *
   * Empty subfolders are carried over separately afterwards: no note move would
   * have taken them, and losing them would quietly flatten a structure somebody
   * built on purpose.
   *
   * **Attachments come too.** The folder used to be walked with `listNotes`,
   * which reports `.md` and nothing else, so a screenshot or a PDF stayed
   * behind. That broke the arrangement the whole file layout rests on — an
   * attachment lives beside its note so that `![[rack.png]]` resolves against
   * the note's own folder without an index lookup — and it left the old folder
   * un-removable, because it was not empty. They are moved after the notes and
   * refuse to overwrite anything already standing at their target.
   *
   * **What happens when one note will not move.** It is reported, and the rest
   * still move. Not a transaction, and deliberately so, for the reason
   * `#overSelection` gives: undoing the moves that worked means undoing the
   * link rewrites they caused across the whole vault, and a rollback that
   * itself fails halfway has nowhere left to go. What is *not* acceptable is
   * the old behaviour, where the exception left `renameFolder` and took
   * `movedNotes` and `updatedLinks` with it: six notes moved, forty-four not,
   * and an answer that said only "a note already exists at that path".
   *
   * **Whose view, and why it is required.** `movedNotes` and `updatedLinks`
   * are both lists of paths, so a caller acting in somebody else's vault — a
   * member renaming a folder in a space — would leak the way `renameNote` once
   * did. Both are therefore reported through the caller's view. The larger
   * danger, a folder straddling the edge of a share so that the move writes
   * notes outside the grantee's region, is ruled out before this runs: the
   * route requires write access to the folder's own path at both ends, and
   * everything below a path inside a folder share is inside that share.
   */
  async renameFolder(
    owner: string,
    from: string,
    to: string,
    options: { view: Viewable; actor?: string },
  ): Promise<FolderRenameResult> {
    const source = normalizeVaultPath(from);
    const target = normalizeVaultPath(to);

    if (isNotePath(source) || isNotePath(target)) {
      throw new InvalidPathError('a folder name may not end in .md');
    }
    if (source === target) {
      return { folder: source, movedNotes: [], movedFiles: [], updatedLinks: [], failed: [] };
    }
    // Moving a folder into itself would move its own new location forever.
    if (target.startsWith(`${source}/`)) {
      throw new InvalidPathError('a folder cannot be moved inside itself');
    }
    if (!(await this.notes.vault.isDir(owner, source))) {
      throw new NoteNotFoundError('no such folder');
    }

    // A pure case change is the one move that cannot go directly: on Windows and
    // macOS the source and the target are the same directory, so every note
    // would collide with itself. Going through a name that collides with
    // neither turns it into two moves that are safe everywhere.
    if (caseKey(source) === caseKey(target)) {
      // Not `.tmp`. That suffix is reserved for the atomic-write temporaries the
      // watcher is told to skip, and a directory holding real notes for the
      // length of two passes is not one of those: the watcher ignored every
      // path under it while `reconcile` indexed them through `listNotes`, so
      // anything a failed second pass left behind was half-visible and nothing
      // ever came back for it. An ordinary name shows up in the tree, where the
      // person who asked for the rename can see it and finish the job by hand —
      // and `failed` names it outright.
      const temporary = `${source}.moving-${Date.now().toString(36)}`;
      const first = await this.renameFolder(owner, source, temporary, options);
      const second = await this.renameFolder(owner, temporary, target, options);
      return {
        folder: target,
        movedNotes: second.movedNotes,
        movedFiles: second.movedFiles,
        updatedLinks: [...new Set([...first.updatedLinks, ...second.updatedLinks])],
        // Each failure names the path the thing really has now: still under the
        // source name if the first pass could not take it, under the interim
        // name if the second could not.
        failed: [...first.failed, ...second.failed],
      };
    }

    const inside = (p: string): boolean => p === source || p.startsWith(`${source}/`);
    const rebase = (p: string): string => `${target}${p.slice(source.length)}`;

    // Recorded before anything moves: afterwards the old tree is gone. One walk
    // for both halves, because notes and attachments have to agree about what
    // was in the folder — `listNotes` alone was the bug.
    const subdirs = (await this.notes.listDirs(owner)).filter(inside);
    const listing = await this.notes.vault.listAll(owner, LISTING_CEILING);
    if (listing.truncated) {
      // A partial listing would move part of the folder and report it as the
      // whole of it, which is the failure this function is being fixed for.
      throw new NotAFileError('the vault is too large to move a folder safely');
    }
    const inFolder = listing.files.filter((file) => inside(file.path));
    const notes = inFolder.filter((file) => file.isNote).map((file) => file.path);
    const attachments = inFolder.filter((file) => !file.isNote).map((file) => file.path);

    const movedNotes: string[] = [];
    const movedFiles: string[] = [];
    const failed: { path: string; reason: string }[] = [];
    const updatedLinks = new Set<string>();

    for (const notePath of notes) {
      try {
        const result = await this.renameNote(owner, notePath, rebase(notePath), options);
        movedNotes.push(result.note.path);
        for (const link of result.updatedLinks) updatedLinks.add(link);
      } catch (error) {
        failed.push({ path: notePath, reason: reasonFor(error) });
      }
    }

    // After the notes, so that a note and the picture it embeds are never
    // separated for longer than one move, and before the folder shares below,
    // so that "the folder has moved" is true by the time they follow.
    for (const filePath of attachments) {
      try {
        await this.notes.vault.moveFile(owner, filePath, rebase(filePath));
        movedFiles.push(rebase(filePath));
      } catch (error) {
        failed.push({ path: filePath, reason: reasonFor(error) });
      }
    }

    // Note shares went along one note at a time, inside each note's lock.
    // Folder shares name the folder, so they follow once the folder has moved.
    // Until this line a grantee of the old folder sees the moved notes vanish
    // from it rather than appear somewhere they were not given.
    this.shares.moveFolder(owner, source, target);

    // Whatever the note moves did not carry: the folder itself when it held no
    // notes, and any empty subfolder below it.
    for (const dir of subdirs) {
      await this.notes.vault.createDir(owner, rebase(dir));
    }
    // Deepest first, so a parent is only removed once its children are gone.
    for (const dir of [...subdirs].sort((a, b) => b.length - a.length)) {
      await this.notes.vault.removeDirIfEmpty(owner, dir);
    }

    return {
      folder: target,
      movedNotes: visibleIn(options.view, owner, movedNotes),
      movedFiles: visibleIn(options.view, owner, movedFiles),
      updatedLinks: [...updatedLinks],
      // Bounded like the rest: a failure names a path, and a path in somebody
      // else's region is the same leak whether the move worked or not.
      failed: failed.filter((entry) => visibleIn(options.view, owner, [entry.path]).length === 1),
    };
  }

  /**
   * Removes a folder, but only when nothing is left in it.
   *
   * No recursive delete on purpose. "Delete this folder and the fourteen notes
   * you forgot were in it" is the one destructive action in this tool that
   * cannot be undone from the interface, and the bulk view already offers a way
   * to delete notes deliberately, with them listed in front of you.
   */
  async deleteFolder(owner: string, dirPath: string): Promise<void> {
    const canonical = normalizeVaultPath(dirPath);
    if (!(await this.notes.vault.isDir(owner, canonical))) {
      throw new NoteNotFoundError('no such folder');
    }
    if (!(await this.notes.vault.removeDirIfEmpty(owner, canonical))) {
      throw new NotAFileError('the folder is not empty');
    }
    this.shares.dropFolder(owner, canonical);
  }

  /**
   * Notes for the tree view: every note plus every directory the caller may see.
   *
   * Directories come from the filesystem rather than the index because an empty
   * folder has no notes to be derived from and would otherwise vanish from the
   * tree the moment its last note moved out. With sharing, that listing is done
   * per owner and then cut to the shared prefix — a folder above the shared one
   * would name a part of the vault the caller was not given.
   */
  async tree(viewable: Viewable): Promise<{ notes: NoteRow[]; dirs: DirRow[] }> {
    const view = toView(viewable);
    const notes = this.queries.recentNotes(view, 100_000);
    const dirs: DirRow[] = [];
    const seen = new Set<string>();
    const add = (owner: string, dir: string): void => {
      const key = `${owner}:${dir}`;
      if (seen.has(key)) return;
      seen.add(key);
      dirs.push({ owner, path: dir });
    };

    for (const scope of view) {
      if (scope.exact) {
        // A shared note brings the folders on its own path and nothing else.
        // They are read off the path of a note the caller can already see —
        // never off the filesystem — so a sibling, an empty folder or a
        // subfolder next to it changes nothing in this answer, and a share on
        // a note that is gone brings no folders at all.
        if (!notes.some((note) => note.owner === scope.owner && note.path === scope.prefix)) continue;
        const segments = scope.prefix.split('/').slice(0, -1);
        for (let i = 1; i <= segments.length; i += 1) add(scope.owner, segments.slice(0, i).join('/'));
        continue;
      }
      for (const dir of await this.notes.listDirs(scope.owner)) {
        // `${dir}/` so a shared `Homelab` does not also surface `Homelab2`.
        if (inScope(scope, `${dir}/`)) add(scope.owner, dir);
      }
    }

    return { notes, dirs };
  }
}

/**
 * The paths in `owner`'s vault that `view` is allowed to read.
 *
 * The counterpart, for a list a write path has already built in memory, of the
 * `scopeSql` fragment every read query carries. A write is entitled to reach
 * across the whole vault — that is what keeps the owner's links working — but
 * what it *reports* is answerable to the same boundary as a read, or the write
 * becomes the way around it.
 */
function visibleIn(viewable: Viewable, owner: string, paths: string[]): string[] {
  const view = toView(viewable);
  return paths.filter((notePath) =>
    view.some((scope) => scope.owner === owner && inScope(scope, notePath)),
  );
}

/** True if a link target, as written, refers to `notePath`. */
function pointsAt(written: string, notePath: string): boolean {
  const normalised = written.replace(/\.md$/i, '').toLowerCase();
  const withoutExtension = notePath.replace(/\.md$/i, '').toLowerCase();
  return normalised === withoutExtension || normalised === noteTitle(notePath).toLowerCase();
}

/**
 * Writes the replacement link in the same style the author used.
 *
 * Somebody who wrote `[[Proxmox]]` gets `[[Proxmox 2]]`, and somebody who wrote
 * `[[Homelab/Proxmox.md]]` keeps their path and their extension. Rewriting every
 * link into one canonical form would be tidier for us and rude to the person
 * whose notes these are.
 */
function buildWikilink(
  written: string,
  newTarget: string,
  heading: string | null,
  alias: string | null,
): string {
  const usedPath = written.includes('/');
  const usedExtension = /\.md$/i.test(written);

  let target = usedPath ? newTarget : noteTitle(newTarget);
  if (!usedExtension) target = target.replace(/\.md$/i, '');

  const parts = [target];
  if (heading !== null) parts.push(`#${heading}`);
  if (alias !== null) parts.push(`|${alias}`);
  return `[[${parts.join('')}]]`;
}
