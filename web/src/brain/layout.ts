/**
 * The layout: where the nodes are, and the forces that move them.
 *
 * The second of three layers. It owns positions and velocities and nothing else
 * — no canvas, no pointer, no React, not even a notion of a pixel. Its
 * coordinates are world units, and the world is a rectangle the size of the
 * viewport, which is what makes the camera's starting position the whole
 * picture.
 *
 * **The forces are carried over unchanged, on purpose.** Every constant below
 * was arrived at by looking at a real vault, and this step is a re-cut, not a
 * re-tune: repulsion with a cutoff, a spring along each tract, a weak pull
 * toward a folder's place on an ellipse, a soft wall at the ellipse's rim, a
 * weighted recentre, and a hard clamp. Barnes-Hut and a worker belong to the
 * next phase; replacing the O(n²) loop here would have changed the picture and
 * the structure in the same commit, and then neither could be reviewed.
 */

import type { BrainGraph } from './model';
import { unit } from './seed';

export interface Point {
  x: number;
  y: number;
}

export class BrainLayout {
  readonly graph: BrainGraph;
  /** Positions and velocities, by node index. */
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  /** Cell-body radius, from the degree. Fixed, but a world length, so it lives here. */
  readonly r: Float64Array;

  width: number;
  height: number;
  /** The node being dragged, or -1. It is held still while the rest settles. */
  pinned = -1;

  constructor(graph: BrainGraph, width: number, height: number, remembered?: ReadonlyMap<string, Point>) {
    const n = graph.nodes.length;
    this.graph = graph;
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    this.r = new Float64Array(n);
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);

