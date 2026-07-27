/**
 * Read queries against the index.
 *
 * Every function here takes an owner and every statement filters on it. The
 * filter is written into each SQL string rather than bolted on by a wrapper: a
 * wrapper is something a future query can forget to use, whereas a `WHERE owner =
 * ?` that is missing from the SQL is visible in review.
 *
 * When sharing arrives in phase 7, these become the single place where "effective
 * permission" replaces "owner" — which is why every caller goes through here
 * instead of writing its own SQL.
 */

import type { Database } from '../db/database.js';
import { caseKey } from '../vault/paths.js';

export interface NoteRow {
  path: string;
  title: string;
  size: number;
  mtimeMs: number;
}

export interface SearchHit extends NoteRow {
  /** Excerpt with the matched terms wrapped in the configured markers. */
  snippet: string;
  /** FTS5 rank; lower is a better match. */
  rank: number;
}

export interface LinkRow {
  source: string;
  targetRaw: string;
  targetPath: string | null;
  heading: string | null;
  alias: string | null;
  offset: number;
}

export interface TaskRow {
  path: string;
  line: number;
  done: boolean;
  text: string;
}

/**
 * Turns free text into an FTS5 MATCH expression.
 *
 * Raw user input cannot go into MATCH: `foo AND` or a stray quote is a syntax
 * error, and characters like `-` or `*` silently change the meaning. Each token
 * is therefore quoted as a literal, and the final token gets a prefix wildcard so
 * that search feels live while typing.
 */
export function toMatchQuery(input: string): string | null {
  const tokens = input
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length > 0)
    .slice(0, 16); // a pathological query should not become a pathological plan

  if (tokens.length === 0) return null;

  return tokens
    .map((token, i) => {
      const quoted = `"${token.replace(/"/g, '""')}"`;
      return i === tokens.length - 1 ? `${quoted}*` : quoted;
    })
    .join(' AND ');
}

export class Queries {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  countNotes(owner: string): number {
    const row = this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notes WHERE owner = ?', owner);
    return Number(row?.n ?? 0);
  }

