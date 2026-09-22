/**
 * Which link is under a point.
 *
 * The companion of `hit.ts`, and separate from it for a reason that is not
 * tidiness: a node is a point and a link is a curve, and nothing a quadtree
 * over centres knows helps with the second. Since the regions arrived a link
 * is not even the straight line between its notes — one into another region is
 * bundled through that region's hub (`edges.ts`) and bows a long way off the
 * chord, so a test against the endpoints would answer for a line nobody drew.
 *
 * **It measures against the curve that was drawn.** The scene already samples
 * every link into a buffer when the notes move (`SceneBuilder`), and this reads
 * those very buffers rather than tracing again — the same argument that makes
 * the node test ask the render model for `bodyRadius`: two spellings of where
 * a link runs would drift apart, and the one you can click would stop being the
 * one you can see.
 *
 * **What is not drawn is not pickable.** The overview holds most links between
 * regions back to a ghost at about one part in a hundred (`GHOST`). Opening a
 * panel about a line nobody can see would be a mystery, so anything below
 * `VISIBLE` is passed over — and since that opacity is recomputed every frame
 * with the zoom and the selection, the test is made at the moment of the click
 * and not when the index was built.
 *
 * **The slack is a screen distance**, as `GRAB` is: a link is about a pixel
 * wide however far in the camera has come, so what counts as "on it" has to be
 * measured where the pointer is.
 */

import { VISIBLE } from './edges';

/**
 * How far from a drawn link a click still counts, in screen pixels.
 *
 * Smaller than `GRAB`. A link is a thin line and there are many of them: a
 * generous slack around one means the neighbouring one is what you get. It is
 * also only ever consulted after the node test has said no, so it never takes
 * a click away from a cell body.
 */
export const EDGE_GRAB = 5;

/** A link as the scene drew it. `SceneEdge` satisfies this. */
export interface DrawnEdge {
  /** The curve, x,y pairs in world units. Valid up to `n` points. */
  readonly pts: Float64Array;
  readonly n: number;
  /** Opacity of the resting link this frame. Below `VISIBLE` it is not a line. */
  readonly restAlpha: number;
}

/**
 * Cells per axis over the world the links occupy.
 *
 * A grid rather than a tree: what is indexed is a box per link, boxes overlap
 * freely, and a uniform grid holds overlapping boxes without any of the
 * splitting a quadtree would need. Forty-eight squared is a few thousand cells,
 * which is nothing to allocate once per rest and keeps a few links per cell on
 * the vaults this view is built for.
 */
const SIDE = 48;

/**
 * How many cells one link's box may cover before it is checked on every query
 * instead.
 *
 * A bundled route across both hemispheres has a box covering a quarter of the
 * grid. Writing it into six hundred cells costs more than the handful of extra
 * distance tests it saves, and there are never many of them.
 */
const WIDE_CELLS = 64;

/** Squared distance from a point to a sampled curve. */
function offCurve(pts: Float64Array, n: number, px: number, py: number): number {
  let best = Infinity;
  for (let k = 0; k + 1 < n; k += 1) {
    const ax = pts[k * 2]!;
    const ay = pts[k * 2 + 1]!;
    const dx = pts[(k + 1) * 2]! - ax;
    const dy = pts[(k + 1) * 2 + 1]! - ay;
    const len = dx * dx + dy * dy;
    const t = len === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len));
    const ox = px - ax - dx * t;
    const oy = py - ay - dy * t;
    const d = ox * ox + oy * oy;
    if (d < best) best = d;
  }
  return best;
}

export class EdgeHitIndex {
  readonly #edges: readonly DrawnEdge[];
  /** Box per link, as minX, minY, maxX, maxY. Only valid while `#cells` is. */
  readonly #box: Float64Array;
  /** Link indices per cell, row-major, or null when the grid has to be rebuilt. */
  #cells: number[][] | null = null;
  /** Links whose box is too large to write into the grid. */
  #wide: number[] = [];
  #minX = 0;
  #minY = 0;
  #cw = 1;
  #ch = 1;
  /**
   * Which query last measured each link. A link sits in every cell its box
   * covers, so without this a long one is measured a dozen times per click.
   */
  readonly #seen: Int32Array;
  #visit = 0;

  constructor(edges: readonly DrawnEdge[]) {
    this.#edges = edges;
    this.#box = new Float64Array(edges.length * 4);
    this.#seen = new Int32Array(edges.length).fill(-1);
  }

