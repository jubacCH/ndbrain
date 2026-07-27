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
import { Queries, type NoteRow } from './index/queries.js';
import { parseNote } from './markdown/parse.js';
import type { Note, NoteService } from './notes/service.js';
import type { Database } from './db/database.js';
import { isNotePath, NOTE_EXTENSION, normalizeVaultPath, noteTitle } from './vault/paths.js';
import { InvalidPathError } from './errors.js';

export interface RenameResult {
  note: Note;
  /** Notes whose links were rewritten to follow the move. */
  updatedLinks: string[];
}

export type EditAction = 'create' | 'update' | 'delete' | 'rename';

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

  async updateNote(owner: string, notePath: string, content: string, actor?: string): Promise<Note> {
    const note = await this.notes.updateNote(owner, notePath, content);
    await this.indexer.indexNote(owner, note.path);
    this.#recordEdit(owner, note.path, 'update', actor);
    return note;
  }

  /** Create-or-update in one call; see `NoteService.putNote` for why it is one call. */
  async putNote(
    owner: string,
    notePath: string,
    content: string,
    actor?: string,
  ): Promise<{ note: Note; created: boolean }> {
    const result = await this.notes.putNote(owner, notePath, content);
    await this.indexer.indexNote(owner, result.note.path);
    this.#recordEdit(owner, result.note.path, result.created ? 'create' : 'update', actor);
    return result;
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

    const referrers = [...new Set(this.queries.backlinks(owner, source).map((l) => l.source))];
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

  /** Notes for the tree view: every note plus every directory. */
  async tree(owner: string): Promise<{ notes: NoteRow[]; dirs: string[] }> {
    return {
      notes: this.queries.recentNotes(owner, 100_000),
      dirs: await this.notes.listDirs(owner),
    };
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
