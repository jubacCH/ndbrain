/**
 * The render model: one frame, resolved down to shapes and colours.
 *
 * The third layer, and the seam the whole re-cut was for. Everything above this
 * point is structure and physics; everything below is painting. A renderer
 * receives a scene and never asks where it came from — which is what makes
 * swapping the canvas for WebGL a change to one file rather than a rewrite.
 *
 * The colour rules live here rather than in the renderer, because they are
 * decisions about meaning — an unlinked note is dim, a hub is bright, an access
 * is warm — and those must survive a change of drawing technology. The renderer
 * gets numbers it only has to obey. The rules themselves are unchanged from the
 * version that drew straight onto the canvas; this step moves them, it does not
 * revise them.
 *
 * Arrays are allocated once per graph and refilled in place. At 109 notes that
 * is housekeeping; at the few thousand this is being built for, a fresh object
 * per node per frame is the garbage collector stuttering the animation.
 */

import type { Camera } from './camera';
import type { BrainGraph } from './model';
import type { Activity, PulseKind } from './activity';
import type { BrainLayout } from './layout';

export type Rgb = readonly [number, number, number];

/** The two access colours. Not brand colour: they say read and written. */
export const PULSE_COLOUR: Record<PulseKind, Rgb> = {
  read: [127, 233, 240],
  write: [255, 184, 107],
};

export interface SceneNode {
  x: number;
  y: number;
  /** Drawn radius, already leaning on depth. */
  r: number;
  colour: Rgb;
  alpha: number;
  /** 0 to 1. Widens the halo and whitens the core. */
  heat: number;
}

export interface SceneEdge {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Control point of the quadratic curve — also where a spark travels. */
  cx: number;
  cy: number;
  /** Half-width where the tract leaves each cell body. */
  aw: number;
  bw: number;
}

export interface SceneSpark {
  x: number;
  y: number;
  r: number;
  colour: Rgb;
  alpha: number;
  /** A ring runs outward from a note with no tracts; otherwise a dot travels one. */
  ring: boolean;
}

export interface SceneLabel {
  x: number;
  y: number;
  text: string;
  hot: boolean;
}

export interface Scene {
  nodes: SceneNode[];
  /** Node indices, furthest back first. Drawing order, not iteration order. */
  order: number[];
  edges: SceneEdge[];
  sparks: SceneSpark[];
  labels: SceneLabel[];
  camera: Camera;
  /** Viewport in CSS pixels. */
  width: number;
  height: number;
}

/**
 * How large a cell body is drawn: its layout radius, leaning on depth.
 *
 * Exported because the hit test has to use the same outline. It once used the
 * layout radius instead, which is up to a tenth smaller for the nodes drawn
 * furthest forward — invisible at the starting zoom, and a ring around every
 * magnified node where a press panned the camera instead of grabbing the node.
 */
export function bodyRadius(layoutRadius: number, depth: number): number {
  return layoutRadius * (0.8 + depth * 0.3);
}

/** How many labels may be on screen at once. More text crowds exactly where the
 *  nodes are densest anyway. */
const MAX_LABELS = 4;
/** Below this a flash is too faint to be worth a name beside it. */
const LABEL_FIRE = 0.35;

export class SceneBuilder {
  #graph: BrainGraph;
  #scene: Scene;

