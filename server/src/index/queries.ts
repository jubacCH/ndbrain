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

import type { Database, SqlValue } from '../db/database.js';
import { caseKey } from '../vault/paths.js';

export interface SearchOptions {
  /** Only notes carrying this tag. */
  tag?: string;
  /** Only notes below this folder. */
  dir?: string;
  /** Only notes modified at or after this timestamp. */
  sinceMs?: number;
  limit?: number;
}

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

export interface ActivityRow {
  path: string;
  title: string;
  /** Account name, or an agent's key name once agents write. */
  actor: string;
  action: 'create' | 'update' | 'delete' | 'rename';
  at: number;
  /** How many edits were collapsed into this entry. */
  edits: number;
  /** True when the note no longer exists — deliberately still listed. */
  deleted: boolean;
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

  /**
   * Full-text search over title and body, scoped to one owner.
   *
   * Filters combine, and each one is optional. A query with only filters and no
   * words is legitimate — "everything tagged #homelab from the last week" is a
   * question people ask — so an empty search term falls back to listing by
   * recency rather than returning nothing.
   */
  search(owner: string, query: string, options: SearchOptions = {}): SearchHit[] {
    const limit = Math.trunc(options.limit ?? 30);
    const conditions: string[] = ['n.owner = ?'];
    const params: SqlValue[] = [owner];

    if (options.tag !== undefined && options.tag !== '') {
      conditions.push(
        'EXISTS (SELECT 1 FROM tags t WHERE t.owner = n.owner AND t.path = n.path AND t.key = ?)',
      );
      params.push(caseKey(options.tag));
    }

    if (options.dir !== undefined && options.dir !== '') {
      // Prefix match on the folder. `substr` rather than LIKE because LIKE folds
      // case in SQLite for ASCII, and folder names are case-sensitive here.
      const prefix = options.dir.endsWith('/') ? options.dir : `${options.dir}/`;
      conditions.push('substr(n.path, 1, ?) = ?');
      params.push(prefix.length, prefix);
    }

    if (options.sinceMs !== undefined) {
      conditions.push('n.mtime_ms >= ?');
      params.push(Math.trunc(options.sinceMs));
    }

    const match = toMatchQuery(query);

    if (match === null) {
      // No search words: this is a filter query, so order by recency and give
      // back an empty snippet rather than pretending to have matched something.
      return this.#db
        .all(
          `SELECT n.path, n.title, n.size, n.mtime_ms
             FROM notes n
            WHERE ${conditions.join(' AND ')}
            ORDER BY n.mtime_ms DESC
            LIMIT ?`,
          ...params,
          limit,
        )
        .map((row) => ({ ...toNoteRow(row), snippet: '', rank: 0 }));
    }

    return this.#db
      .all(
        `SELECT n.path, n.title, n.size, n.mtime_ms,
                snippet(notes_fts, 3, '[', ']', ' … ', 12) AS snippet,
                bm25(notes_fts, 4.0, 1.0) AS rank
           FROM notes_fts
           JOIN notes n ON n.owner = notes_fts.owner AND n.path = notes_fts.path
          WHERE notes_fts MATCH ?
            AND notes_fts.owner = ?
            AND ${conditions.join(' AND ')}
          ORDER BY rank
          LIMIT ?`,
        match,
        owner,
        ...params,
        limit,
      )
      .map((row) => ({
        ...toNoteRow(row),
        snippet: String(row['snippet'] ?? ''),
        rank: Number(row['rank'] ?? 0),
      }));
  }

  /**
   * Title matching for the quick switcher.
   *
   * Deliberately not full-text search. Somebody typing `prox` to jump to a note
   * wants the note called Proxmox, not the forty notes that mention it — and
   * they want it before they finish typing. This looks only at titles and paths.
   *
   * Ranking is done in JavaScript because it is a subsequence score, which SQL
   * cannot express; the candidate set is bounded first so the work stays small.
   */
  quickFind(owner: string, query: string, limit = 12): NoteRow[] {
    const needle = query.trim().toLowerCase();

    if (needle === '') {
      return this.recentNotes(owner, limit);
    }

    const candidates = this.#db
      .all(
        `SELECT path, title, size, mtime_ms FROM notes
          WHERE owner = ? ORDER BY mtime_ms DESC LIMIT 5000`,
        owner,
      )
      .map(toNoteRow);

    const scored: Array<{ note: NoteRow; score: number }> = [];
    for (const note of candidates) {
      const score = matchScore(note, needle);
      if (score > 0) scored.push({ note, score });
    }

    scored.sort((a, b) => b.score - a.score || b.note.mtimeMs - a.note.mtimeMs);
    return scored.slice(0, limit).map((entry) => entry.note);
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

  /**
   * What happened lately, newest first, one entry per note.
   *
   * Collapsed per note on purpose: twenty autosaves of one paragraph are one
   * thing that happened, not twenty. Deleted notes are kept in the result — "the
   * note you are looking for was deleted this morning" is precisely the answer
   * somebody needs.
   */
  activity(owner: string, sinceMs: number, limit = 50): ActivityRow[] {
    return this.#db
      .all(
        `SELECT e.path,
                MAX(e.at)                                        AS at,
                COUNT(*)                                         AS edits,
                -- The actor and action of the most recent edit for this note.
                (SELECT actor  FROM edits x
                  WHERE x.owner = e.owner AND x.path = e.path
                  ORDER BY x.at DESC LIMIT 1)                    AS actor,
                (SELECT action FROM edits x
                  WHERE x.owner = e.owner AND x.path = e.path
                  ORDER BY x.at DESC LIMIT 1)                    AS action,
                n.title                                          AS title
           FROM edits e
           LEFT JOIN notes n ON n.owner = e.owner AND n.path = e.path
          WHERE e.owner = ? AND e.at >= ?
          GROUP BY e.path
          ORDER BY at DESC
          LIMIT ?`,
        owner,
        Math.trunc(sinceMs),
        Math.trunc(limit),
      )
      .map((row) => ({
        path: String(row['path']),
        // A deleted note has no row in `notes` any more, so fall back to its name.
        title: row['title'] === null || row['title'] === undefined
          ? String(row['path']).split('/').pop()?.replace(/\.md$/i, '') ?? String(row['path'])
          : String(row['title']),
        actor: String(row['actor']),
        action: String(row['action']) as ActivityRow['action'],
        at: Number(row['at']),
        edits: Number(row['edits']),
        deleted: row['title'] === null || row['title'] === undefined,
      }));
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

/**
 * Scores a note against what the person has typed so far. Zero means no match.
 *
 * The ordering encodes how people actually use a quick switcher: an exact title
 * beats a title that starts with the input, which beats a title that contains
 * it, which beats a match anywhere in the path. Below that, a subsequence match
 * still counts — typing `pxcl` should find `Proxmox Cluster` — but scores lowest,
 * because it is the loosest kind of match and would otherwise drown the rest.
 */
function matchScore(note: NoteRow, needle: string): number {
  const title = note.title.toLowerCase();
  const path = note.path.toLowerCase();

  if (title === needle) return 1000;
  if (title.startsWith(needle)) return 800 - title.length;
  if (title.includes(needle)) return 600 - title.length;
  if (path.includes(needle)) return 400 - path.length;

  return isSubsequence(needle, title) ? 200 - title.length : 0;
}

/** True if every character of `needle` appears in `haystack`, in order. */
function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return needle.length === 0;
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
