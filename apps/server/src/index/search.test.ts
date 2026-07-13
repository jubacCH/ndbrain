import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.js";
import { createEmbeddingProvider } from "../embed/provider.js";
import type { EmbeddingProvider } from "../embed/provider.js";
import { VectorStore } from "../embed/store.js";
import { Indexer } from "./indexer.js";
import { backlinksOf, hybridSearch, searchNotes } from "./search.js";

/** Fake embedding provider that always returns the same fixed query vector, for deterministic RRF fixtures. */
class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id = "fake";
  constructor(
    private readonly vector: number[],
    readonly dim: number = vector.length,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => this.vector);
  }
}

function seeded() {
  const db = openDatabase(":memory:");
  const idx = new Indexer(db);
  idx.indexNote("myai/deploy.md", "# Deploy Guide\nHow to deploy the homelab stack");
  idx.indexNote("private/journal.md", "# Journal\ndeploy thoughts");
  idx.indexNote("myai/ref.md", "# Ref\nSee [[myai/deploy]] for details");
  return db;
}

describe("searchNotes", () => {
  it("finds notes with snippets, ranked", () => {
    const hits = searchNotes(seeded(), "deploy");
    expect(hits.length).toBe(3);
    expect(hits[0].snippet).toContain("deploy");
  });

  it("filters by namespace prefix", () => {
    const hits = searchNotes(seeded(), "deploy", { namespace: "myai/" });
    expect(hits.every((h) => h.path.startsWith("myai/"))).toBe(true);
    expect(hits.length).toBe(2);
  });

  it("does not treat LIKE metacharacters in namespace as wildcards", () => {
    const db = openDatabase(":memory:");
    const idx = new Indexer(db);
    idx.indexNote("my_notes/a.md", "# A\nwidget details");
    idx.indexNote("myXnotes/b.md", "# B\nwidget details");
    const hits = searchNotes(db, "widget", { namespace: "my_notes/" });
    expect(hits.map((h) => h.path)).toEqual(["my_notes/a.md"]);
  });

  it("matches the namespace case-sensitively (scope enforcement)", () => {
    const db = openDatabase(":memory:");
    const idx = new Indexer(db);
    idx.indexNote("myai/a.md", "# A\nwidget details");
    idx.indexNote("MYAI/secret.md", "# Secret\nwidget details");
    const hits = searchNotes(db, "widget", { namespace: "myai/" });
    expect(hits.map((h) => h.path)).toEqual(["myai/a.md"]);
  });

  it("falls back to the default limit for non-positive or NaN limits", () => {
    const db = openDatabase(":memory:");
    const idx = new Indexer(db);
    idx.indexNote("a.md", "# A\nwidget one");
    idx.indexNote("b.md", "# B\nwidget two");
    const hits = searchNotes(db, "widget", { limit: -1 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(20);
  });

  it("does not throw on a query containing a lone double quote and still finds matches", () => {
    const hits = searchNotes(seeded(), 'deploy "');
    expect(hits.some((h) => h.path === "myai/deploy.md")).toBe(true);
  });

  it("returns an empty array for an empty or whitespace-only query", () => {
    expect(searchNotes(seeded(), "")).toEqual([]);
    expect(searchNotes(seeded(), "   ")).toEqual([]);
  });

  it("match: 'or' finds notes containing any token, not just all tokens", () => {
    const db = openDatabase(":memory:");
    const idx = new Indexer(db);
    idx.indexNote("only-deploy.md", "# Only\nWe deploy things here");
    idx.indexNote("only-guide.md", "# Only\nThis is a guide for stuff");
    idx.indexNote("neither.md", "# Neither\nUnrelated content entirely");

    const orHits = searchNotes(db, "deploy guide", { match: "or" });
    expect(orHits.map((h) => h.path).sort()).toEqual(["only-deploy.md", "only-guide.md"]);

    // Default (AND) mode requires both tokens; neither note alone qualifies.
    const andHits = searchNotes(db, "deploy guide");
    expect(andHits.length).toBe(0);
  });
});

describe("backlinksOf", () => {
  it("returns sources linking to a note (with or without .md)", () => {
    expect(backlinksOf(seeded(), "myai/deploy.md")).toEqual(["myai/ref.md"]);
  });
});

describe("hybridSearch", () => {
  it("without a provider/store, returns results identical to searchNotes for several queries", async () => {
    const db = seeded();
    for (const query of ["deploy", "guide", "deploy guide"]) {
      const hybrid = await hybridSearch(db, query);
      expect(hybrid).toEqual(searchNotes(db, query));
    }
  });

  it("with an explicit 'none' provider, returns results identical to searchNotes", async () => {
    const db = seeded();
    const provider = createEmbeddingProvider({ provider: "none" });
    const store = new VectorStore(db, 3);

    const hybrid = await hybridSearch(db, "deploy", { provider, store });

    expect(hybrid).toEqual(searchNotes(db, "deploy"));
  });

  it("surfaces a lexically-absent but semantically-related note via the vector branch (money test)", async () => {
    const db = openDatabase(":memory:");
    const idx = new Indexer(db);
    idx.indexNote("k8s-guide.md", "# Kubernetes Guide\nHow to run kubernetes clusters");
    idx.indexNote(
      "orchestration.md",
      "# Orchestration\nContainer orchestration platform overview, unrelated wording only",
    );

    // Precondition: pure FTS never finds orchestration.md for this query (no lexical overlap).
    const ftsOnly = searchNotes(db, "kubernetes");
    expect(ftsOnly.some((h) => h.path === "orchestration.md")).toBe(false);

    const store = new VectorStore(db, 3);
    store.upsertNote("orchestration.md", [{ ix: 0, vector: [1, 0, 0] }]);
    const provider = new FakeEmbeddingProvider([1, 0, 0]);

    const hybrid = await hybridSearch(db, "kubernetes", { provider, store });

    expect(hybrid.some((h) => h.path === "orchestration.md")).toBe(true);
  });

  it("fuses via RRF: a doc ranked high in both lists outranks a doc ranked #1 in only one list", async () => {
    const db = openDatabase(":memory:");
    const idx = new Indexer(db);
    idx.indexNote("fts-only.md", "# FTS Only\n" + "widget ".repeat(20));
    idx.indexNote("both.md", "# Both\nwidget appears once here");
    idx.indexNote("vec-only.md", "# Vec Only\nGadget review, no relevant token");

    // Precondition: pure FTS ranks fts-only.md first, both.md second, and never surfaces vec-only.md.
    const ftsOrder = searchNotes(db, "widget").map((h) => h.path);
    expect(ftsOrder[0]).toBe("fts-only.md");
    expect(ftsOrder).toContain("both.md");
    expect(ftsOrder).not.toContain("vec-only.md");

    const store = new VectorStore(db, 3);
    // both.md is the closest vector match (rank 1); vec-only.md is second. fts-only.md has
    // no embedding at all, so it never appears in the vector ranking.
    store.upsertNote("both.md", [{ ix: 0, vector: [1, 0, 0] }]);
    store.upsertNote("vec-only.md", [{ ix: 0, vector: [0.9, 0.1, 0] }]);
    const provider = new FakeEmbeddingProvider([1, 0, 0]);

    const hits = await hybridSearch(db, "widget", { provider, store });

    expect(hits[0].path).toBe("both.md");
  });

  it("applies the namespace filter to the vector branch too (a vector hit outside scope is excluded)", async () => {
    const db = openDatabase(":memory:");
    const idx = new Indexer(db);
    idx.indexNote("myai/a.md", "# A\nlexical filler content unrelated to the query");
    idx.indexNote("other/b.md", "# B\nlexical filler content unrelated to the query");

    const store = new VectorStore(db, 3);
    // Identical vectors: without namespace scoping, both would tie for the top vector rank.
    store.upsertNote("myai/a.md", [{ ix: 0, vector: [1, 0, 0] }]);
    store.upsertNote("other/b.md", [{ ix: 0, vector: [1, 0, 0] }]);
    const provider = new FakeEmbeddingProvider([1, 0, 0]);

    // Query has no lexical match at all, so only the (namespace-scoped) vector branch matters.
    const hits = await hybridSearch(db, "nomatch-term-xyz", { provider, store, namespace: "myai/" });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.path.startsWith("myai/"))).toBe(true);
    expect(hits.some((h) => h.path === "other/b.md")).toBe(false);
    // Vector-only hit (no FTS match): title/snippet fall back to the notes table/FTS body.
    expect(hits[0].title).toBe("A");
    expect(hits[0].snippet).toContain("lexical filler");
  });

  it("falls back to FTS-only results when the query embedding fails (no hard-fail)", async () => {
    const db = seeded();
    const provider: EmbeddingProvider = {
      id: "broken",
      dim: 3,
      embed: async () => {
        throw new Error("simulated provider outage");
      },
    };
    const store = new VectorStore(db, 3);

    const hits = await hybridSearch(db, "deploy", { provider, store });

    expect(hits).toEqual(searchNotes(db, "deploy"));
  });
});
