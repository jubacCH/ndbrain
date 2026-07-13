import { describe, expect, it } from "vitest";
import type { Graph } from "../api/client";
import { localNeighborhood, toForceGraph } from "./buildGraphData";

const GRAPH: Graph = {
  nodes: [
    { id: "a.md", title: "A" },
    { id: "b.md", title: "B" },
    { id: "c.md", title: "C" },
    { id: "d.md", title: "D" },
    { id: "isolated.md", title: null },
  ],
  edges: [
    { source: "a.md", target: "b.md" },
    { source: "b.md", target: "c.md" },
    { source: "c.md", target: "d.md" },
  ],
};

describe("toForceGraph", () => {
  it("renames edges to links, keeping node and edge shape otherwise unchanged", () => {
    const result = toForceGraph(GRAPH);

    expect(result.nodes).toEqual(GRAPH.nodes);
    expect(result.links).toEqual([
      { source: "a.md", target: "b.md" },
      { source: "b.md", target: "c.md" },
      { source: "c.md", target: "d.md" },
    ]);
  });

  it("handles an empty graph", () => {
    expect(toForceGraph({ nodes: [], edges: [] })).toEqual({ nodes: [], links: [] });
  });
});

describe("localNeighborhood", () => {
  it("returns just the center node when it has no edges (isolated node)", () => {
    const result = localNeighborhood(GRAPH, "isolated.md");

    expect(result.nodes).toEqual([{ id: "isolated.md", title: null }]);
    expect(result.links).toEqual([]);
  });

  it("returns an empty graph when the center path has no matching node", () => {
    const result = localNeighborhood(GRAPH, "missing.md");

    expect(result).toEqual({ nodes: [], links: [] });
  });

  it("defaults to depth 1: only direct neighbors of the center", () => {
    const result = localNeighborhood(GRAPH, "b.md");

    expect(result.nodes.map((n) => n.id).sort()).toEqual(["a.md", "b.md", "c.md"]);
    expect(result.links).toEqual(
      expect.arrayContaining([
        { source: "a.md", target: "b.md" },
        { source: "b.md", target: "c.md" },
      ]),
    );
    expect(result.links).toHaveLength(2);
  });

  it("expands to depth 2 when requested", () => {
    const result = localNeighborhood(GRAPH, "a.md", 2);

    expect(result.nodes.map((n) => n.id).sort()).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("expands to depth 3 to reach the far end of the chain", () => {
    const result = localNeighborhood(GRAPH, "a.md", 3);

    expect(result.nodes.map((n) => n.id).sort()).toEqual(["a.md", "b.md", "c.md", "d.md"]);
  });

  it("treats edges as undirected — a node reached only via an edge where it is the target still counts as a neighbor", () => {
    // c.md is the *target* of b->c and the *source* of c->d; from d's perspective
    // the b->c/c->d edges must still count as neighbors in both directions.
    const result = localNeighborhood(GRAPH, "d.md");

    expect(result.nodes.map((n) => n.id).sort()).toEqual(["c.md", "d.md"]);
    expect(result.links).toEqual([{ source: "c.md", target: "d.md" }]);
  });

  it("dedupes nodes and links reachable via multiple paths", () => {
    const diamond: Graph = {
      nodes: [
        { id: "center.md", title: "Center" },
        { id: "left.md", title: "Left" },
        { id: "right.md", title: "Right" },
        { id: "far.md", title: "Far" },
      ],
      edges: [
        { source: "center.md", target: "left.md" },
        { source: "center.md", target: "right.md" },
        { source: "left.md", target: "far.md" },
        { source: "right.md", target: "far.md" },
      ],
    };

    const result = localNeighborhood(diamond, "center.md", 2);

    expect(result.nodes.map((n) => n.id).sort()).toEqual(["center.md", "far.md", "left.md", "right.md"]);
    expect(result.nodes).toHaveLength(4);
    expect(result.links).toHaveLength(4);
  });

  it("excludes links to a node id that has no matching entry in graph.nodes (dangling edge reference)", () => {
    const graph: Graph = {
      nodes: [
        { id: "a.md", title: "A" },
        { id: "b.md", title: "B" },
      ],
      edges: [
        { source: "a.md", target: "b.md" },
        { source: "b.md", target: "phantom.md" },
      ],
    };

    const result = localNeighborhood(graph, "a.md", 2);

    expect(result.nodes.map((n) => n.id).sort()).toEqual(["a.md", "b.md"]);
    expect(result.links).toEqual([{ source: "a.md", target: "b.md" }]);
  });

  it("ignores edges that duplicate the same pair (already-deduped upstream, but stay defensive)", () => {
    const graph: Graph = {
      nodes: [
        { id: "a.md", title: "A" },
        { id: "b.md", title: "B" },
      ],
      edges: [
        { source: "a.md", target: "b.md" },
        { source: "b.md", target: "a.md" },
      ],
    };

    const result = localNeighborhood(graph, "a.md");

    expect(result.links).toHaveLength(1);
  });
});
