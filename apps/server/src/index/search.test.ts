import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.js";
import { Indexer } from "./indexer.js";
import { backlinksOf, searchNotes } from "./search.js";

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
