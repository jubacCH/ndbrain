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

/** Reads back the raw stored vectors for a path (ordered by chunk index), for exact-content assertions. */
function getVectors(db: Database, path: string): number[][] {
  const rows = db
    .prepare("SELECT embedding FROM vec_chunks WHERE note_path = ? ORDER BY chunk_ix")
    .all(path) as { embedding: Buffer }[];
  return rows.map((row) => Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)));
}

/** Polls a real timer (not the injectable scheduler) until `condition` holds, so tests can interleave with an in-flight promise without knowing the exact number of microtask ticks the pump needs. */
async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Fake provider whose `embed` calls never resolve on their own: each call is queued and
 * must be resolved explicitly via `resolveNext`/`rejectNext`, in FIFO order. Lets tests
 * interleave `enqueue`/`removeNote` with an embed that's genuinely "in flight".
 */
class DeferredEmbeddingProvider implements EmbeddingProvider {
  readonly id = "fake-deferred";
  readonly dim = DIM;
  private readonly waiting: Array<{
    texts: string[];
    resolve: (vectors: number[][]) => void;
    reject: (err: unknown) => void;
  }> = [];

  embed(texts: string[]): Promise<number[][]> {
    return new Promise((resolve, reject) => {
      this.waiting.push({ texts, resolve, reject });
    });
  }

  get pendingCount(): number {
    return this.waiting.length;
  }

  /** Resolves the oldest still-pending call with vectors derived from its own texts. */
  resolveNext(): void {
    const next = this.waiting.shift();
    if (!next) throw new Error("DeferredEmbeddingProvider: no pending embed call to resolve");
    next.resolve(next.texts.map(vectorFor));
  }

  /** Rejects the oldest still-pending call. */
  rejectNext(err: unknown): void {
    const next = this.waiting.shift();
    if (!next) throw new Error("DeferredEmbeddingProvider: no pending embed call to reject");
    next.reject(err);
  }
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

  it("removeNote during an in-flight embed keeps the note deleted (no resurrection)", async () => {
    const { db, store } = seeded();
    const provider = new DeferredEmbeddingProvider();
    const indexer = new EmbeddingIndexer(provider, store);

    indexer.enqueue("a.md", "content that will be deleted mid-flight");
    await waitFor(() => provider.pendingCount === 1);

    indexer.removeNote("a.md");
    provider.resolveNext();
    await indexer.flush();

    expect(countChunks(db, "a.md")).toBe(0);
  });

  it("supersedes an in-flight embed: the stale version's upsert is skipped and the newer version's content wins", async () => {
    const { db, store } = seeded();
    const provider = new DeferredEmbeddingProvider();
    const indexer = new EmbeddingIndexer(provider, store);
    // Spied rather than inferred from final DB state: with a serial pump, the *last*
    // write always wins regardless of any skip logic, so only a call-count/content
    // assertion on upsertNote actually proves v1's upsert was skipped (as opposed to
    // harmlessly overwritten later).
    const upsertSpy = vi.spyOn(store, "upsertNote");
    const v1 = "first version, still embedding";
    const v2 = "second version, supersedes v1 while it is in flight";

    indexer.enqueue("a.md", v1);
    await waitFor(() => provider.pendingCount === 1);

    indexer.enqueue("a.md", v2);
    provider.resolveNext(); // v1's embed resolves, but it's stale now: its upsert must be skipped
    await waitFor(() => provider.pendingCount === 1); // pump moved on to embedding v2
    provider.resolveNext(); // v2's embed resolves and stores
    await indexer.flush();

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy.mock.calls[0][0]).toBe("a.md");
    expect(countChunks(db, "a.md")).toBe(1);
    expect(getVectors(db, "a.md")).toEqual([vectorFor(v2)]);
  });

  it("a stale scheduled retry does not clobber content that a later successful embed already stored (regression)", async () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, store } = seeded();
    const v1 = "first version, fails once then would retry";
    const v2 = "second version, embeds and stores successfully";
    // Keyed on content so we can tell which version a given embed call is for, and make
    // v1 fail (to schedule a retry) while v2 always succeeds.
    const provider = new FakeEmbeddingProvider(async (texts) => {
      if (texts[0] === v1) throw new Error("simulated provider outage for v1");
      return texts.map(vectorFor);
    });
    let scheduledRetry: (() => void) | undefined;
    const indexer = new EmbeddingIndexer(provider, store, {
      // Injectable scheduler: capture the retry callback instead of running it on a timer,
      // so the test controls exactly when the stale retry fires relative to v2's success.
      scheduler: (fn) => {
        scheduledRetry = fn;
      },
    });

    indexer.enqueue("a.md", v1);
    // Can't use flush() here: the captured (not-yet-fired) retry timer is itself
    // outstanding work by design, so flush() would never resolve until we fire it below.
    await waitFor(() => scheduledRetry !== undefined); // v1 fails, retry scheduled (captured, not yet run)
    expect(indexer.size()).toBe(1); // the pending retry timer counts as outstanding work

    indexer.enqueue("a.md", v2);
    await waitFor(() => countChunks(db, "a.md") === 1); // v2 embeds and stores successfully (flush() still blocked on the retry timer)

    expect(countChunks(db, "a.md")).toBe(1);
    expect(getVectors(db, "a.md")).toEqual([vectorFor(v2)]);

    // Now fire v1's stale retry: its version no longer matches latestVersion, so it must
    // not re-queue/re-embed/clobber v2's already-stored content.
    scheduledRetry?.();
    await indexer.flush();

    expect(countChunks(db, "a.md")).toBe(1);
    expect(getVectors(db, "a.md")).toEqual([vectorFor(v2)]);
    expect(provider.calls.map((call) => call[0])).toEqual([v1, v2]);
  });

  it("caps retries at maxAttempts, then drops the path with a final error log instead of retrying forever", async () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { store } = seeded();
    let callCount = 0;
    const provider = new FakeEmbeddingProvider(async () => {
      callCount++;
      throw new Error("permanent-ish outage that never recovers");
    });
    const indexer = new EmbeddingIndexer(provider, store, {
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 2,
      maxAttempts: 3,
    });

    indexer.enqueue("a.md", "content that will never succeed");
    await indexer.flush();

    expect(callCount).toBe(3);
    expect(errSpy).toHaveBeenCalledOnce();
    errSpy.mockRestore();
  });

  it("does not block enqueue of other paths while one path is stuck retrying", async () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, store } = seeded();
    const provider = new FakeEmbeddingProvider(async (texts) => {
      if (texts[0] === "bad content") throw new Error("always fails");
      return texts.map(vectorFor);
    });
    const indexer = new EmbeddingIndexer(provider, store, {
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 2,
      maxAttempts: 2,
    });

    indexer.enqueue("bad.md", "bad content");
    indexer.enqueue("good.md", "good content");
    await indexer.flush();

    expect(countChunks(db, "good.md")).toBe(1);
    expect(countChunks(db, "bad.md")).toBe(0);
    errSpy.mockRestore();
  });

  it("drops immediately (no retry) on a classified permanent 4xx error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { store } = seeded();
    let callCount = 0;
    const provider = new FakeEmbeddingProvider(async () => {
      callCount++;
      const err = new Error("bad api key") as Error & { status: number };
      err.status = 401;
      throw err;
    });
    const indexer = new EmbeddingIndexer(provider, store, { retryBaseDelayMs: 1, retryMaxDelayMs: 2 });

    indexer.enqueue("a.md", "content with a permanently bad key");
    await indexer.flush();

    expect(callCount).toBe(1);
    expect(errSpy).toHaveBeenCalledOnce();
    errSpy.mockRestore();
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
