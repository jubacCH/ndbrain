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
  /**
   * Only notes declaring this frontmatter property.
   *
   * `{ key: 'status' }` asks which notes have a status at all; adding `value`
   * narrows it to one. Both are matched case-folded, like tags.
   */
  prop?: { key: string; value?: string };
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

/** One thing that happened in a vault: a change, or an agent reading. */
export interface PulseEvent {
  at: number;
  /** `write` covers create, update, delete and rename; `read` is an agent looking. */
  kind: 'read' | 'write';
  /** The edit action, or the MCP tool name. */
  what: string;
  /** Null for activity without one note — a search, a listing, a vault map. */
  path: string | null;
  /** Account name for a person, key name for an agent. */
  who: string;
  agent: boolean;
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

/**
 * Separators for the aggregated columns in `vaultMap`.
 *
 * ASCII unit and record separators rather than commas or pipes: a tag or a
 * property value may legitimately contain either, and splitting on a character
 * that can occur in the data invents entries that were never there.
 */
const UNIT_SEP = '\u001f';
const FIELD_SEP = '\u001e';

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

    if (options.prop !== undefined && options.prop.key !== '') {
      const value = options.prop.value;
      conditions.push(
        'EXISTS (SELECT 1 FROM props p WHERE p.owner = n.owner AND p.path = n.path ' +
          `AND p.key_fold = ?${value === undefined || value === '' ? '' : ' AND p.value_fold = ?'})`,
      );
      params.push(caseKey(options.prop.key));
      if (value !== undefined && value !== '') params.push(caseKey(value));
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

  /**
   * Whether tagging is a convention in this vault at all.
   *
   * "Untagged" is only a finding where tags mean something. A vault that has
   * never used one is not sixty notes behind — it simply files differently, and
   * reporting every note as a defect says more about the tool's assumptions than
   * about the vault. The finding switches itself on the moment one note carries
   * a tag, so nothing has to be configured and nothing stays hidden once the
   * convention exists.
   */
  tagsInUse(view: Viewable): boolean {
    const scope = scopeSql('t', 'path', view);
    return this.#db.all(`SELECT 1 FROM tags t WHERE ${scope.sql} LIMIT 1`, ...scope.params).length > 0;
  }

  /**
   * How many notes need attention — counted as notes, not as findings.
   *
   * Adding the four finding counts together overstates the total, because one
   * note is routinely orphaned *and* untagged *and* stale; on this vault that
   * arithmetic produced "100 need attention" against 60 notes, a number no
   * amount of tidying could ever bring down to zero. What a person wants to know
   * is how many notes they would have to open, so the sets are unioned by path.
   *
   * Dead links are counted at their source: the note holding the broken link is
   * the one that has to be edited.
   */
  attentionCount(view: Viewable): number {
    const paths = new Set<string>();
    for (const note of this.orphans(view)) paths.add(note.path);
    for (const note of this.stale(view)) paths.add(note.path);
    for (const link of this.deadLinks(view)) paths.add(link.source);
    if (this.tagsInUse(view)) for (const note of this.untagged(view)) paths.add(note.path);
    return paths.size;
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

  /**
   * Every note as one line: path, title, tags, frontmatter properties.
   *
   * Exists for the reader that cannot skim. A person opens the tree and sees the
   * shape of the vault in a second; an agent had no equivalent — its only way to
   * find out what was in here was to full-text search and pull whole notes back,
   * which costs its context and still misses everything nobody thought to search
   * for. This is the cheap overview that makes a targeted second call possible.
   *
   * No note bodies, deliberately. The moment this returns content it stops being
   * a map and becomes the expensive thing it was meant to replace.
   */
  vaultMap(view: Viewable, limit = 5000): Array<{
    owner: string;
    path: string;
    title: string;
    mtimeMs: number;
    tags: string[];
    props: Record<string, string[]>;
  }> {
    const scope = scopeSql('n', 'path', view);
    const rows = this.#db.all(
      `SELECT n.owner, n.path, n.title, n.mtime_ms,
              (SELECT group_concat(t.tag, char(31)) FROM tags t
                WHERE t.owner = n.owner AND t.path = n.path)  AS tag_list,
              (SELECT group_concat(p.key || char(30) || p.value, char(31)) FROM props p
                WHERE p.owner = n.owner AND p.path = n.path)  AS prop_list
         FROM notes n
        WHERE ${scope.sql}
        ORDER BY n.path
        LIMIT ?`,
      ...scope.params,
      Math.trunc(limit),
    );

    // Unit separators rather than commas: a tag or a property value may contain
    // a comma, and splitting on one would invent entries that are not there.
    const split = (value: unknown): string[] =>
      value === null || value === undefined ? [] : String(value).split(UNIT_SEP).filter(Boolean);

    return rows.map((row) => {
      const props: Record<string, string[]> = {};
      for (const pair of split(row['prop_list'])) {
        const at = pair.indexOf(FIELD_SEP);
        if (at === -1) continue;
        const key = pair.slice(0, at);
        (props[key] ??= []).push(pair.slice(at + 1));
      }

      return {
        owner: String(row['owner']),
        path: String(row['path']),
        title: String(row['title']),
        mtimeMs: Number(row['mtime_ms']),
        tags: split(row['tag_list']),
        props,
      };
    });
  }

  /** Which frontmatter keys exist, and how often — the vault's own vocabulary. */
  propKeys(view: Viewable): Array<{ key: string; count: number }> {
    const scope = scopeSql('p', 'path', view);
    return this.#db
      .all(
        `SELECT p.key AS key, COUNT(DISTINCT p.path) AS n FROM props p
          WHERE ${scope.sql}
          GROUP BY p.key_fold
          ORDER BY n DESC, key`,
        ...scope.params,
      )
      .map((row) => ({ key: String(row['key']), count: Number(row['n']) }));
  }

  /** The values a given frontmatter key takes, most used first. */
  propValues(view: Viewable, key: string): Array<{ value: string; count: number }> {
    const scope = scopeSql('p', 'path', view);
    return this.#db
      .all(
        `SELECT p.value AS value, COUNT(DISTINCT p.path) AS n FROM props p
          WHERE ${scope.sql} AND p.key_fold = ?
          GROUP BY p.value_fold
          ORDER BY n DESC, value`,
        ...scope.params,
        caseKey(key),
      )
      .map((row) => ({ value: String(row['value']), count: Number(row['n']) }));
  }

  /**
   * Everything that happened in this vault since a moment, newest first.
   *
   * Two logs, one answer. `edits` records who changed what; `access_log` records
   * every MCP call an agent made, including the ones that only read. Together
   * they are the only way to see what an agent is *doing* — reads leave no other
   * trace anywhere, because reading a note changes nothing.
   *
   * Deliberately the caller's own vault only, never the shared view. Activity in
   * somebody else's vault is information about that person — when they work, how
   * often, on what — and sharing a folder is not consent to being watched.
   *
   * Writes come from `edits` alone, even when an agent made them. An agent write
   * lands in *both* tables, and taking it from both would show every agent edit
   * twice.
   */
  pulse(owner: string, sinceMs: number, limit = 200): PulseEvent[] {
    const rows = this.#db.all(
      `SELECT at, 'write' AS kind, action AS what, path, actor AS who, 0 AS agent
         FROM edits
        WHERE owner = ? AND at > ?
       UNION ALL
       SELECT a.at, 'read' AS kind, a.tool AS what, a.path, k.name AS who, 1 AS agent
         FROM access_log a
         JOIN api_keys k ON k.id = a.key_id
        WHERE a.owner = ? AND a.at > ? AND a.allowed = 1
          AND a.tool IN ('get_note', 'search_notes', 'list_notes', 'get_links', 'vault_map')
        ORDER BY at DESC
        LIMIT ?`,
      owner,
      Math.trunc(sinceMs),
      owner,
      Math.trunc(sinceMs),
      Math.trunc(limit),
    );

    return rows.map((row) => ({
      at: Number(row['at']),
      kind: String(row['kind']) === 'read' ? 'read' : 'write',
      what: String(row['what']),
      // A search or a listing has no single note behind it — null is the honest
      // answer, and the view can show it as activity without a location.
      path: row['path'] === null || row['path'] === undefined ? null : String(row['path']),
      who: String(row['who']),
      agent: Number(row['agent']) === 1,
    }));
  }

