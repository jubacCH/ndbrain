import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.js";
import type { EmbeddingProvider } from "../embed/provider.js";
import { createEmbeddingProvider } from "../embed/provider.js";
import { VectorStore } from "../embed/store.js";
import { Indexer } from "./indexer.js";
import { buildContext } from "./context.js";

/** Fake embedding provider that always returns the same fixed vector, for deterministic fixtures. */
class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id = "fake";
  embedCallCount = 0;
  constructor(
    private readonly vector: number[],
    readonly dim: number = vector.length,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    this.embedCallCount++;
    return texts.map(() => this.vector);
  }
}

function seeded() {
  const db = openDatabase(":memory:");
  const idx = new Indexer(db);
  // Note A: target of backlink from B
  idx.indexNote("myai/deploy.md", "# Deploy\nHow to deploy the system");
  // Note B: links to A
  idx.indexNote("myai/setup.md", "# Setup guide\nSee [[myai/deploy]] for details");
  // Note C: shares "deploy" keyword with A in different namespace
  idx.indexNote("private/deploy-log.md", "# Deploy log\nDaily deploy monitoring");
  return db;
}

function mockRead(db: any) {
  return async (path: string) => {
    const row = db.prepare("SELECT body FROM notes_fts WHERE path = ?").get(path) as { body: string } | undefined;
    return row ? row.body : null;
  };
}

