import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/database.js";
import type { Database } from "../db/database.js";
import { createEmbeddingProvider } from "./provider.js";
import type { EmbeddingProvider } from "./provider.js";
import { VectorStore } from "./store.js";
import { EmbeddingIndexer } from "./indexer.js";

const DIM = 3;

/** Deterministic fake embedding: encodes each text's length so tests can tell which content was embedded. */
function vectorFor(text: string): number[] {
  return [text.length, 0, 0];
}

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id = "fake";
  readonly dim = DIM;
  readonly calls: string[][] = [];

  constructor(private readonly impl?: (texts: string[]) => Promise<number[][]>) {}

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    if (this.impl) return this.impl(texts);
    return texts.map(vectorFor);
  }
}

function seeded(): { db: Database; store: VectorStore } {
  const db = openDatabase(":memory:");
  return { db, store: new VectorStore(db, DIM) };
}

function countChunks(db: Database, path: string): number {
  return (db.prepare("SELECT COUNT(*) as c FROM vec_chunks WHERE note_path = ?").get(path) as { c: number }).c;
}

describe("EmbeddingIndexer", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    warnSpy?.mockRestore();
  });

  it("embeds and stores a note's chunks after enqueue + flush", async () => {
    const { db, store } = seeded();
    const provider = new FakeEmbeddingProvider();
    const indexer = new EmbeddingIndexer(provider, store);
    // Two short paragraphs pack into a single chunk under the soft size cap.
    const markdown = "First paragraph.\n\nSecond paragraph.";

    indexer.enqueue("a.md", markdown);
    await indexer.flush();

    expect(countChunks(db, "a.md")).toBe(1);
    expect(provider.calls[0]).toEqual(["First paragraph.\n\nSecond paragraph."]);
    const hits = store.search(vectorFor(markdown), 5);
    expect(hits.map((h) => h.path)).toEqual(["a.md"]);
  });

  it("never blocks or throws from enqueue, and self-heals after a transient provider failure via retry", async () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, store } = seeded();
    let callCount = 0;
    const provider = new FakeEmbeddingProvider(async (texts) => {
      callCount++;
      if (callCount === 1) throw new Error("simulated provider outage");
      return texts.map(vectorFor);
    });
    const indexer = new EmbeddingIndexer(provider, store, { retryBaseDelayMs: 5, retryMaxDelayMs: 20 });

    expect(() => indexer.enqueue("a.md", "Hello world.")).not.toThrow();
    await indexer.flush();

    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(countChunks(db, "a.md")).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("is a no-op when no embedding provider is configured (leaves the store untouched)", async () => {
    const { db, store } = seeded();
    const provider = createEmbeddingProvider({ provider: "none" });
    const indexer = new EmbeddingIndexer(provider, store);

    indexer.enqueue("a.md", "Some content that would otherwise be embedded.");
    await indexer.flush();

    expect(countChunks(db, "a.md")).toBe(0);
    expect(indexer.size()).toBe(0);
  });

  it("coalesces rapid re-enqueues of the same path: only the latest content is embedded", async () => {
    const { db, store } = seeded();
    const provider = new FakeEmbeddingProvider();
    const indexer = new EmbeddingIndexer(provider, store);
    const latest = "a much longer second version of the note content";

    indexer.enqueue("a.md", "short first version");
    indexer.enqueue("a.md", latest);
    await indexer.flush();

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toEqual([latest]);
    expect(countChunks(db, "a.md")).toBe(1);
    const hits = store.search(vectorFor(latest), 5);
    expect(hits[0]?.path).toBe("a.md");
  });

  it("removeNote deletes the note's stored vectors", async () => {
    const { db, store } = seeded();
    const provider = new FakeEmbeddingProvider();
    const indexer = new EmbeddingIndexer(provider, store);
    indexer.enqueue("a.md", "content to be removed");
    await indexer.flush();
    expect(countChunks(db, "a.md")).toBe(1);

    indexer.removeNote("a.md");

    expect(countChunks(db, "a.md")).toBe(0);
  });

  it("removeNote cancels a not-yet-started queued job for that path", async () => {
    const { db, store } = seeded();
    const provider = new FakeEmbeddingProvider();
    const indexer = new EmbeddingIndexer(provider, store);

    indexer.enqueue("a.md", "content");
    indexer.removeNote("a.md");
    await indexer.flush();

    expect(countChunks(db, "a.md")).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  it("reindexAll embeds every note in a vault listing and awaits completion", async () => {
    const { db, store } = seeded();
    const provider = new FakeEmbeddingProvider();
    const indexer = new EmbeddingIndexer(provider, store);

    await indexer.reindexAll([
      { path: "a.md", markdown: "content a" },
      { path: "b.md", markdown: "content b" },
    ]);

    expect(countChunks(db, "a.md")).toBe(1);
    expect(countChunks(db, "b.md")).toBe(1);
  });

  it("size() reflects outstanding work and settles to 0 once flushed", async () => {
    const { store } = seeded();
    const provider = new FakeEmbeddingProvider();
    const indexer = new EmbeddingIndexer(provider, store);

    indexer.enqueue("a.md", "content");
    expect(indexer.size()).toBeGreaterThan(0);

    await indexer.flush();

    expect(indexer.size()).toBe(0);
  });
});
