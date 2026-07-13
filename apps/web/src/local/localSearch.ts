/**
 * On-device search over local notes (Task 4). Pure and framework-free: no
 * embeddings, no network, no `@ndbrain/server` — everything runs in-memory
 * via MiniSearch so a search never leaves the device. Kept separate from
 * `localStore.ts` so the indexing/query logic is testable without Tauri.
 */
import MiniSearch from "minisearch";

/** A local note as loaded from disk, ready to be indexed. */
export interface LocalNoteDoc {
  path: string;
  title: string | null;
  content: string;
}

interface IndexedDoc {
  path: string;
  title: string;
  content: string;
}

export type LocalSearchIndex = MiniSearch<IndexedDoc>;

export interface LocalSearchHit {
  path: string;
  title: string | null;
  score: number;
}

/** Builds a fresh in-memory MiniSearch index from local notes. Ranks title
 *  matches above body matches, and matches on word prefixes (so "migr" finds
 *  "migraine") plus light fuzzy matching for typos. */
export function buildLocalIndex(notes: LocalNoteDoc[]): LocalSearchIndex {
  const index: LocalSearchIndex = new MiniSearch<IndexedDoc>({
    idField: "path",
    fields: ["title", "content"],
    storeFields: ["path", "title"],
    searchOptions: {
      prefix: true,
      fuzzy: 0.2,
      boost: { title: 2 },
    },
  });
  index.addAll(notes.map((note) => ({ path: note.path, title: note.title ?? "", content: note.content })));
  return index;
}

/** Queries a local index. An empty/blank query (or an empty index) always
 *  returns no hits rather than falling through to MiniSearch's own handling
 *  of empty input. */
export function searchLocal(index: LocalSearchIndex, query: string): LocalSearchHit[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  return index.search(trimmed).map((hit) => ({
    path: hit.id as string,
    title: (hit.title as string) || null,
    score: hit.score,
  }));
}