describe("buildContext", () => {
  it("returns context with content, backlinks, and related notes", async () => {
    const db = seeded();
    const read = mockRead(db);
    const result = await buildContext({ db, read }, "myai/deploy.md");

    expect(result).not.toBeNull();
    expect(result!.path).toBe("myai/deploy.md");
    expect(result!.content).toContain("How to deploy the system");
    expect(result!.backlinks).toContain("myai/setup.md");
    // related should contain notes with similar title words, excluding the note itself
    expect(result!.related.some((h) => h.path === "private/deploy-log.md")).toBe(true);
    expect(result!.related.some((h) => h.path === "myai/deploy.md")).toBe(false);
  });

  it("returns null when the note does not exist", async () => {
    const db = seeded();
    const read = mockRead(db);
    const result = await buildContext({ db, read }, "nonexistent.md");

    expect(result).toBeNull();
  });

  it("filters related notes by namespace", async () => {
    const db = seeded();
    const read = mockRead(db);
    // With namespace filter, related should only include notes in myai/
    const result = await buildContext({ db, read }, "myai/deploy.md", { namespace: "myai/" });

    expect(result).not.toBeNull();
    // Should exclude private/deploy-log.md due to namespace filter
    expect(result!.related.every((h) => h.path.startsWith("myai/"))).toBe(true);
  });

  it("excludes the note itself from related results", async () => {
    const db = seeded();
    const read = mockRead(db);
    const result = await buildContext({ db, read }, "myai/deploy.md");

    expect(result).not.toBeNull();
    expect(result!.related.every((h) => h.path !== "myai/deploy.md")).toBe(true);
  });

  it("respects the relatedLimit option", async () => {
    const db = openDatabase(":memory:");
    const idx = new Indexer(db);
    idx.indexNote("a.md", "# Alpha\nFirst note");
    idx.indexNote("b.md", "# Beta\nFirst beta");
    idx.indexNote("c.md", "# Gamma\nFirst gamma");
    idx.indexNote("d.md", "# Delta\nFirst delta");
    idx.indexNote("e.md", "# Epsilon\nFirst epsilon");

    const read = mockRead(db);
    const result = await buildContext({ db, read }, "a.md", { relatedLimit: 2 });

    expect(result).not.toBeNull();
    expect(result!.related.length).toBeLessThanOrEqual(2);
  });

  it("defaults to relatedLimit of 5 when not specified", async () => {
    const db = openDatabase(":memory:");
    const idx = new Indexer(db);
    idx.indexNote("a.md", "# Alpha\nFirst note");
    idx.indexNote("b.md", "# Beta\nFirst beta");
    idx.indexNote("c.md", "# Gamma\nFirst gamma");
    idx.indexNote("d.md", "# Delta\nFirst delta");
    idx.indexNote("e.md", "# Epsilon\nFirst epsilon");
    idx.indexNote("f.md", "# Zeta\nFirst zeta");

    const read = mockRead(db);
    const result = await buildContext({ db, read }, "a.md");

    expect(result).not.toBeNull();
    expect(result!.related.length).toBeLessThanOrEqual(5);
  });

  it("surfaces related notes sharing only one title word via OR recall", async () => {
    const db = openDatabase(":memory:");
    const idx = new Indexer(db);
    idx.indexNote("deploy-guide.md", "# Deploy Guide\nHow to roll out the stack");
    idx.indexNote("deploy-notes.md", "# Deploy Notes\nMisc deployment notes");
    idx.indexNote("guide-index.md", "# Guide Index\nIndex of all guides");
    idx.indexNote("unrelated.md", "# Something Else\nCompletely different topic entirely");

    const read = mockRead(db);
    const result = await buildContext({ db, read }, "deploy-guide.md");

    expect(result).not.toBeNull();
    // Neither related note shares BOTH title words with "Deploy Guide" — only
    // OR-mode recall surfaces them.
    expect(result!.related.some((h) => h.path === "deploy-notes.md")).toBe(true);
    expect(result!.related.some((h) => h.path === "guide-index.md")).toBe(true);
  });

  it("falls back to relatedLimit of 5 for non-finite or non-positive relatedLimit", async () => {
    const db = openDatabase(":memory:");
    const idx = new Indexer(db);
    idx.indexNote("a.md", "# Alpha\nFirst note");
    idx.indexNote("b.md", "# Beta\nFirst beta");
    idx.indexNote("c.md", "# Gamma\nFirst gamma");
    idx.indexNote("d.md", "# Delta\nFirst delta");
    idx.indexNote("e.md", "# Epsilon\nFirst epsilon");
    idx.indexNote("f.md", "# Zeta\nFirst zeta");

    const read = mockRead(db);
    const result = await buildContext({ db, read }, "a.md", { relatedLimit: -1 });

    expect(result).not.toBeNull();
    expect(result!.related.length).toBeLessThanOrEqual(5);
  });

  it("handles notes without a title by falling back to first words of body", async () => {
    const db = openDatabase(":memory:");
    const idx = new Indexer(db);
    // Note with no heading (no title)
    idx.indexNote("no-title.md", "Some content without a heading");
    idx.indexNote("other.md", "# Other\nContent Some details");

    const read = mockRead(db);
    const result = await buildContext({ db, read }, "no-title.md");

    expect(result).not.toBeNull();
    expect(result!.path).toBe("no-title.md");
    // Should still try to find related notes using fallback to first words
    expect(Array.isArray(result!.related)).toBe(true);
  });

  describe("with an embedding provider + store", () => {
    it("surfaces a lexically-unrelated but vector-neighbor note (vector-related, not FTS-title), using ALREADY-STORED vectors without calling provider.embed", async () => {
      const db = openDatabase(":memory:");
      const idx = new Indexer(db);
      idx.indexNote("k8s-guide.md", "# Kubernetes Guide\nHow to run kubernetes clusters");
      idx.indexNote(
        "orchestration.md",
        "# Orchestration\nContainer orchestration platform overview, unrelated title wording",
      );

      const read = mockRead(db);

      // Precondition: pure FTS-title finds no relation (no shared title tokens).
      const ftsOnly = await buildContext({ db, read }, "k8s-guide.md");
      expect(ftsOnly!.related.some((h) => h.path === "orchestration.md")).toBe(false);

      const store = new VectorStore(db, 3);
      // Both the query note's OWN vector and its neighbor's vector are already stored
      // (as the real EmbeddingIndexer would have done on write) - I2 fix: related is
      // computed from these, never by re-embedding the note's content on the call.
      store.upsertNote("k8s-guide.md", [{ ix: 0, vector: [1, 0, 0] }]);
      store.upsertNote("orchestration.md", [{ ix: 0, vector: [1, 0, 0] }]);
      const provider = new FakeEmbeddingProvider([1, 0, 0]);

      const result = await buildContext({ db, read, provider, store }, "k8s-guide.md");

      expect(result).not.toBeNull();
      expect(result!.related.some((h) => h.path === "orchestration.md")).toBe(true);
      expect(provider.embedCallCount).toBe(0);
    });

    it("excludes the note itself and applies the namespace filter to vector-related", async () => {
      const db = openDatabase(":memory:");
      const idx = new Indexer(db);
      idx.indexNote("myai/a.md", "# A\nlexical filler content");
      idx.indexNote("other/b.md", "# B\nlexical filler content");

      const read = mockRead(db);
      const store = new VectorStore(db, 3);
      store.upsertNote("myai/a.md", [{ ix: 0, vector: [1, 0, 0] }]);
      store.upsertNote("other/b.md", [{ ix: 0, vector: [1, 0, 0] }]);
      const provider = new FakeEmbeddingProvider([1, 0, 0]);

      const result = await buildContext(
        { db, read, provider, store },
        "myai/a.md",
        { namespace: "myai/" },
      );

      expect(result).not.toBeNull();
      expect(result!.related.every((h) => h.path !== "myai/a.md")).toBe(true);
      expect(result!.related.some((h) => h.path === "other/b.md")).toBe(false);
    });

    it("falls back to FTS-title related, without ever calling provider.embed, when the note has no stored vectors yet", async () => {
      const db = openDatabase(":memory:");
      const idx = new Indexer(db);
      idx.indexNote("deploy-guide.md", "# Deploy Guide\nHow to roll out the stack");
      idx.indexNote("deploy-notes.md", "# Deploy Notes\nMisc deployment notes");

      const read = mockRead(db);
      // No vectors upserted at all: the note was just written and not embedded yet.
      const store = new VectorStore(db, 3);
      const provider = new FakeEmbeddingProvider([1, 0, 0]);

      const result = await buildContext({ db, read, provider, store }, "deploy-guide.md");

      expect(result).not.toBeNull();
      expect(result!.related.some((h) => h.path === "deploy-notes.md")).toBe(true);
      expect(provider.embedCallCount).toBe(0);
    });

    it("with an explicit 'none' provider, keeps the FTS-title behavior unchanged", async () => {
      const db = seeded();
      const read = mockRead(db);
      const provider = createEmbeddingProvider({ provider: "none" });
      const store = new VectorStore(db, 3);

      const withNone = await buildContext({ db, read, provider, store }, "myai/deploy.md");
      const withoutDeps = await buildContext({ db, read }, "myai/deploy.md");

      expect(withNone).toEqual(withoutDeps);
    });
  });
});