  /**
   * The link graph: one entry per note, one per resolved connection.
   *
   * Only resolved links become edges. A link into the void has no other end to
   * draw to — it is a finding for the tidy view, not a line. Duplicates collapse:
   * mentioning the same note three times in one page is one relationship, and
   * three overlapping lines would just look like a thicker one.
   *
   * The degree is counted from resolved links in both directions, because for
   * "how connected is this note" it makes no difference who pointed at whom.
   */
  graph(view: Viewable): {
    nodes: Array<{ owner: string; path: string; title: string; folder: string; links: number }>;
    edges: Array<{ owner: string; from: string; to: string }>;
  } {
    const nodeScope = scopeSql('n', 'path', view);
    const nodes = this.#db
      .all(
        `SELECT n.owner, n.path, n.title,
                (SELECT COUNT(*) FROM links l
                  WHERE l.owner = n.owner AND l.target_path IS NOT NULL
                    AND (l.source = n.path OR l.target_path = n.path)) AS deg
           FROM notes n
          WHERE ${nodeScope.sql}
          ORDER BY n.path`,
        ...nodeScope.params,
      )
      .map((row) => {
        const p = String(row['path']);
        const cut = p.lastIndexOf('/');
        return {
          owner: String(row['owner']),
          path: p,
          title: String(row['title']),
          folder: cut === -1 ? '' : p.slice(0, cut),
          links: Number(row['deg']),
        };
      });

    const edgeScope = scopeSql('l', 'source', view);
    const edges = this.#db
      .all(
        `SELECT DISTINCT l.owner, l.source, l.target_path
           FROM links l
          WHERE ${edgeScope.sql} AND l.target_path IS NOT NULL AND l.target_path <> l.source`,
        ...edgeScope.params,
      )
      .map((row) => ({
        owner: String(row['owner']),
        from: String(row['source']),
        to: String(row['target_path']),
      }));

    return { nodes, edges };
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
