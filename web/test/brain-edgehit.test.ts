/**
 * What counts as clicking a link.
 *
 * The briefing calls "why is this connected?" extremely important and asks for
 * it on a click on the edge itself. A quadtree over cell-body centres cannot
 * answer that: a link is a segment, not a point, and since the regions were
 * introduced the drawn link is not even the straight line between its two
 * notes — a link into another region is bundled through that region's hub and
 * bows a long way off the chord.
 *
 * So the test is mostly about that difference. Picking has to follow the curve
 * that was actually drawn (`traceEdge`), not the pair of endpoints; the slack
 * around it has to be a screen distance, as the node test's is; and a link the
 * overview holds back to a ghost must not be pickable, because nothing is
 * there to click.
 */

import { describe, expect, it } from 'vitest';

import { CURVE_STEPS, VISIBLE, planRoutes, traceEdge } from '../src/brain/edges';
import type { DrawnEdge } from '../src/brain/edgehit';
import { EDGE_GRAB, EdgeHitIndex } from '../src/brain/edgehit';
import { BrainLayout } from '../src/brain/layout';
import { buildGraph } from '../src/brain/model';
import { regionView } from '../src/brain/regions';
import { paraVault } from './fixtures/para-vault';

/** A link drawn along a straight line between two world points. */
function line(x0: number, y0: number, x1: number, y1: number, restAlpha = 1): DrawnEdge {
  const n = 9;
  const pts = new Float64Array(n * 2);
  for (let k = 0; k < n; k += 1) {
    const t = k / (n - 1);
    pts[k * 2] = x0 + (x1 - x0) * t;
    pts[k * 2 + 1] = y0 + (y1 - y0) * t;
  }
  return { pts, n, restAlpha };
}

describe('hitting a link', () => {
  it('takes the link under the point and nothing further off than the slack', () => {
    const edges = [line(0, 0, 100, 0)];
    const hits = new EdgeHitIndex(edges);

    expect(hits.at(50, 0, 1)).toBe(0);
    expect(hits.at(50, EDGE_GRAB - 0.5, 1)).toBe(0);
    expect(hits.at(50, EDGE_GRAB + 0.5, 1)).toBe(-1);
    // Past either end, not merely off the infinite line through it.
    expect(hits.at(-EDGE_GRAB - 1, 0, 1)).toBe(-1);
    expect(hits.at(100 + EDGE_GRAB + 1, 0, 1)).toBe(-1);
  });

  it('measures the slack in screen pixels, so zooming in narrows it in world units', () => {
    const hits = new EdgeHitIndex([line(0, 0, 100, 0)]);
    const off = EDGE_GRAB - 0.5;
    expect(hits.at(50, off, 1)).toBe(0);
    // The same world point, four times closer: the link is now four times
    // further away on screen than the slack allows.
    expect(hits.at(50, off, 4)).toBe(-1);
    // And further out the slack grows, as the node test's does.
    expect(hits.at(50, off * 3, 0.25)).toBe(0);
  });

  it('takes the nearer of two links that cross', () => {
    const hits = new EdgeHitIndex([line(0, 0, 100, 0), line(0, 3, 100, 3)]);
    expect(hits.at(50, 1.0, 1)).toBe(0);
    expect(hits.at(50, 2.0, 1)).toBe(1);
  });

  it('leaves a link the overview does not draw alone', () => {
    // A ghost is on the canvas at about one part in a hundred; clicking it
    // would open a panel about a line nobody can see.
    const hits = new EdgeHitIndex([line(0, 0, 100, 0, VISIBLE / 2)]);
    expect(hits.at(50, 0, 1)).toBe(-1);
  });

  it('answers for an empty graph and for a link with no curve yet', () => {
    expect(new EdgeHitIndex([]).at(0, 0, 1)).toBe(-1);
    const bare: DrawnEdge = { pts: new Float64Array(2), n: 0, restAlpha: 1 };
    expect(new EdgeHitIndex([bare]).at(0, 0, 1)).toBe(-1);
  });

  it('follows the curve again once the notes have moved and it is told', () => {
    const edge = line(0, 0, 100, 0);
    const hits = new EdgeHitIndex([edge]);
    expect(hits.at(50, 0, 1)).toBe(0);
    for (let k = 0; k < edge.n; k += 1) edge.pts[k * 2 + 1] = edge.pts[k * 2 + 1]! + 400;
    hits.invalidate();
    expect(hits.at(50, 0, 1)).toBe(-1);
    expect(hits.at(50, 400, 1)).toBe(0);
  });
});

