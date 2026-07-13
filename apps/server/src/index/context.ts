import { parseNote } from "../vault/parser.js";
import type { Database } from "../db/database.js";
import type { EmbeddingProvider } from "../embed/provider.js";
import { isNoneProvider } from "../embed/provider.js";
import type { VectorStore } from "../embed/store.js";
import type { SearchHit } from "./search.js";
import { searchNotes, backlinksOf, titleAndSnippetFor } from "./search.js";

export interface ContextResult {
  path: string;
  content: string;
  backlinks: string[];
  related: SearchHit[];
}

export interface BuildContextDeps {
  db: Database;
  read: (p: string) => Promise<string | null>;
  /**
   * Embedding provider + vector store for semantic `related`. Both optional and
   * independent of each other's presence — pass either, neither, or both.
   *
   * When both are given AND the provider isn't the `none` provider, `related` is
   * computed EXCLUSIVELY from the vector neighbors of THIS note's own ALREADY-STORED
   * chunk vectors (via `store.getNoteVectors` + `store.search`) — the title-FTS
   * strategy described below is NOT also run/merged in. This is a deliberate v1
   * simplification (vector-only, not vector+FTS-merged); a future revision could
   * RRF-fuse the two the way `hybridSearch` does, if title-FTS recall turns out to
   * still be worth keeping alongside semantic recall.
   *
   * `provider` is only used here to gate whether vector mode is attempted at all (its
   * `embed` is never called by `buildContext` - see Plan 5 I2: re-embedding a note's
   * full content on every `build_context` call added needless latency/cost and could
   * fail outright on an oversized note, even though the note's chunk vectors were
   * already sitting in the store from indexing). If the note has no stored vectors yet
   * (e.g. just written, not embedded), this falls back to the FTS-title strategy below
   * rather than embedding on the spot.
   *
   * Omit either field (or leave the provider as the `none` provider) to keep today's
   * FTS-title behavior below, unchanged — this is the default with no embedding
   * provider configured, so existing callers/tests see zero behavior change.
   */
  provider?: EmbeddingProvider;
  store?: VectorStore;
}

/**
 * Assembles a note with its context: content, backlinks, and related notes.
 *
 * @param deps - Database connection, a read function to load note content, and an
 *   optional embedding provider/store (see `BuildContextDeps`)
 * @param path - Path to the note
 * @param opts - Optional namespace filter and related notes limit
 * @returns ContextResult if the note exists, null otherwise
 *
 * Related notes:
 * - **With an embedding provider + store configured** (and the provider isn't `none`):
 *   vector neighbors of this note's own content (namespace-filtered, self-excluded,
 *   top `relatedLimit`). See `BuildContextDeps` for why this replaces rather than
 *   merges with the FTS strategy. If embedding the note or querying the store fails
 *   (provider unreachable, transient error, ...) this falls back to the FTS strategy
 *   below rather than failing the whole call — a broken/unreachable provider must
 *   never break `build_context`.
 * - **Otherwise** (no provider/store, or an explicit `none` provider): FTS5 full-text
 *   search (OR-mode recall) on the note's title tokens (or first words of the body if
 *   no title) — textual similarity, not semantic similarity. This is the original
 *   (Plan 2) behavior, unchanged.
 *
 * Both strategies are namespace-filtered (if a namespace is given), exclude the note
 * itself, and are limited to `relatedLimit` (default 5).
 */
export async function buildContext(
  deps: BuildContextDeps,
  path: string,
  opts?: { namespace?: string; relatedLimit?: number },
): Promise<ContextResult | null> {
  const { db, read, provider, store } = deps;
  const namespace = opts?.namespace;
  // Guard against unbounded/invalid relatedLimit input (mirrors the limit guard in search.ts).
  const relatedLimit =
    typeof opts?.relatedLimit === "number" && Number.isFinite(opts.relatedLimit) && opts.relatedLimit > 0
      ? opts.relatedLimit
      : 5;

  // Read the note content
  const content = await read(path);
  if (content === null) {
    return null;
  }

  let related: SearchHit[] | undefined;
  if (provider && store && !isNoneProvider(provider)) {
    related = vectorRelated(db, store, path, namespace, relatedLimit);
  }
  if (!related) {
    related = ftsTitleRelated(db, path, content, namespace, relatedLimit);
  }

  // Get backlinks
  const backlinks = backlinksOf(db, path);

  return {
    path,
    content,
    backlinks,
    related,
  };
}

/** Vector-neighbor `related`: uses the note's own ALREADY-STORED chunk vector(s) (its
 *  first/best chunk) as the search query — zero provider calls, see Plan 5 I2. Returns
 *  `undefined` (never throws) when the note has no stored vectors yet, or on any store
 *  error — either falls back to `ftsTitleRelated` in the caller. */
function vectorRelated(
  db: Database,
  store: VectorStore,
  path: string,
  namespace: string | undefined,
  relatedLimit: number,
): SearchHit[] | undefined {
  try {
    const [queryVector] = store.getNoteVectors(path);
    if (!queryVector) return undefined;
    const hits = store.search(queryVector, relatedLimit + 1, namespace);
    return hits
      .filter((hit) => hit.path !== path)
      .slice(0, relatedLimit)
      .map((hit, i) => {
        const { title, snippet } = titleAndSnippetFor(db, hit.path);
        return { path: hit.path, title, snippet, rank: i + 1 };
      });
  } catch (err) {
    console.warn(`buildContext: vector-related lookup failed, falling back to FTS: ${String(err)}`);
    return undefined;
  }
}

/** Original (Plan 2) FTS-title `related` strategy — see the module doc comment. */
function ftsTitleRelated(
  db: Database,
  path: string,
  content: string,
  namespace: string | undefined,
  relatedLimit: number,
): SearchHit[] {
  // Parse the note to extract title and body
  const parsed = parseNote(content);

  // Determine search query: use title tokens or fall back to first words of body
  let query: string;
  if (parsed.title) {
    // Use individual tokens from the title
    const tokens = parsed.title.split(/\s+/).filter(Boolean);
    query = tokens.join(" ");
  } else {
    // Fall back to first words of the body
    const words = parsed.body.split(/\s+/).slice(0, 5).filter(Boolean);
    query = words.join(" ");
  }

  // Search for related notes using the query. OR mode is used so a multi-word title
  // (e.g. "Deploy Guide") surfaces notes sharing ANY token, not requiring ALL tokens —
  // otherwise textually-related recall is needlessly narrow.
  const relatedHits = searchNotes(db, query, {
    namespace,
    limit: relatedLimit + 1, // Request one extra since we'll filter out the note itself
    match: "or",
  });

  // Filter out the note itself from related results
  return relatedHits.filter((hit) => hit.path !== path).slice(0, relatedLimit);
}
