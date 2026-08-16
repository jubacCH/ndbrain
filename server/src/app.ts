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
import { addTag, removeTag } from './markdown/edit.js';
import { proposeFor, type TopicProposal } from './notes/topics.js';
import { parseNote } from './markdown/parse.js';
import type { Note, NoteService, PutOptions, PutResult } from './notes/service.js';
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
import { InvalidPathError, NotAFileError, NoteNotFoundError } from './errors.js';

export interface RenameResult {
  note: Note;
  /** Notes whose links were rewritten to follow the move. */
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

export class App {
  readonly notes: NoteService;
  readonly indexer: Indexer;
  readonly queries: Queries;
  readonly #db: Database;

  constructor(db: Database, notes: NoteService, indexer: Indexer) {
    this.#db = db;
    this.notes = notes;
    this.indexer = indexer;
    this.queries = new Queries(db);
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

  async readFile(owner: string, filePath: string): Promise<Buffer> {
    return this.notes.vault.readFileBytes(owner, filePath);
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
  ): Promise<{ path: string; size: number; replaced: boolean }> {
    const canonical = normalizeVaultPath(filePath);
    const replaced = await this.notes.vault.exists(owner, canonical);

    if (isNotePath(canonical) && !replaced) assertLinkableName(canonical);

    await this.notes.vault.writeFileBytes(owner, canonical, bytes);

    if (isNotePath(canonical)) {
      await this.indexer.indexNote(owner, canonical);
      this.indexer.resolveLinks(owner);
      this.#recordEdit(owner, canonical, replaced ? 'update' : 'create', actor);
    }

    return { path: canonical, size: bytes.length, replaced };
  }

  async deleteFile(owner: string, filePath: string, actor?: string): Promise<void> {
    const canonical = normalizeVaultPath(filePath);

    if (isNotePath(canonical)) {
      await this.deleteNote(owner, canonical, actor);
      return;
    }

    await this.notes.vault.deleteNote(owner, canonical);
    await this.notes.vault.pruneEmptyDirs(owner, canonical);
  }

  async deleteNote(owner: string, notePath: string, actor?: string): Promise<void> {
    await this.notes.deleteNote(owner, notePath);
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
   * Order matters. Links are rewritten *before* the file moves: the backlink
   * index still points at the old path at that moment, and reversing the order
   * would mean searching for links to a note that no longer exists.
   *
   * Each source note is rewritten by replacing the exact `[[…]]` text at its
   * recorded offset, back to front so earlier offsets stay valid. Replacing by
   * search-and-replace would also hit occurrences inside code blocks, which the
   * parser deliberately does not treat as links.
   */
  async renameNote(owner: string, from: string, to: string, actor?: string): Promise<RenameResult> {
    const source = normalizeVaultPath(from);
    const target = normalizeVaultPath(to);

    if (!isNotePath(source) || !isNotePath(target)) {
      throw new InvalidPathError(`a note path must end in ${NOTE_EXTENSION}`);
    }

    if (source === target) {
      return { note: await this.notes.getNote(owner, source), updatedLinks: [] };
    }

    // Owner's own vault on both sides, even when the person doing the renaming is
    // someone the folder was shared with: a rename must never rewrite a line in a
    // third party's file. Links do not cross vaults, so there is nothing outside
    // this owner that could have needed following anyway.
    const referrers = [
      ...new Set(this.queries.backlinks(owner, owner, source).map((l) => l.source)),
    ];
    const updated: string[] = [];

    for (const referrer of referrers) {
      // A note that links to itself is handled after the move, together with its
      // own reindex — rewriting it here would be undone by the move.
      if (referrer === source) continue;

      const rewritten = await this.#rewriteLinksIn(owner, referrer, source, target);
      if (rewritten) updated.push(referrer);
    }

    const note = await this.notes.renameNote(owner, source, target);

    // The moved note may contain links to itself under the old name.
    if (referrers.includes(source)) {
      const selfRewritten = await this.#rewriteLinksIn(owner, target, source, target);
      if (selfRewritten) updated.push(target);
    }

    this.indexer.removeNote(owner, source);
    await this.indexer.indexNote(owner, target);
    for (const path of updated) {
      await this.indexer.indexNote(owner, path);
    }
    this.indexer.resolveLinks(owner);
    this.#recordEdit(owner, target, 'rename', actor);

    return { note: await this.notes.getNote(owner, target), updatedLinks: updated };
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

  /** Moves a selection into a folder, rewriting the links that follow them. */
  async bulkMove(
    owner: string,
    paths: string[],
    targetDir: string,
    actor?: string,
  ): Promise<BulkResult> {
    const folder = targetDir.replace(/^\/+|\/+$/g, '');

    return this.#overSelection(paths, async (notePath) => {
      const name = notePath.slice(notePath.lastIndexOf('/') + 1);
      const target = folder === '' ? name : `${folder}/${name}`;
      if (target === notePath) return notePath;

      const { note } = await this.renameNote(owner, notePath, target, actor);
      return note.path;
    });
  }

  /** Adds a tag to a selection. Notes that already carry it are left untouched. */
  async bulkTag(owner: string, paths: string[], tag: string, actor?: string): Promise<BulkResult> {
    return this.#overSelection(paths, async (notePath) => {
      const note = await this.notes.getNote(owner, notePath);
      const updated = addTag(note.content, tag);

      // Unchanged means the tag was already there. Writing anyway would bump the
      // modification date and make an untouched note look edited.
      if (updated !== note.content) {
        await this.updateNote(owner, notePath, updated, actor);
      }
      return notePath;
    });
  }

