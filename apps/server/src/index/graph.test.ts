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
});
