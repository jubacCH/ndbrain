import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.js";
import { Indexer } from "./indexer.js";
import { buildGraph } from "./graph.js";

describe("buildGraph", () => {
  it("returns every note as a node with its title", () => {
    const db = openDatabase(":memory:");
    const idx = new Indexer(db);
    idx.indexNote("a.md", "# Alpha\nbody");
    idx.indexNote("b.md", "no heading here");

    const graph = buildGraph(db);
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        { id: "a.md", title: "Alpha" },
        { id: "b.md", title: null },
      ]),
    );
    expect(graph.nodes).toHaveLength(2);
  });

  it("resolves a bare wikilink target to the existing note path", () => {
    const db = openDatabase(":memory:");
    const idx = new Indexer(db);
    idx.indexNote("a.md", "# A\n[[b]]");
    idx.indexNote("b.md", "# B");

    const graph = buildGraph(db);
    expect(graph.edges).toEqual([{ source: "a.md", target: "b.md" }]);
  });

  it("resolves a wikilink target that already includes the .md suffix", () => {
    const db = openDatabase(":memory:");
    const idx = new Indexer(db);
    idx.indexNote("a.md", "# A\n[[b.md]]");
    idx.indexNote("b.md", "# B");

    const graph = buildGraph(db);
    expect(graph.edges).toEqual([{ source: "a.md", target: "b.md" }]);
  });

  it("resolves a nested-path wikilink target", () => {
    const db = openDatabase(":memory:");
    const idx = new Indexer(db);
    idx.indexNote("a.md", "# A\n[[myai/deploy]]");
    idx.indexNote("myai/deploy.md", "# Deploy");

    const graph = buildGraph(db);
    expect(graph.edges).toEqual([{ source: "a.md", target: "myai/deploy.md" }]);
  });

  it("drops edges whose target does not resolve to an existing note", () => {
    const db = openDatabase(":memory:");
    const idx = new Indexer(db);
    idx.indexNote("a.md", "# A\n[[nope]]");

    const graph = buildGraph(db);
    expect(graph.edges).toEqual([]);
  });

  it("dedupes edges when a note links to the same target twice", () => {
    const db = openDatabase(":memory:");
    const idx = new Indexer(db);
    idx.indexNote("a.md", "# A\n[[b]] and again [[b.md]]");
    idx.indexNote("b.md", "# B");

    const graph = buildGraph(db);
    expect(graph.edges).toEqual([{ source: "a.md", target: "b.md" }]);
  });

  it("returns empty nodes/edges for an empty vault", () => {
    const db = openDatabase(":memory:");
    const graph = buildGraph(db);
    expect(graph).toEqual({ nodes: [], edges: [] });
  });

  it("skips self-edges (a note linking to itself)", () => {
    const db = openDatabase(":memory:");
    const idx = new Indexer(db);
    idx.indexNote("a.md", "# A\n[[a.md]] self link");

    const graph = buildGraph(db);
    expect(graph.edges).toEqual([]);
  });

  it("handles space-delimiter collisions correctly in dedupe", () => {
    const db = openDatabase(":memory:");
    const idx = new Indexer(db);
    // Create a collision scenario: "Project A" -> "B.md" vs "Project" -> "A B.md"
    // With space delimiter, both would generate "Project A B.md" and collide
    idx.indexNote("Project A.md", "# Project A\n[[B]]");
    idx.indexNote("Project.md", "# Project\n[[A B]]");
    idx.indexNote("B.md", "# B");
    idx.indexNote("A B.md", "# A B");

    const graph = buildGraph(db);
    // Should have both edges, not dedupe them
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { source: "Project A.md", target: "B.md" },
        { source: "Project.md", target: "A B.md" },
      ]),
    );
    expect(graph.edges).toHaveLength(2);
  });
});
