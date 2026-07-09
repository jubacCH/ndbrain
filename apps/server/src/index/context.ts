import { parseNote } from "../vault/parser.js";
import type { Database } from "../db/database.js";
import type { SearchHit } from "./search.js";
import { searchNotes, backlinksOf } from "./search.js";

export interface ContextResult {
  path: string;
  content: string;
  backlinks: string[];
  related: SearchHit[];
}

/**
 * Assembles a note with its context: content, backlinks, and textually-related notes.
 *
 * @param deps - Database connection and a read function to load note content
 * @param path - Path to the note
 * @param opts - Optional namespace filter and related notes limit
 * @returns ContextResult if the note exists, null otherwise
 *
 * Related notes are found via FTS5 full-text search (OR-mode recall) on the note's
 * title tokens (or first words of the body if no title). This provides textual
 * similarity but not semantic similarity (embeddings are Plan 5). Related results are:
 * - Namespace-filtered (if namespace is provided)
 * - Exclude the note itself
 * - Limited to relatedLimit (default 5)
 */
export async function buildContext(
  deps: { db: Database; read: (p: string) => Promise<string | null> },
  path: string,
  opts?: { namespace?: string; relatedLimit?: number },
): Promise<ContextResult | null> {
  const { db, read } = deps;
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
  const related = relatedHits.filter((hit) => hit.path !== path).slice(0, relatedLimit);

  // Get backlinks
  const backlinks = backlinksOf(db, path);

  return {
    path,
    content,
    backlinks,
    related,
  };
}
