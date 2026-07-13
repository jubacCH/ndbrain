import type { Database } from "../db/database.js";

export interface VectorChunk {
  ix: number;
  vector: number[];
}

export interface VectorSearchHit {
  path: string;
  score: number;
}

function toBlob(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

function fromBlob(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

/** Cosine similarity in [-1, 1]; higher means more similar. */
function cosineSimilarity(a: number[], b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Namespace-scoped nearest-neighbor vector store, backed by the `vec_chunks` table
 * (see db/database.ts migration). Embeddings are stored as BLOBs (Float32Array bytes)
 * rather than via sqlite-vec's `vec0` virtual table: `vec0` requires a fixed vector
 * width in its `CREATE VIRTUAL TABLE ... embedding FLOAT[N]` DDL, but the shared schema
 * migrator (`openDatabase(path)`) has no access to the runtime-configured embedding
 * dimension — that only becomes known once a provider/model is configured (see
 * embed/config.ts), which happens after the DB is opened. A dimension-agnostic BLOB
 * column lets the migration stay generic; `VectorStore` validates the dimension it was
 * constructed with instead. Similarity search is a JS cosine scan over
 * namespace-filtered candidate rows, which is fast enough for homelab-sized vaults
 * (thousands of chunks) — see the Task 2 report for the sqlite-vec spike that informed
 * this choice (the extension itself loads fine in node:22-slim).
 *
 * Dimension is SELF-ADAPTING, not frozen at construction (Plan 5 C1 fix): the
 * openai/ollama providers only learn their real embedding width lazily, from their
 * first successful `embed()` call (`provider.dim` reports 0 until then; see
 * embed/provider.ts). Locking the store to a dim captured before that first call
 * (e.g. `new VectorStore(db, embedProvider.dim)` at boot) would freeze it at 0
 * forever, so every upsert/search would throw a dimension-mismatch error - with no
 * NDBRAIN_EMBEDDING_DIM override configured (as documented in docker-compose.yml),
 * that made the whole embeddings feature permanently non-functional plus an infinite
 * provider-retry loop. Instead: the constructor's `dimHint` is optional (an
 * NDBRAIN_EMBEDDING_DIM override, if set); if omitted, the store learns its dim from
 * any existing `vec_chunks` rows on construction, or - if there are none yet - adopts
 * the width of the first vector it's asked to store via `upsertNote`.
 */
export class VectorStore {
  private warnedStaleDim = false;
  private dim: number;

  constructor(
    private readonly db: Database,
    dimHint?: number,
  ) {
    this.dim = dimHint ?? this.learnDimFromExistingRows();
  }

  /** Best-effort: peeks at one existing row to recover the dim of a store re-opened
   *  against a DB that already has vectors (e.g. after a restart). Returns 0 (unknown)
   *  if there are no rows yet. */
  private learnDimFromExistingRows(): number {
    const row = this.db.prepare("SELECT embedding FROM vec_chunks LIMIT 1").get() as
      | { embedding: Buffer }
      | undefined;
    return row ? fromBlob(row.embedding).length : 0;
  }

  /** Replaces all chunk vectors for `path` with `chunks`. If the store's dim is still
   *  unknown (0), it's ADOPTED from the first vector in this batch rather than
   *  required up front (see class doc comment). Throws if any vector in the batch
   *  doesn't match the (now-known) dim. */
  upsertNote(path: string, chunks: VectorChunk[]): void {
    const effectiveDim = this.dim !== 0 ? this.dim : (chunks[0]?.vector.length ?? 0);
    for (const chunk of chunks) {
      if (chunk.vector.length !== effectiveDim) {
        throw new Error(
          `VectorStore: dimension mismatch for ${path}#${chunk.ix}: expected ${effectiveDim}, got ${chunk.vector.length}`,
        );
      }
    }
    const del = this.db.prepare("DELETE FROM vec_chunks WHERE note_path = ?");
    const insert = this.db.prepare(
      "INSERT INTO vec_chunks (note_path, chunk_ix, embedding) VALUES (?, ?, ?)",
    );
    const apply = this.db.transaction((rows: VectorChunk[]) => {
      del.run(path);
      for (const chunk of rows) {
        insert.run(path, chunk.ix, toBlob(chunk.vector));
      }
    });
    apply(chunks);
    if (chunks.length > 0) this.dim = effectiveDim;
  }

  /** Removes all chunk vectors for `path` (no-op if none exist). */
  deleteNote(path: string): void {
    this.db.prepare("DELETE FROM vec_chunks WHERE note_path = ?").run(path);
  }

  /** Whether the store currently holds zero chunk vectors — used at startup to decide
   *  whether a first-run background reindex is needed once an embedding provider is
   *  turned on (see main.ts). */
  isEmpty(): boolean {
    const row = this.db.prepare("SELECT 1 FROM vec_chunks LIMIT 1").get();
    return row === undefined;
  }

  /** Returns `path`'s already-stored chunk vectors, ordered by chunk index (empty array
   *  if the note has none yet, e.g. just written and not embedded). Lets callers (e.g.
   *  `build_context`'s `related`) reuse a note's own vectors as a search query instead
   *  of re-embedding its content on every call (Plan 5 I2). */
  getNoteVectors(path: string): number[][] {
    const rows = this.db
      .prepare("SELECT embedding FROM vec_chunks WHERE note_path = ? ORDER BY chunk_ix")
      .all(path) as { embedding: Buffer }[];
    return rows.map((row) => Array.from(fromBlob(row.embedding)));
  }

  /**
   * Nearest neighbors by cosine similarity (higher = better), one result per note (its
   * best/closest chunk), best-first, top `k`. `namespacePrefix` uses the same
   * case-sensitive literal-prefix scope rule as index/search.ts: empty/omitted means
   * unscoped, otherwise only paths starting with the prefix are in scope.
   *
   * Self-adapting dim: the comparison dim for this call is simply `queryVec.length` -
   * there's no separate "store dim" to validate the query against, so a store with an
   * as-yet-unknown/unlearned dim (e.g. nothing has been upserted yet) can still search
   * once given a real query vector. Stored rows of a different width (stale, from a
   * prior model/provider) are skipped, same as before.
   */
  search(queryVec: number[], k: number, namespacePrefix?: string): VectorSearchHit[] {
    if (k <= 0) return [];

    const dim = queryVec.length;
    const namespace = namespacePrefix ?? null;
    const rows = this.db
      .prepare(
        `SELECT note_path, embedding FROM vec_chunks
         WHERE (? IS NULL OR substr(note_path, 1, length(?)) = ?)`,
      )
      .all(namespace, namespace, namespace) as { note_path: string; embedding: Buffer }[];

    const bestByPath = new Map<string, number>();
    for (const row of rows) {
      const stored = fromBlob(row.embedding);
      // Skip vectors with mismatched dimension (likely stale after a model/provider switch).
      if (stored.length !== dim) {
        if (!this.warnedStaleDim) {
          console.warn(
            `VectorStore: skipping vector for ${row.note_path} with stale dimension ${stored.length} (expected ${dim}); consider re-embedding`,
          );
          this.warnedStaleDim = true;
        }
        continue;
      }
      const score = cosineSimilarity(queryVec, stored);
      const prev = bestByPath.get(row.note_path);
      if (prev === undefined || score > prev) {
        bestByPath.set(row.note_path, score);
      }
    }

    return [...bestByPath.entries()]
      .map(([path, score]) => ({ path, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}
