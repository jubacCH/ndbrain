import type { Database } from "../db/database.js";

export interface SearchHit {
  path: string;
  title: string | null;
  snippet: string;
  rank: number;
}

/** Converts a raw user query into a safe FTS5 query: each token becomes a quoted phrase. */
function toFtsQuery(input: string): string {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replaceAll('"', '""')}"`)
    .join(" ");
}

/** Full-text search over the vault via FTS5 with bm25 ranking and optional namespace filter. */
export function searchNotes(
  db: Database,
  query: string,
  opts: { namespace?: string; limit?: number } = {},
): SearchHit[] {
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) return [];
  // Guard against unbounded/empty results from bad input.
  const limit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 20;
  const namespace = opts.namespace ?? null;
  // Case-sensitive literal prefix match (BINARY collation) so scope "myai/" never
  // matches "MYAI/…" — required for Plan 2 scope enforcement. No LIKE metachar concerns.
  const rows = db
    .prepare(
      `SELECT f.path, n.title, snippet(notes_fts, 2, '**', '**', '…', 12) AS snippet,
              bm25(notes_fts) AS rank
       FROM notes_fts f JOIN notes n ON n.path = f.path
       WHERE notes_fts MATCH ?
         AND (? IS NULL OR substr(f.path, 1, length(?)) = ?)
       ORDER BY rank LIMIT ?`,
    )
    .all(ftsQuery, namespace, namespace, namespace, limit) as SearchHit[];
  return rows;
}

/** Source paths of notes that contain a wikilink to the given note path. */
export function backlinksOf(db: Database, path: string): string[] {
  const bare = path.replace(/\.md$/, "");
  return (
    db
      .prepare("SELECT DISTINCT source_path FROM links WHERE target IN (?, ?) ORDER BY source_path")
      .all(bare, path) as Array<{ source_path: string }>
  ).map((r) => r.source_path);
}
