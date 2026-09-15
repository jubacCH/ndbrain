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
 * gets numbers it only has to obey. How loudly each link is drawn, and how
 * strongly a cell body glows, is decided in `edges.ts` and only applied here.
 *
 * Arrays are allocated once per graph and refilled in place. At 109 notes that
 * is housekeeping; at the few thousand this is being built for, a fresh object
 * per node per frame is the garbage collector stuttering the animation.
 */

import type { Camera, Inset } from './camera';
import { fit } from './camera';
import type { EdgePlan } from './edges';
import { TWIN, edgeAlpha, glow, growth, opening, planEdges, tractBase, tractMid } from './edges';
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
  /** 0 to 1. Strength of the halo, as a share of the full one (see `edges.ts`). */
  glow: number;
}

export interface SceneEdge {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Control point of the quadratic curve — also where a spark travels. */
  cx: number;
  cy: number;
  /** Half-width where the tract leaves each cell body, on top of `mw`. */
  aw: number;
  bw: number;
  /** Half-width everywhere along the tract, the whole width in its middle. */
  mw: number;
  /** Opacity. Zero means there is nothing to draw. */
  alpha: number;
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

/** The overview the zoom is measured against: the fit, without the caller's inset. */
const NO_INSET: Inset = { top: 0, right: 0, bottom: 0, left: 0 };

/** How many labels may be on screen at once. More text crowds exactly where the
 *  nodes are densest anyway. */
const MAX_LABELS = 4;
/** Below this a flash is too faint to be worth a name beside it. */
const LABEL_FIRE = 0.35;

export class SceneBuilder {
  #graph: BrainGraph;
  #scene: Scene;
  /** How loudly each edge is drawn, settled once per layout (see `edges.ts`). */
  #plan: EdgePlan | null = null;
  #planned: BrainLayout | null = null;
  /** Spark strength per edge this frame, refilled in place. */
  #lit: Float64Array;

  constructor(graph: BrainGraph) {
    this.#graph = graph;
    this.#scene = {
      nodes: graph.nodes.map(() => ({ x: 0, y: 0, r: 0, colour: [0, 0, 0], alpha: 0, heat: 0, glow: 0 })),
      order: graph.order,
      edges: graph.edges.map(() => ({ ax: 0, ay: 0, bx: 0, by: 0, cx: 0, cy: 0, aw: 0, bw: 0, mw: 0, alpha: 0 })),
      sparks: [],
      labels: [],
      camera: { scale: 1, x: 0, y: 0 },
      width: 0,
      height: 0,
    };
    this.#lit = new Float64Array(graph.edges.length);
  }

  /**
   * The edge plan for this layout.
   *
   * Per layout rather than per graph because the hemisphere of each note is
   * the layout's decision. A new layout is a new engine in practice; the check
   * is identity, so it costs nothing per frame.
   */
  #planFor(layout: BrainLayout): EdgePlan {
    if (this.#plan !== null && this.#planned === layout) return this.#plan;
    const { nodes, edges, clusters } = this.#graph;
    const regions = layout.arrangement === 'brain';
    this.#plan = planEdges({
      edges,
      keys: nodes.map((n) => n.key),
      clusterOf: regions ? clusters.of : null,
      nodeSide: regions ? layout.nodeSide : null,
    });
    this.#planned = layout;
    return this.#plan;
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
      out.glow = glow(heat);
    }

    // How far in the camera is, as a multiple of the overview. Measured against
    // a fit without the caller's inset, which the scene cannot see; the inset
    // makes the real resting view a few percent smaller, still well below where
    // held-back links start to return.
    const plan = this.#planFor(layout);
    const overview = fit(layout.bounds, width, height, NO_INSET).scale;
    const zoom = overview > 0 && Number.isFinite(overview) ? camera.scale / overview : 1;
    const open = opening(zoom);
    const grow = growth(zoom);
    const mid = tractMid(grow, camera.scale);

    // The visible world rectangle. Held-back links open with the zoom only when
    // one of their ends is in it: a long link from somewhere off screen to
    // somewhere else off screen says nothing about what is being looked at.
    const scale = Math.max(1e-6, camera.scale);
    const left = -camera.x / scale;
    const top = -camera.y / scale;
    const right = (width - camera.x) / scale;
    const bottom = (height - camera.y) / scale;

    // Spark strength per edge. A twin's spark is skipped: the carrier touches
    // the same note and has a spark of its own.
    const lit = this.#lit;
    lit.fill(0);
    for (const spark of activity.sparks) {
      if (spark.edge < 0 || spark.t < 0 || plan.kind[spark.edge] === TWIN) continue;
      lit[spark.edge] = Math.max(lit[spark.edge]!, 1 - spark.t);
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
      const focused = picked >= 0 && (e.a === picked || e.b === picked);
      out.aw = tractBase(layout.r[e.a]!, grow, focused);
      out.bw = tractBase(layout.r[e.b]!, grow, focused);
      out.mw = mid;
      const seen =
        (ax >= left && ax <= right && ay >= top && ay <= bottom) ||
        (bx >= left && bx <= right && by >= top && by <= bottom);
      out.alpha = edgeAlpha(plan, i, seen ? open : 0, focused, lit[i]!);
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

      // A link in both directions sends one spark, along the edge that is
      // drawn; the twin's would run beside the line and double the pulse.
      if (plan.kind[spark.edge] === TWIN) continue;
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
