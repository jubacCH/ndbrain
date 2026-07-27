/**
 * Keeps the index in step with the vault.
 *
 * Two entry points: `rebuild` walks everything from scratch, `sync` updates only
 * what changed. `rebuild` is not a repair tool for exceptional situations — it is
 * the normal way to recover, because the index holds nothing that the files do
 * not. Any bug here costs a reindex, never data.
 */

import { createHash } from 'node:crypto';

import type { Database } from '../db/database.js';
import { clearIndex } from '../db/schema.js';
import { parseNote } from '../markdown/parse.js';
import type { NoteService } from '../notes/service.js';
import { caseKey, noteTitle } from '../vault/paths.js';

export interface IndexStats {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
}

function emptyStats(): IndexStats {
  return { added: 0, updated: 0, removed: 0, unchanged: 0 };
}

function hashOf(content: string): string {
  return createHash('sha1').update(content, 'utf8').digest('hex');
}

/**
 * Strips the `.md` suffix from a wikilink target if the author wrote one, so that
 * `[[Homelab/Proxmox]]` and `[[Homelab/Proxmox.md]]` resolve to the same note.
 */
function linkKey(target: string): string {
  const trimmed = target.replace(/\.md$/i, '');
  return caseKey(trimmed);
}

export class Indexer {
  readonly #db: Database;
  readonly #notes: NoteService;

  constructor(db: Database, notes: NoteService) {
    this.#db = db;
    this.#notes = notes;
  }

  /** Rebuilds one owner's index from the files. Idempotent by construction. */
  async rebuild(owner: string): Promise<IndexStats> {
    clearIndex(this.#db, owner);
    const stats = emptyStats();

    for (const entry of await this.#notes.listNotes(owner)) {
      const note = await this.#notes.getNote(owner, entry.path);
      this.#writeNote(owner, note.path, note.content, note.size, note.mtimeMs);
      stats.added += 1;
    }

    this.resolveLinks(owner);
    return stats;
  }

  /**
   * Updates the index to match the vault, touching only what differs.
   *
   * Compares content hashes rather than timestamps. Timestamps lie: a restored
   * backup, a `git checkout` or an rsync can all leave a changed file with an
   * older mtime, and a note that quietly fails to reindex is exactly the kind of
   * bug nobody notices until the search comes up empty.
   */
  async sync(owner: string): Promise<IndexStats> {
    const stats = emptyStats();

    const known = new Map<string, string>();
    for (const row of this.#db.all<{ path: string; hash: string }>(
      'SELECT path, hash FROM notes WHERE owner = ?',
      owner,
    )) {
      known.set(String(row.path), String(row.hash));
    }

    const seen = new Set<string>();

    for (const entry of await this.#notes.listNotes(owner)) {
      seen.add(entry.path);
      const note = await this.#notes.getNote(owner, entry.path);
      const hash = hashOf(note.content);
      const previous = known.get(entry.path);

      if (previous === hash) {
        stats.unchanged += 1;
        continue;
      }

      this.#writeNote(owner, note.path, note.content, note.size, note.mtimeMs, hash);
      if (previous === undefined) stats.added += 1;
      else stats.updated += 1;
    }

    for (const path of known.keys()) {
      if (seen.has(path)) continue;
      this.removeNote(owner, path);
      stats.removed += 1;
    }

    // Links are re-resolved whenever the set of notes changed: a note that
    // appears may satisfy links that pointed into the void, and one that
    // disappears breaks links that used to resolve.
    if (stats.added > 0 || stats.removed > 0 || stats.updated > 0) {
      this.resolveLinks(owner);
    }

    return stats;
  }

  /** Indexes a single note, replacing whatever was recorded for it before. */
  async indexNote(owner: string, notePath: string): Promise<void> {
    const note = await this.#notes.getNote(owner, notePath);
    this.#writeNote(owner, note.path, note.content, note.size, note.mtimeMs);
    this.resolveLinks(owner);
  }

  /**
   * Indexes a note only if its content differs from what is recorded.
   *
   * This is how the watcher avoids reacting to the server's own writes, and it
   * does so without a time window: a write that the API already indexed hashes
   * identically, so the file event that follows is simply a no-op. Timing-based
   * suppression would either miss a fast external edit or re-index needlessly on
   * a slow disk; comparing content cannot get it wrong.
   *
   * Does not resolve links — the caller batches that after a group of changes.
   */
  async indexIfChanged(owner: string, notePath: string): Promise<'indexed' | 'unchanged' | 'missing'> {
    let content: string;
    let size: number;
    let mtimeMs: number;

    try {
      const note = await this.#notes.getNote(owner, notePath);
      content = note.content;
      size = note.size;
      mtimeMs = note.mtimeMs;
    } catch {
      return 'missing';
    }

    const hash = hashOf(content);
    const row = this.#db.get<{ hash: string }>(
      'SELECT hash FROM notes WHERE owner = ? AND path = ?',
      owner,
      notePath,
    );

