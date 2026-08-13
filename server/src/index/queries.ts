/**
 * Read queries against the index.
 *
 * Every function here takes a **view** — the resolved list of (owner, prefix)
 * regions the caller may read, produced by `ShareService.view()`. Before sharing
 * existed this was a single owner string, and it still may be: passing a bare
 * string means "this user's own vault and nothing else", which is what the
 * indexer, the smoke test and every write path want.
 *
 * The filter is written into each SQL string rather than bolted on by a wrapper.
 * A wrapper is something a future query can forget to use; a missing
 * `${scope.sql}` in the SQL is visible in review, and there is no query here that
 * compiles without one.
 *
 * The scope fragment is the only place sharing touches reading. Nothing below
 * this file knows what a share is.
 */

import type { Database, SqlValue } from '../db/database.js';
import type { View } from '../auth/shares.js';
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
  /** Whose vault the note lives in — not always the caller once sharing is in play. */
  owner: string;
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
  owner: string;
  source: string;
  targetRaw: string;
  targetPath: string | null;
  heading: string | null;
  alias: string | null;
  offset: number;
}

export interface TaskRow {
  owner: string;
  path: string;
  line: number;
  done: boolean;
  text: string;
}

export interface ActivityRow {
  owner: string;
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

/** A view, or the shorthand for "just this owner's own vault". */
export type Viewable = string | View;

/** Widens the shorthand. Own vault is always writable by its owner. */
export function toView(viewable: Viewable): View {
  return typeof viewable === 'string'
    ? [{ owner: viewable, prefix: '', canWrite: true }]
    : viewable;
}

/**
 * SQL that restricts `alias` to the regions the caller may read.
 *
 * A whole-vault scope compares only the owner, so the ordinary single-user case
 * produces exactly the `owner = ?` this file used before sharing — same plan,
 * same indexes. A prefix scope adds a `substr` comparison rather than `LIKE`,
 * because `LIKE` folds ASCII case in SQLite and paths here are case-sensitive.
 */
function scopeSql(
  alias: string,
  pathColumn: string,
  viewable: Viewable,
): { sql: string; params: SqlValue[] } {
  const view = toView(viewable);
  const parts: string[] = [];
  const params: SqlValue[] = [];

  for (const scope of view) {
    if (scope.prefix === '') {
      parts.push(`${alias}.owner = ?`);
      params.push(scope.owner);
    } else {
      parts.push(`(${alias}.owner = ? AND substr(${alias}.${pathColumn}, 1, ?) = ?)`);
      params.push(scope.owner, scope.prefix.length, scope.prefix);
    }
  }

  // An empty view would produce `()`, which is a syntax error rather than a
  // default-deny. `1 = 0` fails closed and stays legal SQL.
  if (parts.length === 0) return { sql: '(1 = 0)', params: [] };

  return { sql: `(${parts.join(' OR ')})`, params };
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

  countNotes(view: Viewable): number {
    const scope = scopeSql('n', 'path', view);
    const row = this.#db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM notes n WHERE ${scope.sql}`,
      ...scope.params,
    );
    return Number(row?.n ?? 0);
  }

