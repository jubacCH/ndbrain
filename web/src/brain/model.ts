/**
 * The graph model: the vault's links as a structure you can walk.
 *
 * The first of three layers. This one holds nothing that moves and nothing that
 * paints — no coordinates, no canvas, no React. It exists so that the questions
 * the other layers keep asking ("which edges touch this note?", "how deep does
 * its folder sit?") are answered once, at the moment the server's reply arrives,
 * rather than by scanning arrays inside an animation frame.
 *
 * Indices, not object references, are the currency between the layers. The
 * layout keeps its positions in flat arrays addressed by the same index, which
 * is what lets the simulation stay allocation-free per frame and what a typed
 * array or a worker would need later anyway.
 */

import type { GraphData } from '../api';
import { refKey } from '../api';
import { unit } from './seed';

/**
 * The only identity a node has. Paths repeat across vaults, so the owner is part
 * of it.
 *
 * The app's own `refKey`, not a second spelling of the same idea: the first
 * version of this view joined the two with a NUL for the reason `refKey` gives,
 * and a key that differed from the rest of the app by one separator would be a
 * collision waiting for the day somebody passes one to the other.
 */
export const nodeKey = refKey;

export interface BrainNode {
  key: string;
  owner: string;
  path: string;
  title: string;
  folder: string;
  /**
   * Resolved links in both directions, counted by the server.
   *
   * Deliberately not `edges.length` for this node: the two agree for the whole
   * network, but the neighbourhood panel is fed a client-side subgraph, and
   * there the server's degree is still the honest answer to "how connected is
   * this note" while the local edge count only says how much of it is on screen.
   */
  degree: number;
  /**
   * Where this node's folder falls in the vault, as a fraction in [0, 1).
   *
   * Folders are numbered in first-seen order, which the server's `ORDER BY path`
   * makes alphabetical, so neighbouring folders get neighbouring fractions and
   * the lobe force below pulls them into neighbouring regions.
   */
  lobe: number;
  /** Depth in the drawing stack, and with it size and opacity. Fixed per note. */
  depth: number;
}

export interface BrainEdge {
  a: number;
  b: number;
  /** How far the tract bows away from the straight line, signed. Fixed per pair. */
  curve: number;
}

export interface BrainGraph {
  nodes: BrainNode[];
  edges: BrainEdge[];
  /** Node index by `nodeKey`. */
  index: Map<string, number>;
  /** Edge indices touching each node, by node index. */
  touching: number[][];
  /** Node indices in drawing order, furthest back first. Fixed, so sorted once. */
  order: number[];
  /** The most connected node, or -1 for an empty graph. The one always-on label. */
  hub: number;
}

/**
 * Turns a server reply into the model.
 *
 * Two filters survive from the first version of this view and are kept
 * deliberately. An edge whose endpoints are not both present is dropped: the
 * neighbourhood panel hands over a subgraph, and half an edge has nowhere to go.
 * A self-edge is dropped too, because a bezier from a point to itself is a dot.
 */
export function buildGraph(data: GraphData): BrainGraph {
  const folders = new Map<string, number>();
  for (const n of data.nodes) {
    if (!folders.has(n.folder)) folders.set(n.folder, folders.size);
  }
  const spread = Math.max(1, folders.size - 1);

  const nodes: BrainNode[] = data.nodes.map((n) => {
    const key = nodeKey(n.owner, n.path);
    return {
      key,
      owner: n.owner,
      path: n.path,
      title: n.title,
      folder: n.folder,
      degree: n.links,
      lobe: (folders.get(n.folder) ?? 0) / spread,
      depth: 0.5 + unit(key, 'depth') * 0.5,
    };
  });

  const index = new Map<string, number>();
  nodes.forEach((n, i) => index.set(n.key, i));

  const edges: BrainEdge[] = [];
  const touching: number[][] = nodes.map(() => []);
  for (const e of data.edges) {
    const a = index.get(nodeKey(e.owner, e.from));
    const b = index.get(nodeKey(e.owner, e.to));
    if (a === undefined || b === undefined || a === b) continue;
    const at = edges.length;
    edges.push({ a, b, curve: (unit(nodeKey(e.owner, e.from) + '\u0000' + e.to, 'curve') - 0.5) * 0.36 });
    touching[a]!.push(at);
    touching[b]!.push(at);
  }

  // Both orders are properties of the graph, not of the frame: depth and degree
  // never change once the reply is parsed. The old code re-sorted all nodes
  // twice per frame to learn the same two answers.
  const order = nodes.map((_, i) => i).sort((i, j) => nodes[i]!.depth - nodes[j]!.depth);
  let hub = -1;
  for (let i = 0; i < nodes.length; i += 1) {
    if (hub === -1 || nodes[i]!.degree > nodes[hub]!.degree) hub = i;
  }

  return { nodes, edges, index, touching, order, hub };
}
