import type { Database } from "../db/database.js";
import type { EmbeddingProvider } from "../embed/provider.js";
import { isNoneProvider } from "../embed/provider.js";
import type { VectorSearchHit, VectorStore } from "../embed/store.js";

export interface SearchHit {
  path: string;
  title: string | null;
  snippet: string;
  rank: number;
}

/**
 * Converts a raw user query into a safe FTS5 query: each token becomes a quoted phrase.
 * `match: "and"` (default) joins tokens implicitly (FTS5 AND), requiring every token to match.
 * `match: "or"` joins tokens with explicit OR, matching any token.
 */
function toFtsQuery(input: string, match: "and" | "or" = "and"): string {
  const phrases = input
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replaceAll('"', '""')}"`);
  return phrases.join(match === "or" ? " OR " : " ");
}

/** Full-text search over the vault via FTS5 with bm25 ranking and optional namespace filter. */
export function searchNotes(
  db: Database,
  query: string,
  opts: { namespace?: string; limit?: number; match?: "and" | "or" } = {},
): SearchHit[] {
  const ftsQuery = toFtsQuery(query, opts.match ?? "and");
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

export interface HybridSearchOptions {
  namespace?: string;
  limit?: number;
  match?: "and" | "or";
  /** Embedding provider used to embed the query. Omit (or `none`) to force pure-FTS behavior. */
  provider?: EmbeddingProvider;
  /** Namespace-scoped nearest-neighbor store to rank against. Required together with `provider`. */
  store?: VectorStore;
}

/** Reciprocal Rank Fusion constant: dampens the influence of any single rank position. */
const RRF_K = 60;
/** Candidate pool pulled from each ranked list before fusion, so RRF has enough material to work with. */
const CANDIDATE_POOL_SIZE = 30;

/**
 * Hybrid FTS + vector search, fused via Reciprocal Rank Fusion (RRF, k=60):
 * `score(doc) = Σ 1/(RRF_K + rank)` summed over every ranked list the doc appears in
 * (rank is 1-based). Falls back to plain `searchNotes` — byte-for-byte identical
 * results, no added latency — whenever no provider/store is configured (or the
 * provider is the `none` provider), so vaults without embeddings see zero behavior
 * change (no-regression guarantee). A query-embedding failure (provider throws or is
 * unreachable) is caught and also falls back to FTS-only: a broken/unreachable
 * provider must never fail a search.
 *
 * `rank` on the returned hits is the fused position (1-based, ascending = better),
 * matching the ascending-is-better convention `searchNotes` already uses for bm25.
 * For a hit that only the vector branch found (no FTS match), `title`/`snippet` fall
 * back to the note's stored title and the start of its indexed body (empty if the note
 * has no FTS row, e.g. a stale/orphaned vector).
 */
export async function hybridSearch(
  db: Database,
  query: string,
  opts: HybridSearchOptions = {},
): Promise<SearchHit[]> {
  const { namespace, match, provider, store } = opts;
  const limit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 20;

  if (!provider || !store || isNoneProvider(provider)) {
    return searchNotes(db, query, { namespace, limit, match });
  }

  const poolSize = Math.max(limit * 3, CANDIDATE_POOL_SIZE);
  const ftsHits = searchNotes(db, query, { namespace, limit: poolSize, match });

  let vectorHits: VectorSearchHit[];
  try {
    const [vector] = await provider.embed([query]);
    if (!vector) return ftsHits.slice(0, limit);
    vectorHits = store.search(vector, poolSize, namespace);
  } catch (err) {
    console.warn(`hybridSearch: query embedding failed, falling back to FTS-only search: ${String(err)}`);
    return ftsHits.slice(0, limit);
  }

  return fuseByRrf(db, ftsHits, vectorHits, limit);
}

/** Fuses FTS and vector rankings by Reciprocal Rank Fusion, merging hits by note path. */
function fuseByRrf(
  db: Database,
  ftsHits: SearchHit[],
  vectorHits: VectorSearchHit[],
  limit: number,
): SearchHit[] {
  const scores = new Map<string, number>();
  const addRanks = (paths: string[]) => {
    paths.forEach((path, i) => {
      scores.set(path, (scores.get(path) ?? 0) + 1 / (RRF_K + i + 1));
    });
  };
  addRanks(ftsHits.map((h) => h.path));
  addRanks(vectorHits.map((h) => h.path));

  const ftsByPath = new Map(ftsHits.map((h) => [h.path, h]));

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([path], i) => {
      const ftsHit = ftsByPath.get(path);
      if (ftsHit) return { ...ftsHit, rank: i + 1 };
      const { title, snippet } = titleAndSnippetFor(db, path);
      return { path, title, snippet, rank: i + 1 };
    });
}

/** Best-effort title/snippet lookup for a vector-only hit (no FTS match for the current query).
 *  Exported for reuse by `context.ts`'s vector-based `related` (same "no FTS row" situation). */
export function titleAndSnippetFor(db: Database, path: string): { title: string | null; snippet: string } {
  const row = db
    .prepare(
      `SELECT n.title AS title, f.body AS body
       FROM notes n LEFT JOIN notes_fts f ON f.path = n.path
       WHERE n.path = ?`,
    )
    .get(path) as { title: string | null; body: string | null } | undefined;
  if (!row) return { title: null, snippet: "" };
  return { title: row.title, snippet: (row.body ?? "").slice(0, 100) };
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