  /**
   * One note, addressed by its real owner.
   *
   * The owner is explicit rather than searched for across the view: two people
   * can both have a `Projekte/Notizen.md`, and guessing which one was meant is
   * not a decision this layer gets to make.
   */
  getNote(view: Viewable, owner: string, path: string): NoteRow | undefined {
    const scope = scopeSql('n', 'path', view);
    const row = this.#db.get(
      `SELECT n.owner, n.path, n.title, n.size, n.mtime_ms
         FROM notes n WHERE n.owner = ? AND n.path = ? AND ${scope.sql}`,
      owner,
      path,
      ...scope.params,
    );
    return row ? toNoteRow(row) : undefined;
  }

  recentNotes(view: Viewable, limit = 20): NoteRow[] {
    const scope = scopeSql('n', 'path', view);
    return this.#db
      .all(
        `SELECT n.owner, n.path, n.title, n.size, n.mtime_ms FROM notes n
          WHERE ${scope.sql} ORDER BY n.mtime_ms DESC LIMIT ?`,
        ...scope.params,
        Math.trunc(limit),
      )
      .map(toNoteRow);
  }

  /**
   * Full-text search over title and body across everything the caller may read.
   *
   * Filters combine, and each one is optional. A query with only filters and no
   * words is legitimate — "everything tagged #homelab from the last week" is a
   * question people ask — so an empty search term falls back to listing by
   * recency rather than returning nothing.
   */
  search(view: Viewable, query: string, options: SearchOptions = {}): SearchHit[] {
    const limit = Math.trunc(options.limit ?? 30);
    const scope = scopeSql('n', 'path', view);
    const conditions: string[] = [scope.sql];
    const params: SqlValue[] = [...scope.params];

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
          `SELECT n.owner, n.path, n.title, n.size, n.mtime_ms
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
        `SELECT n.owner, n.path, n.title, n.size, n.mtime_ms,
                snippet(notes_fts, 3, '[', ']', ' … ', 12) AS snippet,
                bm25(notes_fts, 4.0, 1.0) AS rank
           FROM notes_fts
           JOIN notes n ON n.owner = notes_fts.owner AND n.path = notes_fts.path
          WHERE notes_fts MATCH ?
            AND ${conditions.join(' AND ')}
          ORDER BY rank
          LIMIT ?`,
        match,
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
  quickFind(view: Viewable, query: string, limit = 12): NoteRow[] {
    const needle = query.trim().toLowerCase();

    if (needle === '') {
      return this.recentNotes(view, limit);
    }

    const scope = scopeSql('n', 'path', view);
    const candidates = this.#db
      .all(
        `SELECT n.owner, n.path, n.title, n.size, n.mtime_ms FROM notes n
          WHERE ${scope.sql} ORDER BY n.mtime_ms DESC LIMIT 5000`,
        ...scope.params,
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

  /**
   * Notes that link to `path` in `owner`'s vault.
   *
   * Links never cross a vault boundary — they are resolved per owner by the
   * indexer — so the owner is fixed here. The view still applies: a note that
   * links to a shared note is only reported if the caller may read the note it
   * is written in. Otherwise a backlink list would leak the titles of notes the
   * caller was never given.
   */
  backlinks(view: Viewable, owner: string, path: string): LinkRow[] {
    const scope = scopeSql('l', 'source', view);
    return this.#db
      .all(
        `SELECT l.owner, l.source, l.target_raw, l.target_path, l.heading, l.alias, l.offset
           FROM links l
          WHERE l.owner = ? AND l.target_path = ? AND ${scope.sql}
          ORDER BY l.source`,
        owner,
        path,
        ...scope.params,
      )
      .map(toLinkRow);
  }

  outgoingLinks(view: Viewable, owner: string, path: string): LinkRow[] {
    const scope = scopeSql('l', 'source', view);
    return this.#db
      .all(
        `SELECT l.owner, l.source, l.target_raw, l.target_path, l.heading, l.alias, l.offset
           FROM links l
          WHERE l.owner = ? AND l.source = ? AND ${scope.sql}
          ORDER BY l.offset`,
        owner,
        path,
        ...scope.params,
      )
      .map(toLinkRow);
  }

  /** Links whose target does not exist — a finding, not an error. */
  deadLinks(view: Viewable): LinkRow[] {
    const scope = scopeSql('l', 'source', view);
    return this.#db
      .all(
        `SELECT l.owner, l.source, l.target_raw, l.target_path, l.heading, l.alias, l.offset
           FROM links l
          WHERE l.target_path IS NULL AND ${scope.sql}
          ORDER BY l.source, l.offset`,
        ...scope.params,
      )
      .map(toLinkRow);
  }

  /** Notes nothing links to. */
  orphans(view: Viewable): NoteRow[] {
    const scope = scopeSql('n', 'path', view);
    return this.#db
      .all(
        `SELECT n.owner, n.path, n.title, n.size, n.mtime_ms
           FROM notes n
          WHERE ${scope.sql}
            AND NOT EXISTS (
                  SELECT 1 FROM links l
                   WHERE l.owner = n.owner AND l.target_path = n.path
                )
          ORDER BY n.mtime_ms DESC`,
        ...scope.params,
      )
      .map(toNoteRow);
  }

  untagged(view: Viewable): NoteRow[] {
    const scope = scopeSql('n', 'path', view);
    return this.#db
      .all(
        `SELECT n.owner, n.path, n.title, n.size, n.mtime_ms
           FROM notes n
          WHERE ${scope.sql}
            AND NOT EXISTS (
                  SELECT 1 FROM tags t WHERE t.owner = n.owner AND t.path = n.path
                )
          ORDER BY n.mtime_ms DESC`,
        ...scope.params,
      )
      .map(toNoteRow);
  }

  /** Notes untouched for longer than `days`. */
  stale(view: Viewable, days = 42, now = Date.now()): NoteRow[] {
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const scope = scopeSql('n', 'path', view);
    return this.#db
      .all(
        `SELECT n.owner, n.path, n.title, n.size, n.mtime_ms FROM notes n
          WHERE ${scope.sql} AND n.mtime_ms < ? ORDER BY n.mtime_ms ASC`,
        ...scope.params,
        Math.trunc(cutoff),
      )
      .map(toNoteRow);
  }

  openTasks(view: Viewable): TaskRow[] {
    const scope = scopeSql('t', 'path', view);
    return this.#db
      .all(
        `SELECT t.owner, t.path, t.line, t.done, t.text FROM tasks t
          WHERE ${scope.sql} AND t.done = 0 ORDER BY t.owner, t.path, t.line`,
        ...scope.params,
      )
      .map((row) => ({
        owner: String(row['owner']),
        path: String(row['path']),
        line: Number(row['line']),
        done: Number(row['done']) === 1,
        text: String(row['text']),
      }));
  }

  /** Tags with their note counts, most used first. */
  tagCounts(view: Viewable): Array<{ tag: string; count: number }> {
    const scope = scopeSql('t', 'path', view);
    return this.#db
      .all(
        `SELECT MIN(t.tag) AS tag, COUNT(*) AS n FROM tags t
          WHERE ${scope.sql} GROUP BY t.key ORDER BY n DESC, tag ASC`,
        ...scope.params,
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
  activity(view: Viewable, sinceMs: number, limit = 50): ActivityRow[] {
    const scope = scopeSql('e', 'path', view);
    return this.#db
      .all(
        `SELECT e.owner,
                e.path,
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
          WHERE ${scope.sql} AND e.at >= ?
          GROUP BY e.owner, e.path
          ORDER BY at DESC
          LIMIT ?`,
        ...scope.params,
        Math.trunc(sinceMs),
        Math.trunc(limit),
      )
      .map((row) => ({
        owner: String(row['owner']),
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

  notesWithTag(view: Viewable, tag: string): NoteRow[] {
    const scope = scopeSql('n', 'path', view);
    return this.#db
      .all(
        `SELECT n.owner, n.path, n.title, n.size, n.mtime_ms
           FROM notes n JOIN tags t ON t.owner = n.owner AND t.path = n.path
          WHERE ${scope.sql} AND t.key = ? ORDER BY n.mtime_ms DESC`,
        ...scope.params,
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
    owner: String(row['owner']),
    path: String(row['path']),
    title: String(row['title']),
    size: Number(row['size']),
    mtimeMs: Number(row['mtime_ms']),
  };
}

function toLinkRow(row: Record<string, unknown>): LinkRow {
  const target = row['target_path'];
  return {
    owner: String(row['owner']),
    source: String(row['source']),
    targetRaw: String(row['target_raw']),
    targetPath: target === null || target === undefined ? null : String(target),
    heading: row['heading'] === null || row['heading'] === undefined ? null : String(row['heading']),
    alias: row['alias'] === null || row['alias'] === undefined ? null : String(row['alias']),
    offset: Number(row['offset']),
  };
}
