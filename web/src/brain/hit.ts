/**
 * Which node is under a point.
 *
 * Kept out of the component for the same reason as everything else in this
 * folder: it is arithmetic, and arithmetic can be tested without a canvas. It
 * also has two rules that are easy to blur, and a test is where they stay apart.
 *
 * **At the starting zoom, the original rule, unchanged:** the nearest centre,
 * accepted within √500 pixels. That slack is generous on purpose — a small,
 * dim node is a hard target, and missing it by two pixels should not matter.
 * (The one exception is a hub of 25 links or more, whose drawn body is already
 * wider than the slack at zoom 1; for it the whole visible body counts, where
 * the old test left its outer rim dead.)
 *
 * **Zoomed in, the drawn outline.** The slack is a screen distance, so it
 * shrinks in world units as the camera moves closer, and a magnified cell body
 * soon outgrows it. From then on the body itself is the target, measured with
 * the radius the scene draws it with (`bodyRadius`), not the layout's.
 *
 * Still "nearest centre wins" in both regimes, as before. On the rim of a large
 * magnified node a small neighbour whose centre happens to be closer can claim
 * the point and then be too far away to count; that is rare, and deciding it
 * properly means testing every overlapping body in drawing order.
 */

import type { BrainLayout } from './layout';
import { Quadtree } from './quadtree';
import { bodyRadius } from './scene';

/**
 * How far from a cell body a click still counts, in screen pixels. The old hit
 * test's threshold (`distance² < 500`), unchanged.
 */
export const GRAB = Math.sqrt(500);

export class HitIndex {
  #layout: BrainLayout;
  /** Drawn radius per node. Depth and degree are fixed, so this is too. */
  #body: Float64Array;
  /** The largest of them, which sets how wide the tree query has to look. */
  #reach = 0;
  #tree: Quadtree | null = null;

  constructor(layout: BrainLayout) {
    this.#layout = layout;
    const nodes = layout.graph.nodes;
    this.#body = new Float64Array(nodes.length);
    for (let i = 0; i < nodes.length; i += 1) {
      const r = bodyRadius(layout.r[i]!, nodes[i]!.depth);
      this.#body[i] = r;
      this.#reach = Math.max(this.#reach, r);
    }
  }

  /**
   * The nodes have moved.
   *
   * Only marks the tree stale. The simulation calls this sixty times a second
   * and a pointer asks a few dozen times at most, so the rebuild waits for the
   * question.
   */
  invalidate(): void {
    this.#tree = null;
  }

  /** The node at a world point for a camera at `scale`, or -1. */
  at(wx: number, wy: number, scale: number): number {
    const { x, y } = this.#layout;
    if (this.#tree === null) {
      // Rooted on the box the nodes actually occupy. The world is centred on
      // the origin and a dragged node can leave the arrangement's bounds, so
      // neither a fixed rectangle nor the layout's bounds would fit every point.
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < x.length; i += 1) {
        minX = Math.min(minX, x[i]!);
        minY = Math.min(minY, y[i]!);
        maxX = Math.max(maxX, x[i]!);
        maxY = Math.max(maxY, y[i]!);
      }
      const tree = x.length === 0 ? new Quadtree(0, 0, 1, 1) : new Quadtree(minX, minY, maxX, maxY);
      for (let i = 0; i < x.length; i += 1) tree.insert(i, x[i]!, y[i]!);
      this.#tree = tree;
    }

    const slack = GRAB / scale;
    const hit = this.#tree.nearest(wx, wy, Math.max(slack, this.#reach));
    if (hit === -1) return -1;
    const dx = x[hit]! - wx;
    const dy = y[hit]! - wy;
    const d = dx * dx + dy * dy;
    // Strictly inside the slack, as the original `< 500` was; the drawn outline
    // itself counts as part of the body.
    return d < slack * slack || d <= this.#body[hit]! ** 2 ? hit : -1;
  }
}