  /**
   * The curves have moved.
   *
   * Only marks the grid stale, for the reason `HitIndex.invalidate` gives: the
   * simulation says this sixty times a second and a pointer asks a few dozen
   * times at most, so the rebuild waits for the question.
   *
   * Opacity is deliberately not a reason to call this. It changes with the zoom
   * and the selection on frames where nothing moved, and it is read at query
   * time rather than built in.
   */
  invalidate(): void {
    this.#cells = null;
  }

  #index(): void {
    if (this.#cells !== null) return;
    const edges = this.#edges;
    const box = this.#box;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < edges.length; i += 1) {
      const { pts, n } = edges[i]!;
      if (n < 2) {
        box[i * 4] = Infinity;
        continue;
      }
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let k = 0; k < n; k += 1) {
        const x = pts[k * 2]!;
        const y = pts[k * 2 + 1]!;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      // A curve with a NaN in it would poison the world box and with it every
      // cell index. It is left out instead, as an edge with no curve is.
      if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) {
        box[i * 4] = Infinity;
        continue;
      }
      box[i * 4] = x0;
      box[i * 4 + 1] = y0;
      box[i * 4 + 2] = x1;
      box[i * 4 + 3] = y1;
      if (x0 < minX) minX = x0;
      if (y0 < minY) minY = y0;
      if (x1 > maxX) maxX = x1;
      if (y1 > maxY) maxY = y1;
    }

    const cells: number[][] = Array.from({ length: SIDE * SIDE }, () => []);
    this.#wide = [];
    this.#cells = cells;
    if (minX > maxX) return;
    this.#minX = minX;
    this.#minY = minY;
    this.#cw = Math.max((maxX - minX) / SIDE, 1e-6);
    this.#ch = Math.max((maxY - minY) / SIDE, 1e-6);

    for (let i = 0; i < edges.length; i += 1) {
      if (box[i * 4] === Infinity) continue;
      const cx0 = this.#col(box[i * 4]!);
      const cx1 = this.#col(box[i * 4 + 2]!);
      const cy0 = this.#row(box[i * 4 + 1]!);
      const cy1 = this.#row(box[i * 4 + 3]!);
      if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > WIDE_CELLS) {
        this.#wide.push(i);
        continue;
      }
      for (let cy = cy0; cy <= cy1; cy += 1) {
        for (let cx = cx0; cx <= cx1; cx += 1) cells[cy * SIDE + cx]!.push(i);
      }
    }
  }

  #col(x: number): number {
    return Math.min(SIDE - 1, Math.max(0, Math.floor((x - this.#minX) / this.#cw)));
  }

  #row(y: number): number {
    return Math.min(SIDE - 1, Math.max(0, Math.floor((y - this.#minY) / this.#ch)));
  }

  /** The link at a world point for a camera at `scale`, or -1. */
  at(wx: number, wy: number, scale: number): number {
    this.#index();
    const cells = this.#cells;
    if (cells === null || !Number.isFinite(wx) || !Number.isFinite(wy)) return -1;
    const slack = EDGE_GRAB / Math.max(1e-6, scale);
    const limit = slack * slack;

    this.#visit += 1;
    const visit = this.#visit;
    const seen = this.#seen;
    const box = this.#box;
    let best = -1;
    let bestAt = limit;

    const measure = (i: number): void => {
      if (seen[i] === visit) return;
      seen[i] = visit;
      const edge = this.#edges[i]!;
      if (edge.n < 2 || edge.restAlpha < VISIBLE) return;
      // The box first: it is four comparisons against the sixty the curve costs.
      if (
        wx < box[i * 4]! - slack ||
        wx > box[i * 4 + 2]! + slack ||
        wy < box[i * 4 + 1]! - slack ||
        wy > box[i * 4 + 3]! + slack
      ) {
        return;
      }
      const d = offCurve(edge.pts, edge.n, wx, wy);
      // Ties go to the lower index, so the same click always gives the same
      // link however the reply happened to be ordered.
      if (d < bestAt) {
        bestAt = d;
        best = i;
      }
    };

    for (const i of this.#wide) measure(i);
    const cx0 = this.#col(wx - slack);
    const cx1 = this.#col(wx + slack);
    const cy0 = this.#row(wy - slack);
    const cy1 = this.#row(wy + slack);
    for (let cy = cy0; cy <= cy1; cy += 1) {
      for (let cx = cx0; cx <= cx1; cx += 1) {
        for (const i of cells[cy * SIDE + cx]!) measure(i);
      }
    }
    return best;
  }
}
