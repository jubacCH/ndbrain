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
 */
export class VectorStore {
  constructor(
    private readonly db: Database,
    private readonly dim: number,
  ) {}

  /** Replaces all chunk vectors for `path` with `chunks`. Throws if any vector's length !== dim. */
  upsertNote(path: string, chunks: VectorChunk[]): void {
    for (const chunk of chunks) {
      if (chunk.vector.length !== this.dim) {
        throw new Error(
          `VectorStore: dimension mismatch for ${path}#${chunk.ix}: expected ${this.dim}, got ${chunk.vector.length}`,
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
  }

  /** Removes all chunk vectors for `path` (no-op if none exist). */
  deleteNote(path: string): void {
    this.db.prepare("DELETE FROM vec_chunks WHERE note_path = ?").run(path);
  }

  /**
   * Nearest neighbors by cosine similarity (higher = better), one result per note (its
   * best/closest chunk), best-first, top `k`. `namespacePrefix` uses the same
   * case-sensitive literal-prefix scope rule as index/search.ts: empty/omitted means
   * unscoped, otherwise only paths starting with the prefix are in scope.
   */
  search(queryVec: number[], k: number, namespacePrefix?: string): VectorSearchHit[] {
    if (queryVec.length !== this.dim) {
      throw new Error(`VectorStore: dimension mismatch: expected ${this.dim}, got ${queryVec.length}`);
    }
    if (k <= 0) return [];

    const namespace = namespacePrefix ?? null;
    const rows = this.db
      .prepare(
        `SELECT note_path, embedding FROM vec_chunks
         WHERE (? IS NULL OR substr(note_path, 1, length(?)) = ?)`,
      )
      .all(namespace, namespace, namespace) as { note_path: string; embedding: Buffer }[];

    const bestByPath = new Map<string, number>();
    for (const row of rows) {
      const score = cosineSimilarity(queryVec, fromBlob(row.embedding));
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
