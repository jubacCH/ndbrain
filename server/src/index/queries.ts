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
import { prefixSql } from '../db/prefix.js';
import { regionSql, type View } from '../auth/shares.js';
import { caseKey } from '../vault/paths.js';
import { DEFAULT_SETTINGS } from '../auth/settings.js';
import { parseConflictPath } from '../notes/service.js';
import { isDailyNote, isPendingDayLink } from '../../../shared/journal.js';

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

export interface TaskFilter {
  /** Only tasks in notes below this folder. */
  dir?: string;
  /** Include finished tasks too. Unset or false means open tasks only. */
  includeDone?: boolean;
  limit?: number;
}

export interface ConflictRow extends NoteRow {
  /** Path of the note the copy displaced, read back from the copy's own name. */
  originalPath: string;
  /** Title of the original, when it can still be read. Null when gone or hidden. */
  originalTitle: string | null;
  /** Whether that note still exists, in the caller's view — see `conflictCopies`. */
  originalExists: boolean;
  /** The moment named in the copy's filename. */
  at: number;
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

/**
 * One day of a vault's own activity, as counts — see `Queries.dailyActivity`.
 *
 * Counts of distinct notes, not of edit rows: twenty autosaves of one paragraph
 * are one note edited, the same collapse `activity` applies.
 */
export interface ActivityDay {
  /** Inclusive start of the day — the client's local midnight. */
  start: number;
  /** Exclusive end. */
  end: number;
  /** Notes created that day. */
  created: number;
  /** Notes changed that day that were not also created that day. */
  edited: number;
  deleted: number;
  renamed: number;
  /** Distinct notes with any change at all. */
  touched: number;
  /** Allowed agent reads, one per tool call — a search or a listing included. */
  agentReads: number;
  /** Allowed agent writes, one per tool call. */
  agentWrites: number;
}

/** The MCP tools that only look — the same list `pulse` filters on, from here. */
const AGENT_READ_TOOLS = [
  'get_note',
  'search_notes',
  'list_notes',
  'get_links',
  'vault_map',
  'list_tasks',
] as const;
/** The MCP tools that change a note. */
const AGENT_WRITE_TOOLS = [
  'create_note',
  'append_note',
  'edit_note',
  'delete_note',
  'rename_note',
] as const;

/**
 * The per-day edit counts, for `days` buckets; parameters are the buckets as
 * `(i, lo, hi)` triples, then the owner.
 *
 * One row per (day, note) first, carrying which actions that note saw that
 * day, so a run of autosaves is one row before anything is counted, and "edited
 * but not new" is a column of the same row rather than a lookup. The first
 * version asked that with a correlated `NOT EXISTS` over the materialised
 * rows, which SQLite runs as a scan per row: quadratic in a day's edits, and
 * `node:sqlite` holds the event loop for every user while it runs. Exported
 * so a test can read the plan.
 */
export function dailyEditsSql(days: number): string {
  const values = Array.from({ length: days }, () => '(?, ?, ?)').join(', ');
  return `WITH b(i, lo, hi) AS (VALUES ${values}),
            p AS (SELECT b.i AS i,
                         MAX(e.action = 'create') AS c,
                         MAX(e.action = 'update') AS u,
                         MAX(e.action = 'delete') AS d,
                         MAX(e.action = 'rename') AS r
                    FROM b JOIN edits e ON e.owner = ? AND e.at >= b.lo AND e.at < b.hi
                   GROUP BY b.i, e.path)
       SELECT i,
              SUM(c)           AS created,
              SUM(u AND NOT c) AS edited,
              SUM(d)           AS deleted,
              SUM(r)           AS renamed,
              COUNT(*)         AS touched
         FROM p
        GROUP BY i`;
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
  /** Always the caller: the pulse never reports another vault. */
  owner: string;
}

/** A note deleted through ndBrain, as `Queries.deletedNotes` lists it. */
export interface DeletedRow {
  owner: string;
  path: string;
  title: string;
  /** Who deleted it: the account, or an agent key's owner. */
  actor: string;
  at: number;
}

/**
 * The regions of a view somebody may bring a deleted note back into.
 *
 * **The** rule for deleted notes, used by the list and by the restore alike:
 * a region the caller may write, and never a note share. A note share names
 * one note and is withdrawn when that note is deleted; one that happened to
 * survive — or a new one on a note that later took the path — must not become
 * a key to the note that was there before.
 */
export function restoreScopes(viewable: Viewable): View {
  return toView(viewable).filter((scope) => scope.canWrite && !scope.exact);
}

/** The word a restore under another name puts into the new name. */
export const RESTORED_WORD = 'wiederhergestellt';

/**
 * The name a deleted note is restored under when its own path is taken:
 * `Plan (wiederhergestellt 2026-09-17).md`, then `… 2026-09-17 2).md` and on.
 * Local date, like a conflict copy's name.
 */
export function restoredPath(notePath: string, when: Date, attempt = 1): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const day = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  const suffix = attempt > 1 ? ` ${attempt}` : '';
  return `${notePath.replace(/\.md$/i, '')} (${RESTORED_WORD} ${day}${suffix}).md`;
}