describe('hitting a bundled link', () => {
  const graph = buildGraph(paraVault().data);
  const layout = new BrainLayout(graph, { arrangement: 'brain' });
  layout.settle();
  const view = regionView(layout);
  const geometry = {
    inside: view.inside,
    depthInside: view.depthInside,
    regionOf: view.regionOf,
    regions: view.regions,
  };
  const routes = planRoutes({
    edges: graph.edges,
    keys: graph.nodes.map((n) => n.key),
    degree: graph.nodes.map((n) => n.degree),
    geometry,
  });
  const drawn: DrawnEdge[] = graph.edges.map((_, i) => {
    const pts = new Float64Array((CURVE_STEPS + 1) * 2);
    const n = traceEdge(pts, routes, i, layout.x, layout.y, geometry);
    return { pts, n, restAlpha: 1 };
  });
  const hits = new EdgeHitIndex(drawn);

  /** Squared distance from a point to a sampled curve. The test's own arithmetic. */
  const offCurve = (edge: DrawnEdge, px: number, py: number): number => {
    let best = Infinity;
    for (let k = 0; k + 1 < edge.n; k += 1) {
      const ax = edge.pts[k * 2]!;
      const ay = edge.pts[k * 2 + 1]!;
      const bx = edge.pts[(k + 1) * 2]!;
      const by = edge.pts[(k + 1) * 2 + 1]!;
      const dx = bx - ax;
      const dy = by - ay;
      const len = dx * dx + dy * dy;
      const t = len === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len));
      best = Math.min(best, (px - ax - dx * t) ** 2 + (py - ay - dy * t) ** 2);
    }
    return Math.sqrt(best);
  };

  it('takes a point on every drawn curve, at its middle and near its ends', () => {
    for (let i = 0; i < drawn.length; i += 1) {
      const edge = drawn[i]!;
      const mid = Math.floor((edge.n - 1) / 2);
      const got = hits.at(edge.pts[mid * 2]!, edge.pts[mid * 2 + 1]!, 1);
      expect(got, `link ${i} at its middle`).toBeGreaterThanOrEqual(0);
      // Not necessarily this link: two curves may run through the same point,
      // and then the nearest wins. What may not happen is nothing at all.
      expect(offCurve(drawn[got]!, edge.pts[mid * 2]!, edge.pts[mid * 2 + 1]!)).toBeLessThan(EDGE_GRAB);
    }
  });

  it('follows the bundled route and not the chord between the two notes', () => {
    // The link whose drawn curve leaves the straight line furthest. Bundling
    // sends it through another region's hub, so its middle is nowhere near the
    // middle of the chord — the thing a segment test over the endpoints would
    // have picked.
    let worst = -1;
    let away = 0;
    for (let i = 0; i < drawn.length; i += 1) {
      const edge = drawn[i]!;
      if (edge.n < 2) continue;
      const cx = (edge.pts[0]! + edge.pts[(edge.n - 1) * 2]!) / 2;
      const cy = (edge.pts[1]! + edge.pts[(edge.n - 1) * 2 + 1]!) / 2;
      const off = offCurve(edge, cx, cy);
      if (off > away) {
        away = off;
        worst = i;
      }
    }
    expect(worst).toBeGreaterThanOrEqual(0);
    // A real bow, not rounding: many times the slack away from the chord.
    expect(away).toBeGreaterThan(EDGE_GRAB * 4);

    const edge = drawn[worst]!;
    const mid = Math.floor((edge.n - 1) / 2);
    expect(hits.at(edge.pts[mid * 2]!, edge.pts[mid * 2 + 1]!, 1)).toBeGreaterThanOrEqual(0);

    // And the middle of the chord picks nothing that runs through it by more
    // than the slack — in particular not this link.
    const cx = (edge.pts[0]! + edge.pts[(edge.n - 1) * 2]!) / 2;
    const cy = (edge.pts[1]! + edge.pts[(edge.n - 1) * 2 + 1]!) / 2;
    const got = hits.at(cx, cy, 1);
    expect(got).not.toBe(worst);
    if (got >= 0) expect(offCurve(drawn[got]!, cx, cy)).toBeLessThan(EDGE_GRAB);
  });

  it('finds nothing out in the dark, well away from the brain', () => {
    const far = layout.bounds.maxX + 4000;
    expect(hits.at(far, layout.bounds.maxY + 4000, 1)).toBe(-1);
  });
});