  getNote(owner: string, path: string): NoteRow | undefined {
    const row = this.#db.get(
      'SELECT path, title, size, mtime_ms FROM notes WHERE owner = ? AND path = ?',
      owner,
      path,
    );
    return row ? toNoteRow(row) : undefined;
  }

  recentNotes(owner: string, limit = 20): NoteRow[] {
    return this.#db
      .all(
        `SELECT path, title, size, mtime_ms FROM notes
          WHERE owner = ? ORDER BY mtime_ms DESC LIMIT ?`,
        owner,
        Math.trunc(limit),
      )
      .map(toNoteRow);
  }

  /** Full-text search over title and body, scoped to one owner. */
  search(owner: string, query: string, limit = 30): SearchHit[] {
    const match = toMatchQuery(query);
    if (match === null) return [];

    return this.#db
      .all(
        `SELECT n.path, n.title, n.size, n.mtime_ms,
                snippet(notes_fts, 3, '[', ']', ' … ', 12) AS snippet,
                bm25(notes_fts, 4.0, 1.0) AS rank
           FROM notes_fts
           JOIN notes n ON n.owner = notes_fts.owner AND n.path = notes_fts.path
          WHERE notes_fts MATCH ?
            AND notes_fts.owner = ?
          ORDER BY rank
          LIMIT ?`,
        match,
        owner,
        Math.trunc(limit),
      )
      .map((row) => ({
        ...toNoteRow(row),
        snippet: String(row['snippet'] ?? ''),
        rank: Number(row['rank'] ?? 0),
      }));
  }

  /** Notes that link to `path`. */
  backlinks(owner: string, path: string): LinkRow[] {
    return this.#db
      .all(
        `SELECT source, target_raw, target_path, heading, alias, offset
           FROM links WHERE owner = ? AND target_path = ? ORDER BY source`,
        owner,
        path,
      )
      .map(toLinkRow);
  }

  outgoingLinks(owner: string, path: string): LinkRow[] {
    return this.#db
      .all(
        `SELECT source, target_raw, target_path, heading, alias, offset
           FROM links WHERE owner = ? AND source = ? ORDER BY offset`,
        owner,
        path,
      )
      .map(toLinkRow);
  }

  /** Links whose target does not exist — a finding, not an error. */
  deadLinks(owner: string): LinkRow[] {
    return this.#db
      .all(
        `SELECT source, target_raw, target_path, heading, alias, offset
           FROM links WHERE owner = ? AND target_path IS NULL
          ORDER BY source, offset`,
        owner,
      )
      .map(toLinkRow);
  }

  /** Notes nothing links to. */
  orphans(owner: string): NoteRow[] {
    return this.#db
      .all(
        `SELECT n.path, n.title, n.size, n.mtime_ms
           FROM notes n
          WHERE n.owner = ?
            AND NOT EXISTS (
                  SELECT 1 FROM links l
                   WHERE l.owner = n.owner AND l.target_path = n.path
                )
          ORDER BY n.mtime_ms DESC`,
        owner,
      )
      .map(toNoteRow);
  }

  untagged(owner: string): NoteRow[] {
    return this.#db
      .all(
        `SELECT n.path, n.title, n.size, n.mtime_ms
           FROM notes n
          WHERE n.owner = ?
            AND NOT EXISTS (
                  SELECT 1 FROM tags t WHERE t.owner = n.owner AND t.path = n.path
                )
          ORDER BY n.mtime_ms DESC`,
        owner,
      )
      .map(toNoteRow);
  }

  /** Notes untouched for longer than `days`. */
  stale(owner: string, days = 42, now = Date.now()): NoteRow[] {
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    return this.#db
      .all(
        `SELECT path, title, size, mtime_ms FROM notes
          WHERE owner = ? AND mtime_ms < ? ORDER BY mtime_ms ASC`,
        owner,
        Math.trunc(cutoff),
      )
      .map(toNoteRow);
  }

  openTasks(owner: string): TaskRow[] {
    return this.#db
      .all(
        `SELECT path, line, done, text FROM tasks
          WHERE owner = ? AND done = 0 ORDER BY path, line`,
        owner,
      )
      .map((row) => ({
        path: String(row['path']),
        line: Number(row['line']),
        done: Number(row['done']) === 1,
        text: String(row['text']),
      }));
  }

  /** Tags with their note counts, most used first. */
  tagCounts(owner: string): Array<{ tag: string; count: number }> {
    return this.#db
      .all(
        `SELECT MIN(tag) AS tag, COUNT(*) AS n FROM tags
          WHERE owner = ? GROUP BY key ORDER BY n DESC, tag ASC`,
        owner,
      )
      .map((row) => ({ tag: String(row['tag']), count: Number(row['n']) }));
  }

  notesWithTag(owner: string, tag: string): NoteRow[] {
    return this.#db
      .all(
        `SELECT n.path, n.title, n.size, n.mtime_ms
           FROM notes n JOIN tags t ON t.owner = n.owner AND t.path = n.path
          WHERE n.owner = ? AND t.key = ? ORDER BY n.mtime_ms DESC`,
        owner,
        caseKey(tag),
      )
      .map(toNoteRow);
  }
}

function toNoteRow(row: Record<string, unknown>): NoteRow {
  return {
    path: String(row['path']),
    title: String(row['title']),
    size: Number(row['size']),
    mtimeMs: Number(row['mtime_ms']),
  };
}

function toLinkRow(row: Record<string, unknown>): LinkRow {
  const target = row['target_path'];
  return {
    source: String(row['source']),
    targetRaw: String(row['target_raw']),
    targetPath: target === null || target === undefined ? null : String(target),
    heading: row['heading'] === null || row['heading'] === undefined ? null : String(row['heading']),
    alias: row['alias'] === null || row['alias'] === undefined ? null : String(row['alias']),
    offset: Number(row['offset']),
  };
}
