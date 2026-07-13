import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.js";
import { VectorStore } from "./store.js";
import { EmbeddingIndexer } from "./indexer.js";
import type { EmbeddingProvider } from "./provider.js";

const DIM = 3;

/**
 * Replicates the real openai/ollama providers' lazy-dim contract (see provider.ts):
 * `dim` reports 0 until the first `embed()` call resolves, at which point it reports
 * the actual vector width returned by the remote API. `cfg.dim` (NDBRAIN_EMBEDDING_DIM)
 * is deliberately left unset here, matching the documented docker-compose config that
 * doesn't set it.
 */
class LazyDimEmbeddingProvider implements EmbeddingProvider {
  readonly id = "lazy-dim-fake";
  private _dim = 0;
  constructor(private readonly vectorWidth: number) {}

  get dim(): number {
    return this._dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const vectors = texts.map(() => Array.from({ length: this.vectorWidth }, (_, i) => (i === 0 ? 1 : 0)));
    this._dim = this.vectorWidth;
    return vectors;
  }
}

function seeded() {
  const db = openDatabase(":memory:");
  return new VectorStore(db, DIM);
}

describe("VectorStore", () => {
  it("returns the nearest note first", () => {
    const store = seeded();
    store.upsertNote("a.md", [{ ix: 0, vector: [1, 0, 0] }]);
    store.upsertNote("b.md", [{ ix: 0, vector: [0, 1, 0] }]);

    const hits = store.search([0.9, 0.1, 0], 5);

    expect(hits.map((h) => h.path)).toEqual(["a.md", "b.md"]);
  });

  it("orders best-first by descending similarity score", () => {
    const store = seeded();
    store.upsertNote("a.md", [{ ix: 0, vector: [1, 0, 0] }]);
    store.upsertNote("b.md", [{ ix: 0, vector: [0, 1, 0] }]);

    const hits = store.search([0.9, 0.1, 0], 5);

    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("filters results by namespace prefix, excluding out-of-scope notes", () => {
    const store = seeded();
    store.upsertNote("myai/a.md", [{ ix: 0, vector: [1, 0, 0] }]);
    store.upsertNote("other/a.md", [{ ix: 0, vector: [1, 0, 0] }]);

    const hits = store.search([1, 0, 0], 5, "myai/");

    expect(hits.map((h) => h.path)).toEqual(["myai/a.md"]);
  });

  it("matches the namespace case-sensitively (scope enforcement)", () => {
    const store = seeded();
    store.upsertNote("myai/a.md", [{ ix: 0, vector: [1, 0, 0] }]);

    const hits = store.search([1, 0, 0], 5, "MYAI/");

    expect(hits).toEqual([]);
  });

  it("treats an empty namespace prefix as unscoped (matches everything)", () => {
    const store = seeded();
    store.upsertNote("a.md", [{ ix: 0, vector: [1, 0, 0] }]);
    store.upsertNote("b.md", [{ ix: 0, vector: [0, 1, 0] }]);

    const hits = store.search([1, 0, 0], 5, "");

    expect(hits.map((h) => h.path).sort()).toEqual(["a.md", "b.md"]);
  });

  it("removes a note's vectors via deleteNote", () => {
    const store = seeded();
    store.upsertNote("a.md", [{ ix: 0, vector: [1, 0, 0] }]);
    store.upsertNote("b.md", [{ ix: 0, vector: [0, 1, 0] }]);

    store.deleteNote("a.md");

    const hits = store.search([1, 0, 0], 5);
    expect(hits.map((h) => h.path)).toEqual(["b.md"]);
  });

  it("throws on vector dimension mismatch", () => {
    const store = seeded();
    expect(() => store.upsertNote("a.md", [{ ix: 0, vector: [1, 0] }])).toThrow();
  });

  it("returns one result per note using its closest chunk", () => {
    const store = seeded();
    // Chunk 0 is far from the query, chunk 1 is very close: the note should
    // appear exactly once, scored by its best (closest) chunk.
    store.upsertNote("a.md", [
      { ix: 0, vector: [0, 1, 0] },
      { ix: 1, vector: [1, 0, 0] },
    ]);
    store.upsertNote("b.md", [{ ix: 0, vector: [0, 0, 1] }]);

    const hits = store.search([1, 0, 0], 5);

    expect(hits.filter((h) => h.path === "a.md")).toHaveLength(1);
    expect(hits[0].path).toBe("a.md");
  });

  it("replaces previous vectors for a note on re-upsert", () => {
    const store = seeded();
    store.upsertNote("a.md", [{ ix: 0, vector: [0, 1, 0] }]);
    store.upsertNote("a.md", [{ ix: 0, vector: [1, 0, 0] }]);

    const hits = store.search([1, 0, 0], 5);

    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe("a.md");
    expect(hits[0].score).toBeCloseTo(1, 5);
  });

  it("skips stale-dimension vectors (e.g., after provider/model switch) without crashing", () => {
    const db = openDatabase(":memory:");
    const store = new VectorStore(db, DIM);

    // Upsert a note with correct 3D vectors.
    store.upsertNote("correct.md", [{ ix: 0, vector: [1, 0, 0] }]);

    // Directly insert a row with a mismatched 2D vector (simulating a stale embedding).
    const staleVec = new Float32Array([0.5, 0.5]);
    const blob = Buffer.from(staleVec.buffer);
    db.prepare("INSERT INTO vec_chunks (note_path, chunk_ix, embedding) VALUES (?, ?, ?)").run(
      "stale.md",
      0,
      blob,
    );

    // Search should only return the correctly-dimensioned note, skip the stale one.
    const hits = store.search([1, 0, 0], 5);

    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe("correct.md");
  });

  describe("isEmpty", () => {
    it("is true for a store with no vectors", () => {
      const store = seeded();
      expect(store.isEmpty()).toBe(true);
    });

    it("is false once any vector has been upserted", () => {
      const store = seeded();
      store.upsertNote("a.md", [{ ix: 0, vector: [1, 0, 0] }]);
      expect(store.isEmpty()).toBe(false);
    });

    it("is true again after the last note's vectors are deleted", () => {
      const store = seeded();
      store.upsertNote("a.md", [{ ix: 0, vector: [1, 0, 0] }]);
      store.deleteNote("a.md");
      expect(store.isEmpty()).toBe(true);
    });
  });

  describe("self-adapting dimension (C1 regression)", () => {
    it("replicates main.ts's boot wiring: a provider whose dim is unknown at construction still works end-to-end", async () => {
      // This is exactly how main.ts wires things: loadEmbeddingConfig(process.env) with no
      // NDBRAIN_EMBEDDING_DIM set -> createEmbeddingProvider(...) whose .dim reports 0 until
      // the first embed() -> `new VectorStore(db)` with no dim hint. Against the old
      // frozen-dim VectorStore(db, embedProvider.dim), dim would be permanently locked to 0
      // and every upsert/search below would throw a dimension-mismatch error.
      const db = openDatabase(":memory:");
      const provider = new LazyDimEmbeddingProvider(5);
      expect(provider.dim).toBe(0); // unknown until first embed, like openai/ollama

      const store = new VectorStore(db); // no dim hint: must be learned, not required
      const indexer = new EmbeddingIndexer(provider, store);

      indexer.enqueue("a.md", "Some note content to embed.");
      await indexer.flush();

      // The store must have adopted the provider's real (5-wide) dim from the first
      // embed, rather than staying frozen at an initial/unknown dim.
      const [queryVector] = await provider.embed(["Some note content to embed."]);
      const hits = store.search(queryVector, 5);
      expect(hits.map((h) => h.path)).toEqual(["a.md"]);
    });
  });
});
