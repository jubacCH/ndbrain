import type { Database } from "../db/database.js";

export interface SearchHit {
  path: string;
  title: string | null;
  snippet: string;
  rank: number;
}

/** Full-text search over the vault via FTS5 with bm25 ranking and optional namespace filter. */
export function searchNotes(
  db: Database,
  query: string,
  opts: { namespace?: string; limit?: number } = {},
): SearchHit[] {
  const limit = opts.limit ?? 20;
  const rows = db
    .prepare(
      `SELECT f.path, n.title, snippet(notes_fts, 2, '**', '**', '…', 12) AS snippet,
              bm25(notes_fts) AS rank
       FROM notes_fts f JOIN notes n ON n.path = f.path
       WHERE notes_fts MATCH ?
         AND (? IS NULL OR f.path LIKE ? || '%')
       ORDER BY rank LIMIT ?`,
    )
    .all(query, opts.namespace ?? null, opts.namespace ?? "", limit) as SearchHit[];
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