/** The original path a `restoredPath` name was made from, or null for any other name. */
export function restoredOriginal(notePath: string): string | null {
  const match = new RegExp(`^(.+) \\(${RESTORED_WORD} (\\d{4})-(\\d{2})-(\\d{2})(?: ([2-9]|[1-9]\\d+))?\\)\\.md$`).exec(
    notePath,
  );
  if (match === null) return null;
  return `${match[1] ?? ''}.md`;
}

function noteTitleOf(notePath: string): string {
  return notePath.slice(notePath.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

/** A view, or the shorthand for "just this owner's own vault". */
export type Viewable = string | View;

/** Widens the shorthand. Own vault is always writable by its owner. */
export function toView(viewable: Viewable): View {
  return typeof viewable === 'string'
    ? [{ owner: viewable, prefix: '', exact: false, canWrite: true }]
    : viewable;
}

/**
 * SQL that restricts `alias` to the regions the caller may read.
 *
 * A whole-vault scope compares only the owner, so the ordinary single-user case
 * produces exactly the `owner = ?` this file used before sharing — same plan,
 * same indexes. Every other scope adds the path condition `regionSql` writes,
 * the SQL twin of `inScope`: a prefix for a folder, equality for a note.
 */
function scopeSql(
  alias: string,
  pathColumn: string,
  viewable: Viewable,
  timeColumn?: string,
): { sql: string; params: SqlValue[] } {
  const view = toView(viewable);
  const parts: string[] = [];
  const params: SqlValue[] = [];

  for (const scope of view) {
    const region = regionSql(
      `${alias}.${pathColumn}`,
      scope,
      timeColumn === undefined ? undefined : `${alias}.${timeColumn}`,
    );
    if (region.sql === null) {
      parts.push(`${alias}.owner = ?`);
      params.push(scope.owner);
    } else {
      parts.push(`(${alias}.owner = ? AND ${region.sql})`);
      params.push(scope.owner, ...region.params);
    }
  }

  // An empty view would produce `()`, which is a syntax error rather than a
  // default-deny. `1 = 0` fails closed and stays legal SQL.
  if (parts.length === 0) return { sql: '(1 = 0)', params: [] };

  return { sql: `(${parts.join(' OR ')})`, params };
}

/**
 * The `dir` and `includeDone` conditions the task list and its count share.
 *
 * Kept separate from `scopeSql`, which the caller still adds on top: this part
 * is a plain filter, not the sharing boundary, and the two must not be
 * conflated the way `queries.ts`'s file comment warns against.
 */
function taskFilterSql(filter: TaskFilter): { sql: string; params: SqlValue[] } {
  const conditions: string[] = [];
  const params: SqlValue[] = [];

  if (filter.includeDone !== true) {
    conditions.push('t.done = 0');
  }

  if (filter.dir !== undefined && filter.dir !== '') {
    // Prefix match on the folder, `substr` rather than `LIKE` — see the
    // identical comment on `search`'s `dir` option, which this mirrors.
    const prefix = filter.dir.endsWith('/') ? filter.dir : `${filter.dir}/`;
    conditions.push(prefixSql('t.path', prefix).sql);
    params.push(...prefixSql('t.path', prefix).params);
  }

  return { sql: conditions.length === 0 ? '' : ` AND ${conditions.join(' AND ')}`, params };
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


/**
 * The metadata line a Joplin import left at the top of most notes.
 *
 * Matched narrowly, and only at the start of the text — the same shape
 * `notes/topics.ts` reads tags from. A looser test would strip real quotations.
 */
const META_LINE = /^\s*>[^\n]*\*\*(?:type|topic|src|updated)s?:\*\*[^\n]*\n?/i;

/**
 * An excerpt that distinguishes one hit from another.
 *
 * FTS5 returns the first match in the body, which for this vault is the same
 * boilerplate line in every result. When that is what came back, this finds a
 * match in the prose *after* that line instead and marks it the same way, so the
 * highlighting stays consistent with the rest of the list.
 *
 * Falls back to whatever FTS gave: a metadata excerpt is a poor excerpt, and an
 * empty one is a worse one.
 */
function usefulSnippet(fromFts: string, body: string, terms: string[]): string {
  const looksLikeMeta = /\*\*(?:type|topic|src|updated):\*\*/i.test(fromFts);
  if (!looksLikeMeta) return fromFts;

  const prose = body.replace(META_LINE, '').trim();
  if (prose === '') return fromFts;

  const hay = prose.toLowerCase();
  let at = -1;
  let hit = '';
  for (const term of terms) {
    const found = hay.indexOf(term.toLowerCase());
    if (found !== -1 && (at === -1 || found < at)) {
      at = found;
      hit = prose.slice(found, found + term.length);
    }
  }

  // No term in the prose means the match really was only in the metadata line;
  // showing the start of the note is still more use than showing that line.
  if (at === -1) return `${prose.slice(0, 120).replace(/\s+/g, ' ')} …`;

  const from = Math.max(0, at - 60);
  const to = Math.min(prose.length, at + hit.length + 80);
  const lead = from > 0 ? '… ' : '';
  const tail = to < prose.length ? ' …' : '';
  const before = prose.slice(from, at).replace(/\s+/g, ' ');
  const after = prose.slice(at + hit.length, to).replace(/\s+/g, ' ');

  return `${lead}${before}[${hit}]${after}${tail}`;
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
      conditions.push(prefixSql('n.path', prefix).sql);
      params.push(...prefixSql('n.path', prefix).params);
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
        .map((row) => ({ ...toNoteRow(row), snippet: '' }));
    }

    // The words the caller actually typed, for rescuing an excerpt that came
    // back as boilerplate. Taken from the input rather than from the FTS
    // expression, which has been quoted and wildcarded by then.
    const terms = query
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((token) => token.length > 1)
      .slice(0, 16);

    return this.#db
      .all(
        `SELECT n.owner, n.path, n.title, n.size, n.mtime_ms,
                snippet(notes_fts, 3, '[', ']', ' … ', 12) AS snippet,
                notes_fts.body AS body,
                -- One weight per column of notes_fts, in its declared order:
                -- owner, path, title, body. The boost belongs on the title, and
                -- it has to be written out in full — a short weight list does
                -- not skip to the interesting columns, it fills from the left
                -- and leaves the rest at 1.0. Written as (4.0, 1.0) it put the
                -- 4.0 on the owner column, which is UNINDEXED and matches
                -- nothing, and left title and body equal: a note merely
                -- mentioning the word three times outranked the note actually
                -- called that. (No backticks in here, either — this comment
                -- lives inside a template literal, and one would end the SQL
                -- mid-sentence.)
                --
                -- Ordering only. The score is never returned: bm25 is computed
                -- from FTS5 statistics kept over the whole table, so the number
                -- moves when a note in a part of the vault the caller may not
                -- read is written or deleted. Quantitative, noisy and without a
                -- path in it, but a side channel across the tenant boundary all
                -- the same — and the interface sorts server-side and never had
                -- a use for it.
                bm25(notes_fts, 1.0, 1.0, 4.0, 1.0) AS rank
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
        snippet: usefulSnippet(
          String(row['snippet'] ?? ''),
          String(row['body'] ?? ''),
          terms,
        ),
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

  /**
   * The links written in `path`, with every target the caller may not read
   * reported as unresolved.
   *
   * The indexer resolves a link against the whole vault, not against the
   * caller's view, so a resolved target can sit outside it — that is how a
   * grantee of one folder was handed paths out of the private half of somebody
   * else's vault. The view therefore has to be applied here.
   *
   * It is applied as a **projection, not a `WHERE`**. Dropping the row would
   * leak the same fact one step further back: the caller may read the source
   * note, so she knows which `[[…]]` are written in it, and a link present in
   * the text but missing from this list could only mean "exists, not yours".
   * With write access that is a free existence oracle over the foreign vault —
   * write `[[Kandidat]]` into a note of your own and read off whether the line
   * comes back. Nulling the target instead makes refusal look like absence: a
   * hidden target and a target that was never there are the same record.
   *
   * The raw link text is safe to echo — it stands in a note the caller is
   * already reading.
   */
  outgoingLinks(view: Viewable, owner: string, path: string): LinkRow[] {
    const scope = scopeSql('l', 'source', view);
    const targetScope = scopeSql('l', 'target_path', view);
    return this.#db
      .all(
        `SELECT l.owner, l.source, l.target_raw,
                CASE WHEN ${targetScope.sql} THEN l.target_path END AS target_path,
                l.heading, l.alias, l.offset
           FROM links l
          WHERE l.owner = ? AND l.source = ? AND ${scope.sql}
          ORDER BY l.offset`,
        ...targetScope.params,
        owner,
        path,
        ...scope.params,
      )
      .map(toLinkRow);
  }

  /**
   * Links whose target does not exist — a finding, not an error.
   *
   * Except a daily note's link to a day nobody has written yet. The template
   * links yesterday and tomorrow before either exists, and the link fills in by
   * itself the day that note is written; counting it would make every daily
   * note lower the health score for doing exactly what it is meant to. The rule
   * is `isPendingDayLink` in `shared/journal.ts`, applied here so the tidy list,
   * the overview count, the attention total and the tree markers all get it.
   */
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
      .map(toLinkRow)
      .filter((link) => !isPendingDayLink(link.source, link.targetRaw));
  }

  /**
   * Notes nothing links to.
   *
   * "Nothing" means nothing the caller may see, so the subquery carries the view
   * as well. Without it the answer is computed from links the caller was never
   * given: a note in a shared folder that only a private note points at would
   * drop off the list, and its absence would say that an invisible note links to
   * it — the shape the node degree in `graph()` had, where it proved real.
   *
   * Every caller today passes a bare owner, which makes the condition the
   * identity and changes nothing. It is here so that the next one does not have
   * to know. The target side needs no condition of its own: `l.target_path` is
   * `n.path`, and `n` is already inside the view.
   */
  orphans(view: Viewable): NoteRow[] {
    const scope = scopeSql('n', 'path', view);
    const linkScope = scopeSql('l', 'source', view);
    return this.#db
      .all(
        `SELECT n.owner, n.path, n.title, n.size, n.mtime_ms
           FROM notes n
          WHERE ${scope.sql}
            AND NOT EXISTS (
                  SELECT 1 FROM links l
                   WHERE l.owner = n.owner AND l.target_path = n.path
                     AND ${linkScope.sql}
                )
          ORDER BY n.mtime_ms DESC`,
        ...scope.params,
        ...linkScope.params,
      )
      .map(toNoteRow)
      // A daily note is reached by its date, through the journal calendar, and
      // today's is linked from nothing until tomorrow's is written. Neither
      // makes it lost, which is what "orphaned" is meant to say.
      .filter((note) => !isDailyNote(note.path));
  }

  /**
   * Notes carrying no tag.
   *
   * The subquery looks like the one in `orphans` and is not the same shape: it
   * is bound to `n` on both columns, so it can only ever ask about the note in
   * front of it. There is no row it could find that belongs to somebody else,
   * and therefore nothing a view would restrict.
   */
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

  /**
   * Notes untouched for longer than `days`.
   *
   * Not daily notes: a day's entry is finished when the day is, and last
   * spring's journal is not neglected, it is last spring's journal.
   */
  stale(view: Viewable, days = DEFAULT_SETTINGS.staleDays, now = Date.now()): NoteRow[] {
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const scope = scopeSql('n', 'path', view);
    return this.#db
      .all(
        `SELECT n.owner, n.path, n.title, n.size, n.mtime_ms FROM notes n
          WHERE ${scope.sql} AND n.mtime_ms < ? ORDER BY n.mtime_ms ASC`,
        ...scope.params,
        Math.trunc(cutoff),
      )
      .map(toNoteRow)
      .filter((note) => !isDailyNote(note.path));
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
   * Untagged notes, but only where being untagged is a defect.
   *
   * The single place the rule lives, so the count and the list cannot disagree.
   * Applying it at one call site and not the other made the overview declare that
   * tagging is not a convention in this vault while the tidy table listed every
   * note as untagged — two views contradicting each other about the same vault,
   * and a table that is mostly noise for somebody meant to work through it.
   */
  untaggedFindings(view: Viewable): NoteRow[] {
    return this.tagsInUse(view) ? this.untagged(view) : [];
  }

  /**
   * The displaced versions `conflictPath` (`notes/service.ts`) wrote aside instead
   * of losing them to a concurrent write.
   *
   * Recognition is not a second, hand-written pattern: `parseConflictPath` in that
   * same module is the one place that reads the name back, so this and the write
   * path cannot drift apart — `conflicts.test.ts` checks both against each other.
   *
   * `n.path LIKE` is only a coarse prefilter to keep the scan cheap; an ordinary
   * note whose title happens to contain "(Konflikt" is ruled back out by the exact
   * parse below.
   *
   * The security shape matches `outgoingLinks`: the copy's own name already tells
   * the caller what path it displaced — they are already reading a note in their
   * view that says so — so echoing `originalPath` back is not a new leak. Whether
   * that note **still exists** is the sensitive half, and it is answered with the
   * same view the candidate list itself was scoped to. An original outside the
   * caller's view must read exactly like a deleted one; anything else turns this
   * finding into an oracle for "something you can't see is still there."
   */
  conflictCopies(view: Viewable): ConflictRow[] {
    const scope = scopeSql('n', 'path', view);
    const candidates = this.#db.all(
      `SELECT n.owner, n.path, n.title, n.size, n.mtime_ms
         FROM notes n
        WHERE ${scope.sql} AND n.path LIKE '%(Konflikt%).md'`,
      ...scope.params,
    );

    const originalScope = scopeSql('o', 'path', view);
    // `LOWER(...)`, not `=`: `conflictPath` strips the original's extension
    // case-insensitively but always writes the copy's own extension in
    // lowercase, so a original named e.g. "Plan.MD" (a legal note — `isNotePath`
    // accepts any case) is indistinguishable, from the copy's name alone, from
    // one named "Plan.md". `parseConflictPath` has to guess, and always guesses
    // lowercase. A case-sensitive lookup on that guess would then call an
    // existing original "gone" for no reason but a letter's case. This is safe
    // to widen only here: the case-collision guard in `notes/service.ts`
    // already refuses two sibling notes that differ solely by case, so at most
    // one note can ever match, and it is still pinned to this exact owner and
    // to the caller's view.
    const findOriginal = (owner: string, path: string): { title: string } | undefined =>
      this.#db.get<{ title: string }>(
        `SELECT o.title AS title FROM notes o
          WHERE o.owner = ? AND LOWER(o.path) = LOWER(?) AND ${originalScope.sql}`,
        owner,
        path,
        ...originalScope.params,
      );

    const out: ConflictRow[] = [];
    for (const row of candidates) {
      const notePath = String(row['path']);
      const info = parseConflictPath(notePath);
      if (info === null) continue;

      const owner = String(row['owner']);
      const original = findOriginal(owner, info.originalPath);
      out.push({
        owner,
        path: notePath,
        title: String(row['title']),
        size: Number(row['size']),
        mtimeMs: Number(row['mtime_ms']),
        originalPath: info.originalPath,
        originalTitle: original?.title ?? null,
        originalExists: original !== undefined,
        at: info.at,
      });
    }

    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
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
  attentionCount(view: Viewable, staleDays?: number): number {
    const paths = new Set<string>();
    for (const note of this.orphans(view)) paths.add(note.path);
    for (const note of this.stale(view, staleDays)) paths.add(note.path);
    for (const link of this.deadLinks(view)) paths.add(link.source);
    for (const note of this.untaggedFindings(view)) paths.add(note.path);
    for (const conflict of this.conflictCopies(view)) paths.add(conflict.path);
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
      .map(toTaskRow);
  }

  /**
   * The full task list behind `openTasks`, with the folder filter and the
   * "include done" toggle the task view needs.
   *
   * Ordered by owner, then path, then line — the same order the task view
   * groups by note in, so the client can do that grouping in one pass over
   * this list rather than a second request per note.
   */
  tasks(view: Viewable, filter: TaskFilter = {}): TaskRow[] {
    const scope = scopeSql('t', 'path', view);
    const extra = taskFilterSql(filter);
    const limit = Math.trunc(filter.limit ?? 1000);

    return this.#db
      .all(
        `SELECT t.owner, t.path, t.line, t.done, t.text FROM tasks t
          WHERE ${scope.sql}${extra.sql} ORDER BY t.owner, t.path, t.line LIMIT ?`,
        ...scope.params,
        ...extra.params,
        limit,
      )
      .map(toTaskRow);
  }

  /**
   * How many tasks match `filter`, ignoring its `limit` — the real total behind
   * a capped `tasks()` answer, so the task view can say what it left out rather
   * than let a `slice` look like the whole list.
   */
  taskCount(view: Viewable, filter: TaskFilter = {}): number {
    const scope = scopeSql('t', 'path', view);
    const extra = taskFilterSql(filter);
    const row = this.#db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tasks t WHERE ${scope.sql}${extra.sql}`,
      ...scope.params,
      ...extra.params,
    );
    return Number(row?.n ?? 0);
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
          AND a.tool IN (${AGENT_READ_TOOLS.map(() => '?').join(', ')})
        ORDER BY at DESC
        LIMIT ?`,
      owner,
      Math.trunc(sinceMs),
      owner,
      Math.trunc(sinceMs),
      // From the list above rather than spelled out again here: the two had
      // already drifted once — a tool added to one was missing from the other,
      // and the pulse then silently stopped reporting that kind of read.
      ...AGENT_READ_TOOLS,
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
      // Always the caller: both halves of the union are filtered on this owner.
      // Carried explicitly rather than left implicit, because the network view
      // keys its nodes by (owner, path) and silently had `undefined` here —
      // which meant no pulse ever matched a node and the live highlight never
      // once fired. An invariant the client has to reconstruct is a bug waiting.
      owner,
    }));
  }

  /**
   * The caller's own activity, bucketed into days.
   *
   * `bounds` are the day boundaries, ascending: n + 1 timestamps make n days.
   * The client computes them as its own local midnights, which is the only
   * place that knows where a day begins — a fixed server-side offset would put
   * an edit at 00:30 on the wrong day whenever daylight saving changes inside
   * the window.
   *
   * Own vault only, on exactly the reasoning `pulse` gives: when somebody works
   * and how much is information about that person, and a share is not consent
   * to being watched. There is no owner parameter to get wrong.
   *
   * Agent writes are counted from the access log rather than from `edits`,
   * because only the access log knows that a key made them. The same write is
   * also in `edits` under the key's name, and therefore also in `edited`: the
   * two numbers answer different questions — what changed, and who changed it.
   */
  dailyActivity(owner: string, bounds: readonly number[]): ActivityDay[] {
    const days: ActivityDay[] = [];
    for (let i = 0; i + 1 < bounds.length; i += 1) {
      days.push({
        start: bounds[i]!,
        end: bounds[i + 1]!,
        created: 0,
        edited: 0,
        deleted: 0,
        renamed: 0,
        touched: 0,
        agentReads: 0,
        agentWrites: 0,
      });
    }
    if (days.length === 0) return days;

    const values = days.map(() => '(?, ?, ?)').join(', ');
    const buckets: SqlValue[] = days.flatMap((day, i) => [i, Math.trunc(day.start), Math.trunc(day.end)]);

    const edits = this.#db.all(dailyEditsSql(days.length), ...buckets, owner);
    for (const row of edits) {
      const day = days[Number(row['i'])];
      if (day === undefined) continue;
      day.created = Number(row['created']);
      day.edited = Number(row['edited']);
      day.deleted = Number(row['deleted']);
      day.renamed = Number(row['renamed']);
      day.touched = Number(row['touched']);
    }

    const reads = AGENT_READ_TOOLS.map(() => '?').join(', ');
    const writes = AGENT_WRITE_TOOLS.map(() => '?').join(', ');
    const access = this.#db.all(
      `WITH b(i, lo, hi) AS (VALUES ${values})
       SELECT b.i AS i,
              SUM(a.tool IN (${reads}))  AS reads,
              SUM(a.tool IN (${writes})) AS writes
         FROM b JOIN access_log a ON a.owner = ? AND a.at >= b.lo AND a.at < b.hi AND a.allowed = 1
        GROUP BY b.i`,
      // In the order the placeholders appear: the CTE, the select list, the join.
      ...buckets,
      ...AGENT_READ_TOOLS,
      ...AGENT_WRITE_TOOLS,
      owner,
    );
    for (const row of access) {
      const day = days[Number(row['i'])];
      if (day === undefined) continue;
      day.agentReads = Number(row['reads'] ?? 0);
      day.agentWrites = Number(row['writes'] ?? 0);
    }

    return days;
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
    nodes: Array<{
      owner: string;
      path: string;
      title: string;
      folder: string;
      links: number;
      tags: string[];
      updatedAt: number;
    }>;
    edges: Array<{ owner: string; from: string; to: string }>;
  } {
    // The degree counts the same links the edges below draw, and it has to be
    // filtered by the same rule. A count is a smaller leak than a path but it
    // is still one: an unfiltered degree on a shared note says how many notes
    // link to it from the parts of the vault the caller was not given, and it
    // moves whenever the owner writes one. Both ends must be in view — one of
    // them is `n` itself and already is, so in practice this asks about the
    // other one.
    const degSourceScope = scopeSql('l', 'source', view);
    const degTargetScope = scopeSql('l', 'target_path', view);
    const nodeScope = scopeSql('n', 'path', view);
    const nodes = this.#db
      .all(
        `SELECT n.owner, n.path, n.title, n.mtime_ms,
                (SELECT COUNT(*) FROM links l
                  WHERE l.owner = n.owner AND l.target_path IS NOT NULL
                    AND ${degSourceScope.sql} AND ${degTargetScope.sql}
                    AND (l.source = n.path OR l.target_path = n.path)) AS deg
           FROM notes n
          WHERE ${nodeScope.sql}
          ORDER BY n.path`,
        ...degSourceScope.params,
        ...degTargetScope.params,
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
          tags: [] as string[],
          updatedAt: Number(row['mtime_ms']),
        };
      });

    // Tags for every node above, in one query rather than one per node — the
    // endpoint has no limit, so a correlated subquery per note (the shape
    // `vaultMap` uses, capped at 5000 rows) would not scale the same way here.
    // Same `scopeSql` fragment as the nodes, on the same `path` column: a tag
    // must be exactly as visible as the note that carries it, never more.
    const tagScope = scopeSql('t', 'path', view);
    const tagsByNode = new Map<string, string[]>();
    for (const row of this.#db.all(
      `SELECT t.owner, t.path, t.tag FROM tags t WHERE ${tagScope.sql} ORDER BY t.path, t.tag`,
      ...tagScope.params,
    )) {
      const key = `${row['owner']}\u0000${row['path']}`;
      const list = tagsByNode.get(key);
      if (list) list.push(String(row['tag']));
      else tagsByNode.set(key, [String(row['tag'])]);
    }
    for (const node of nodes) {
      node.tags = tagsByNode.get(`${node.owner}\u0000${node.path}`) ?? [];
    }

    // Both ends, not just the source. An edge whose target lies outside the
    // view would otherwise draw a line to a path the caller may not read — the
    // same leak as in `outgoingLinks`, one representation further along.
    //
    // Here it is a `WHERE` rather than the projection used there, and for a
    // reason particular to this shape: the graph already leaves out every
    // unresolved link (`target_path IS NOT NULL`), so absence is what a target
    // that does not exist looks like as well. Dropping the edge says nothing
    // the dead-link case does not say too — and there is no half-edge to draw.
    const edgeScope = scopeSql('l', 'source', view);
    const edgeTargetScope = scopeSql('l', 'target_path', view);
    const edges = this.#db
      .all(
        `SELECT DISTINCT l.owner, l.source, l.target_path
           FROM links l
          WHERE ${edgeScope.sql} AND ${edgeTargetScope.sql}
            AND l.target_path IS NOT NULL AND l.target_path <> l.source`,
        ...edgeScope.params,
        ...edgeTargetScope.params,
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
    // With the edit time: a note share reaches its path's edits only from when
    // it came to name that path, never those of an earlier note of that name.
    const scope = scopeSql('e', 'path', view, 'at');
    return this.#db
      .all(
        `SELECT e.owner,
                e.path,
                MAX(e.at)                                        AS at,
                COUNT(*)                                         AS edits,
                -- The actor and action of the most recent edit for this note.
                --
                -- rowid breaks the tie, and it has to: at is in milliseconds,
                -- and a create followed by a delete fits inside one of them.
                -- Ordered by time alone, which of the two counts as the last
                -- edit is left to the database, so the log could report a note
                -- as created that is already deleted.
                (SELECT actor  FROM edits x
                  WHERE x.owner = e.owner AND x.path = e.path
                  ORDER BY x.at DESC, x.rowid DESC LIMIT 1)      AS actor,
                (SELECT action FROM edits x
                  WHERE x.owner = e.owner AND x.path = e.path
                  ORDER BY x.at DESC, x.rowid DESC LIMIT 1)      AS action,
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

  /**
   * Notes deleted through ndBrain since `sinceMs` and not back since, newest
   * first — within the regions the caller may bring a note back into.
   *
   * A delete counts while it is the last thing that happened to its path. Any
   * later edit there — a restore, a new note of that name, a rename onto it —
   * ends it. So does a restore that had to take another name
   * (`restoredPath`): the note is back, only somewhere else.
   *
   * Scoped by `restoreScopes`, not by the read view: the title and the path of
   * a deleted note are its content, and only somebody who could put the note
   * back may see them. That leaves out every note share, which is exactly the
   * grant the delete withdrew.
   */
  deletedNotes(
    view: Viewable,
    sinceMs: number,
    limit = 200,
    only?: { owner: string; path: string },
  ): DeletedRow[] {
    const scope = scopeSql('e', 'path', restoreScopes(view));
    const narrow = only === undefined ? '' : 'AND e.owner = ? AND e.path = ?';
    const narrowParams = only === undefined ? [] : [only.owner, only.path];
    const rows = this.#db.all(
      `SELECT e.owner, e.path, MAX(e.at) AS at,
              (SELECT actor FROM edits x
                WHERE x.owner = e.owner AND x.path = e.path AND x.action = 'delete'
                ORDER BY x.at DESC, x.rowid DESC LIMIT 1) AS actor
         FROM edits e
        WHERE ${scope.sql} AND e.action = 'delete' AND e.at >= ? ${narrow}
          AND NOT EXISTS (SELECT 1 FROM edits y
                           WHERE y.owner = e.owner AND y.path = e.path
                             AND y.action <> 'delete'
                             -- Ordered by the row, not only by the millisecond:
                             -- a note created and deleted within one tick of the
                             -- clock is deleted, and two rows of the same stamp
                             -- must not read as "it is back".
                             AND (y.at > e.at OR (y.at = e.at AND y.rowid > e.rowid)))
        GROUP BY e.owner, e.path
        ORDER BY at DESC
        LIMIT ?`,
      ...scope.params,
      Math.trunc(sinceMs),
      ...narrowParams,
      Math.trunc(limit),
    );

    const out: DeletedRow[] = [];
    for (const row of rows) {
      const owner = String(row['owner']);
      const path = String(row['path']);
      const at = Number(row['at']);
      // A restore under another name: a create, after the delete, of a path
      // that names this one as its original.
      const base = `${path.replace(/\.md$/i, '')} (${RESTORED_WORD} `;
      const startsWithBase = prefixSql('path', base);
      const restoredElsewhere = this.#db
        .all(
          `SELECT path FROM edits
            WHERE owner = ? AND action = 'create' AND at >= ? AND ${startsWithBase.sql}`,
          owner,
          at,
          ...startsWithBase.params,
        )
        .some((copy) => restoredOriginal(String(copy['path'])) === path);
      if (restoredElsewhere) continue;
      out.push({ owner, path, title: noteTitleOf(path), actor: String(row['actor']), at });
    }
    return out;
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

function toTaskRow(row: Record<string, unknown>): TaskRow {
  return {
    owner: String(row['owner']),
    path: String(row['path']),
    line: Number(row['line']),
    done: Number(row['done']) === 1,
    text: String(row['text']),
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