  async bulkUntag(owner: string, paths: string[], tag: string, actor?: string): Promise<BulkResult> {
    return this.#overSelection(paths, async (notePath) => {
      const note = await this.notes.getNote(owner, notePath);
      const updated = removeTag(note.content, tag);
      if (updated !== note.content) {
        await this.updateNote(owner, notePath, updated, actor);
      }
      return notePath;
    });
  }

  async bulkDelete(owner: string, paths: string[], actor?: string): Promise<BulkResult> {
    return this.#overSelection(paths, async (notePath) => {
      await this.deleteNote(owner, notePath, actor);
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
   */
  async renameFolder(
    owner: string,
    from: string,
    to: string,
    actor?: string,
  ): Promise<{ folder: string; movedNotes: string[]; updatedLinks: string[] }> {
    const source = normalizeVaultPath(from);
    const target = normalizeVaultPath(to);

    if (isNotePath(source) || isNotePath(target)) {
      throw new InvalidPathError('a folder name may not end in .md');
    }
    if (source === target) {
      return { folder: source, movedNotes: [], updatedLinks: [] };
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
      const temporary = `${source}.${Date.now().toString(36)}.tmp`;
      const first = await this.renameFolder(owner, source, temporary, actor);
      const second = await this.renameFolder(owner, temporary, target, actor);
      return {
        folder: target,
        movedNotes: second.movedNotes,
        updatedLinks: [...new Set([...first.updatedLinks, ...second.updatedLinks])],
      };
    }

    const inside = (p: string): boolean => p === source || p.startsWith(`${source}/`);
    const rebase = (p: string): string => `${target}${p.slice(source.length)}`;

    // Recorded before anything moves: afterwards the old tree is gone.
    const subdirs = (await this.notes.listDirs(owner)).filter(inside);
    const notes = (await this.notes.listNotes(owner)).map((n) => n.path).filter(inside);

    const movedNotes: string[] = [];
    const updatedLinks = new Set<string>();

    for (const notePath of notes) {
      const result = await this.renameNote(owner, notePath, rebase(notePath), actor);
      movedNotes.push(result.note.path);
      for (const link of result.updatedLinks) updatedLinks.add(link);
    }

    // Whatever the note moves did not carry: the folder itself when it held no
    // notes, and any empty subfolder below it.
    for (const dir of subdirs) {
      await this.notes.vault.createDir(owner, rebase(dir));
    }
    // Deepest first, so a parent is only removed once its children are gone.
    for (const dir of [...subdirs].sort((a, b) => b.length - a.length)) {
      await this.notes.vault.removeDirIfEmpty(owner, dir);
    }

    return { folder: target, movedNotes, updatedLinks: [...updatedLinks] };
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
    const dirs: DirRow[] = [];

    for (const scope of view) {
      for (const dir of await this.notes.listDirs(scope.owner)) {
        // `${dir}/` so a shared `Homelab` does not also surface `Homelab2`.
        if (scope.prefix === '' || `${dir}/`.startsWith(scope.prefix)) {
          dirs.push({ owner: scope.owner, path: dir });
        }
      }
    }

    return { notes: this.queries.recentNotes(view, 100_000), dirs };
  }
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