    if (row !== undefined && String(row.hash) === hash) return 'unchanged';

    this.#writeNote(owner, notePath, content, size, mtimeMs, hash);
    return 'indexed';
  }

  removeNote(owner: string, notePath: string): void {
    this.#db.transaction(() => {
      // Cascades clear tags, links and tasks; the FTS table has no foreign key.
      this.#db.run('DELETE FROM notes_fts WHERE owner = ? AND path = ?', owner, notePath);
      this.#db.run('DELETE FROM notes WHERE owner = ? AND path = ?', owner, notePath);
    });
  }

  #writeNote(
    owner: string,
    notePath: string,
    content: string,
    size: number,
    mtimeMs: number,
    precomputedHash?: string,
  ): void {
    const parsed = parseNote(content);
    const title = noteTitle(notePath);
    const hash = precomputedHash ?? hashOf(content);

    this.#db.transaction(() => {
      this.#db.run('DELETE FROM notes_fts WHERE owner = ? AND path = ?', owner, notePath);
      this.#db.run('DELETE FROM notes WHERE owner = ? AND path = ?', owner, notePath);

      this.#db.run(
        `INSERT INTO notes (owner, path, title, path_key, title_key, size, mtime_ms, hash, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        owner,
        notePath,
        title,
        caseKey(notePath),
        caseKey(title),
        Math.trunc(size),
        Math.trunc(mtimeMs),
        hash,
        Date.now(),
      );

      for (const tag of parsed.tags) {
        this.#db.run(
          'INSERT OR IGNORE INTO tags (owner, path, tag, key) VALUES (?, ?, ?, ?)',
          owner,
          notePath,
          tag,
          caseKey(tag),
        );
      }

      for (const link of parsed.wikilinks) {
        this.#db.run(
          `INSERT INTO links (owner, source, target_raw, target_key, target_path, heading, alias, offset)
           VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
          owner,
          notePath,
          link.target,
          linkKey(link.target),
          link.heading,
          link.alias,
          link.offset,
        );
      }

      for (const task of parsed.tasks) {
        this.#db.run(
          'INSERT OR REPLACE INTO tasks (owner, path, line, done, text) VALUES (?, ?, ?, ?, ?)',
          owner,
          notePath,
          task.line,
          task.done ? 1 : 0,
          task.text,
        );
      }

      this.#db.run(
        'INSERT INTO notes_fts (owner, path, title, body) VALUES (?, ?, ?, ?)',
        owner,
        notePath,
        title,
        parsed.body,
      );
    });
  }

  /**
   * Points every link at the note it names, within this owner's vault only.
   *
   * The `owner = links.owner` condition in the subquery is the tenant boundary.
   * Without it a `[[Tagebuch]]` in one vault would resolve against another user's
   * note — which would not only be wrong, it would confirm that the note exists.
   * Unresolvable links keep `target_path = NULL` on purpose.
   *
   * Preference order: an exact path match beats a title match, and among title
   * matches the shortest path wins, so `[[Proxmox]]` prefers `Proxmox.md` over
   * `Archiv/Alt/Proxmox.md`. Ties break on the path so the result is stable.
   */
  resolveLinks(owner: string): void {
    this.#db.transaction(() => {
      this.#db.run('UPDATE links SET target_path = NULL WHERE owner = ?', owner);

      // Three passes instead of one ranked query, because SQLite cannot resolve a
      // column of the outer table inside a subquery's ORDER BY — only inside its
      // WHERE. Each pass is one preference rule, and later passes only fill in
      // what earlier ones left unresolved, so precedence is explicit.
      const passes = [
        // 1. The link names a full path: [[Homelab/Proxmox]] or [[Homelab/Proxmox.md]]
        `n.path_key = links.target_key || '.md'`,
        // 2. The link names a path that already carries its own extension.
        `n.path_key = links.target_key`,
        // 3. The link names a title: [[Proxmox]]. Shortest path wins, so a note at
        //    the top of the vault beats one buried in an archive; the path breaks
        //    ties so the result never depends on row order.
        `n.title_key = links.target_key`,
      ];

      for (const condition of passes) {
        this.#db.run(
          `UPDATE links
              SET target_path = (
                SELECT n.path FROM notes n
                 WHERE n.owner = links.owner AND ${condition}
                 ORDER BY length(n.path), n.path
                 LIMIT 1
              )
            WHERE owner = ? AND target_path IS NULL`,
          owner,
        );
      }
    });
  }
}