    for (let i = 0; i < n; i += 1) {
      this.r[i] = 4.5 + Math.sqrt(graph.nodes[i]!.degree) * 3.2;
    }
    this.seed(remembered);
  }

  /**
   * Gives every node a starting point.
   *
   * Three sources, in order of how much they preserve:
   *
   *  1. **Where it was last time.** A vault's owner is meant to remember that
   *     the homelab notes sit lower left; that only works if they still do.
   *  2. **Beside its neighbours**, for a note that is new since the last visit.
   *     Dropping it on the far side of the canvas would make the springs haul it
   *     across the picture and drag everything it passes out of place — one new
   *     note would rearrange the whole brain, which is exactly what must not
   *     happen.
   *  3. **A ring, seeded by its path.** The old fallback was a ring by array
   *     index; same shape, but the index moves when the vault gains a note and
   *     the path does not.
   */
  private seed(remembered?: ReadonlyMap<string, Point>): void {
    const { nodes, touching, edges } = this.graph;
    const known = new Uint8Array(nodes.length);

    for (let i = 0; i < nodes.length; i += 1) {
      const at = remembered?.get(nodes[i]!.key);
      if (at === undefined || !Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
      // A remembered position can be outside today's world: the window may have
      // been narrower, or this may be the small panel rather than the big view.
      this.x[i] = Math.min(this.width, Math.max(0, at.x));
      this.y[i] = Math.min(this.height, Math.max(0, at.y));
      known[i] = 1;
    }

    for (let i = 0; i < nodes.length; i += 1) {
      if (known[i] === 1) continue;
      const key = nodes[i]!.key;

      let sx = 0;
      let sy = 0;
      let count = 0;
      for (const e of touching[i]!) {
        const other = edges[e]!.a === i ? edges[e]!.b : edges[e]!.a;
        if (known[other] !== 1) continue;
        sx += this.x[other]!;
        sy += this.y[other]!;
        count += 1;
      }

      if (count > 0) {
        // Not exactly on top of them — two notes created together would then
        // start at the same point, and the repulsion would fling them apart in
        // a direction decided by floating-point noise.
        const angle = unit(key, 'nudge') * Math.PI * 2;
        this.x[i] = sx / count + Math.cos(angle) * 18;
        this.y[i] = sy / count + Math.sin(angle) * 18;
      } else {
        const angle = unit(key, 'angle') * Math.PI * 2;
        const radius = 40 + Math.floor(unit(key, 'ring') * 6) * 24;
        this.x[i] = this.width / 2 + Math.cos(angle) * radius;
        this.y[i] = this.height / 2 + Math.sin(angle) * radius;
      }
    }
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }

  /** Moves a node under the pointer. World coordinates, already converted. */
  place(i: number, wx: number, wy: number): void {
    const pad = this.r[i]! * 2.4 + 6;
    this.x[i] = Math.min(this.width - pad, Math.max(pad, wx));
    this.y[i] = Math.min(this.height - pad - 44, Math.max(pad + 12, wy));
    this.vx[i] = 0;
    this.vy[i] = 0;
  }

  step(): void {
    const { nodes, edges } = this.graph;
    const { x, y, vx, vy, r, width: w, height: h } = this;
    const n = nodes.length;

    // Repulsion between every pair, cut off at 230 world units. The cutoff is
    // what keeps this survivable at all: beyond it the force is under a
    // hundredth of a unit and invisible. It is still O(n²); Barnes-Hut is the
    // next phase, and putting it here would have meant changing the picture and
    // the structure in one commit, so that neither could be reviewed.
    //
    // The accumulation runs through locals rather than straight into the arrays
    // because `vx[i] -= …` reads an element the strict config types as possibly
    // undefined, and because one read and one write per node beats two per pair.
    for (let i = 0; i < n; i += 1) {
      const xi = x[i]!;
      const yi = y[i]!;
      let ax = vx[i]!;
      let ay = vy[i]!;
      for (let j = i + 1; j < n; j += 1) {
        const dx = x[j]! - xi;
        const dy = y[j]! - yi;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        if (d > 230) continue;
        const f = 900 / (d * d);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        ax -= fx;
        ay -= fy;
        vx[j] = vx[j]! + fx;
        vy[j] = vy[j]! + fy;
      }
      vx[i] = ax;
      vy[i] = ay;
    }

    // A spring along each tract, resting at 70.
    for (const e of edges) {
      const dx = x[e.b]! - x[e.a]!;
      const dy = y[e.b]! - y[e.a]!;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d - 70) * 0.012;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      vx[e.a] = vx[e.a]! + fx;
      vy[e.a] = vy[e.a]! + fy;
      vx[e.b] = vx[e.b]! - fx;
      vy[e.b] = vy[e.b]! - fy;
    }

    const cx = w / 2;
    const cy = h / 2;
    const rx = w * 0.4;
    const ry = h * 0.38;

    for (let i = 0; i < n; i += 1) {
      // Weak: the folders should group, not tip the picture over.
      const lobe = nodes[i]!.lobe;
      let ax = vx[i]! + (cx + Math.cos(lobe * Math.PI * 2) * rx * 0.22 - x[i]!) * 0.0004;
      let ay = vy[i]! + (cy + Math.sin(lobe * Math.PI * 2) * ry * 0.22 - y[i]!) * 0.0004;

      const nx = (x[i]! - cx) / rx;
      const ny = (y[i]! - cy) / ry;
      const rad = Math.sqrt(nx * nx + ny * ny);
      if (rad > 1) {
        ax -= nx * (rad - 1) * 3.2;
        ay -= ny * (rad - 1) * 3.2;
      }
      if (this.pinned === i) {
        vx[i] = 0;
        vy[i] = 0;
        continue;
      }
      ax *= 0.87;
      ay *= 0.87;
      vx[i] = ax;
      vy[i] = ay;
      x[i] = x[i]! + ax;
      y[i] = y[i]! + ay;
    }

    // Track the centroid, weighted by how connected each node is. Unweighted,
    // the many unconnected notes dominate the sum and the visible network ends
    // up against the edge regardless.
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let i = 0; i < n; i += 1) {
      const weight = 1 + nodes[i]!.degree * 2;
      sx += x[i]! * weight;
      sy += y[i]! * weight;
      sw += weight;
    }
    if (sw > 0) {
      const ox = (sx / sw - cx) * 0.09;
      const oy = (sy / sw - cy) * 0.09;
      for (let i = 0; i < n; i += 1) {
        x[i] = x[i]! - ox;
        y[i] = y[i]! - oy;
      }
    }

    // A hard bound. The soft ellipse alone only takes effect at the edge, and
    // until then the network drifts out of frame. It is also what lets the
    // camera treat "no zoom, no pan" as the view that holds everything: the
    // graph cannot be anywhere the first frame does not already show.
    for (let i = 0; i < n; i += 1) {
      const pad = r[i]! * 2.4 + 6;
      x[i] = Math.max(pad, Math.min(w - pad, x[i]!));
      y[i] = Math.max(pad + 12, Math.min(h - pad - 44, y[i]!));
    }
  }

  /** What to remember for next time, keyed by `nodeKey`. */
  positions(): Map<string, Point> {
    const out = new Map<string, Point>();
    for (let i = 0; i < this.graph.nodes.length; i += 1) {
      out.set(this.graph.nodes[i]!.key, { x: this.x[i]!, y: this.y[i]! });
    }
    return out;
  }
}