  constructor(graph: BrainGraph) {
    this.#graph = graph;
    this.#scene = {
      nodes: graph.nodes.map(() => ({ x: 0, y: 0, r: 0, colour: [0, 0, 0], alpha: 0, heat: 0 })),
      order: graph.order,
      edges: graph.edges.map(() => ({ ax: 0, ay: 0, bx: 0, by: 0, cx: 0, cy: 0, aw: 0, bw: 0 })),
      sparks: [],
      labels: [],
      camera: { scale: 1, x: 0, y: 0 },
      width: 0,
      height: 0,
    };
  }

  build(
    layout: BrainLayout,
    activity: Activity,
    camera: Camera,
    picked: number,
    width: number,
    height: number,
  ): Scene {
    const scene = this.#scene;
    const { nodes, edges } = this.#graph;
    scene.camera = camera;
    scene.width = width;
    scene.height = height;

    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]!;
      const depth = node.depth;
      const heat = Math.max(activity.fire[i]!, activity.warm[i]! * 0.42);
      const base: Rgb =
        node.degree === 0 ? [58, 96, 110] : node.degree >= 8 ? [79, 216, 224] : [64, 158, 178];

      const out = scene.nodes[i]!;
      out.x = layout.x[i]!;
      out.y = layout.y[i]!;
      out.r = bodyRadius(layout.r[i]!, depth);
      out.colour = heat > 0 ? PULSE_COLOUR[activity.kind[i]!] : base;
      out.alpha = (node.degree === 0 ? 0.24 : 0.72) * (0.55 + depth * 0.45) + heat * 0.5;
      out.heat = heat;
    }

    // The control point is settled here, before anything is drawn. It used to be
    // written onto the edge while the tracts were being painted, and the sparks
    // read it afterwards — so a spark's path depended on the tracts having been
    // drawn first in the same frame. That was true, and it was invisible.
    for (let i = 0; i < edges.length; i += 1) {
      const e = edges[i]!;
      const ax = layout.x[e.a]!;
      const ay = layout.y[e.a]!;
      const bx = layout.x[e.b]!;
      const by = layout.y[e.b]!;
      const out = scene.edges[i]!;
      out.ax = ax;
      out.ay = ay;
      out.bx = bx;
      out.by = by;
      out.cx = (ax + bx) / 2 - (by - ay) * e.curve;
      out.cy = (ay + by) / 2 + (bx - ax) * e.curve;
      out.aw = Math.max(1.6, layout.r[e.a]! * 0.42);
      out.bw = Math.max(1.6, layout.r[e.b]! * 0.42);
    }

    scene.sparks = [];
    for (const spark of activity.sparks) {
      if (spark.t < 0) continue;
      const colour = PULSE_COLOUR[spark.kind];

      if (spark.edge === -1) {
        const r = layout.r[spark.from]! * (2 + spark.t * 7);
        scene.sparks.push({
          x: layout.x[spark.from]!,
          y: layout.y[spark.from]!,
          r,
          colour,
          alpha: 1 - spark.t,
          ring: true,
        });
        continue;
      }

      const e = scene.edges[spark.edge]!;
      const fromA = edges[spark.edge]!.a === spark.from;
      const fx = fromA ? e.ax : e.bx;
      const fy = fromA ? e.ay : e.by;
      const tx = fromA ? e.bx : e.ax;
      const ty = fromA ? e.by : e.ay;
      const t = spark.t;
      const it = 1 - t;
      scene.sparks.push({
        x: it * it * fx + 2 * it * t * e.cx + t * t * tx,
        y: it * it * fy + 2 * it * t * e.cy + t * t * ty,
        r: 3.4 * (1 - t * 0.4) * 4,
        colour,
        alpha: 1 - t,
        ring: false,
      });
    }

    // Labelled sparingly: the hub, whatever is firing, whatever is touched.
    scene.labels = [];
    const named = new Set<number>();
    const name = (i: number): void => {
      if (i < 0 || named.has(i) || scene.labels.length >= MAX_LABELS) return;
      named.add(i);
      const node = nodes[i]!;
      const at = scene.nodes[i]!;
      const hot = activity.fire[i]! > LABEL_FIRE;
      scene.labels.push({
        x: at.x,
        y: at.y - layout.r[i]! * 1.6 - 8,
        text: node.title.length > 26 ? `${node.title.slice(0, 25)}…` : node.title,
        hot,
      });
    };
    name(this.#graph.hub);
    for (let i = 0; i < nodes.length; i += 1) {
      if (activity.fire[i]! > LABEL_FIRE) name(i);
    }
    name(picked);

    return scene;
  }
}
