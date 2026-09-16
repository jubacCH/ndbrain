/**
 * The silhouette and its regions, as everything that paints needs them.
 *
 * This file is the seam between the two halves of the brain work. The layout
 * owns the shape — which note sits in which cell of the outline, where a cell's
 * hub is, and where the outline runs — and everything below (edges, decoration,
 * labels) only reads it. The contract is fixed in writing so both halves could
 * be built at once:
 *
 * ```ts
 * readonly regions: readonly Region[];
 * readonly regionOf: Int32Array;
 * readonly nodeSide: Int8Array;
 * inside(x, y): boolean;
 * depthInside(x, y): number;
 * ```
 *
 * `regionView` reads exactly that off a layout when the layout carries it, and
 * otherwise derives a stand-in from what a layout has always had: the clusters,
 * their places and their radii, and the outline in `shape.ts`. The stand-in is
 * not a second implementation of the shape — it is the same `shape.ts` — it only
 * answers the two geometric questions the old layout never had to answer out
 * loud. When the layout grows the fields, the stand-in stops being used; nothing
 * above this file changes.
 *
 * World units throughout, the layout's own: normalised outline coordinates times
 * `unitLength`. Callers never see the normalised ones.
 */

import type { BrainLayout } from './layout';
import { FISSURE, centre, pointAt, reach, type Side } from './shape';

/** One region of the brain: a group of notes that share a cell of the silhouette. */
export interface Region {
  readonly id: number;
  /** Display name, e.g. "AI & Agents". Already user-facing. */
  readonly name: string;
  /** -1 = left hemisphere, +1 = right. */
  readonly side: -1 | 1;
  /** Centre of the region's cell, world coordinates. */
  readonly cx: number;
  readonly cy: number;
  /** Index of the region's hub node — the waypoint for bundled edges. */
  readonly hub: number;
  /** Members, node indices. */
  readonly members: readonly number[];
}

/** What a layout hands to everything that paints. */
export interface RegionView {
  readonly regions: readonly Region[];
  /** Region id per node index, -1 for a node in no region. */
  readonly regionOf: Int32Array;
  /** Hemisphere per node index, -1 or 1. */
  readonly nodeSide: Int8Array;
  /** True when the point lies inside the silhouette. Decoration clips against this. */
  inside(x: number, y: number): boolean;
  /** Distance from (x, y) to the silhouette edge, in world units, negative outside. */
  depthInside(x: number, y: number): number;
  /** World length of one normalised outline unit. */
  readonly unit: number;
  /** True when this is a brain, not the loose neighbourhood arrangement. */
  readonly shaped: boolean;
}

/** The parts of a layout this file needs; the rest of `BrainLayout` is not its business. */
type MaybeContract = Partial<Pick<RegionView, 'regions' | 'regionOf' | 'inside' | 'depthInside'>>;

/**
 * Reads the contract off a layout.
 *
 * Cheap enough to call once per layout, not per frame: the caller holds the
 * result for as long as it holds the layout.
 */
export function regionView(layout: BrainLayout): RegionView {
  const shaped = layout.arrangement === 'brain';
  const u = layout.unitLength;
  const provided = layout as unknown as MaybeContract;

  const geometry = shaped ? shapeGeometry(u) : loose();
  if (
    provided.regions !== undefined &&
    provided.regionOf !== undefined &&
    typeof provided.inside === 'function' &&
    typeof provided.depthInside === 'function'
  ) {
    return {
      regions: provided.regions,
      regionOf: provided.regionOf,
      nodeSide: layout.nodeSide,
      inside: provided.inside.bind(layout),
      depthInside: provided.depthInside.bind(layout),
      unit: u,
      shaped,
    };
  }

  return {
    ...geometry,
    ...deriveRegions(layout, shaped),
    nodeSide: layout.nodeSide,
    unit: u,
    shaped,
  };
}

/**
 * The silhouette from `shape.ts`, in world units.
 *
 * `depthInside` is the remaining distance to the rim along the ray from the
 * hemisphere's centre, which is what the decoration wants: how much room is left
 * before the fold, the grain or the branch would leave the tissue. It is not the
 * true nearest distance to the outline — that would need a search over the rim —
 * and the two only differ where the rim curves sharply, which for this outline
 * is nowhere.
 */
function shapeGeometry(u: number): Pick<RegionView, 'inside' | 'depthInside'> {
  const gap = FISSURE * u;
  return {
    inside(x: number, y: number): boolean {
      if (Math.abs(x) < gap) return false;
      const side: Side = x < 0 ? -1 : 1;
      return reach(side, x / u, y / u) < 1;
    },
    depthInside(x: number, y: number): number {
      const side: Side = x < 0 ? -1 : 1;
      const rc = reach(side, x / u, y / u);
      const h = centre(side);
      // Radius of the rim in this direction, in world units.
      const radius = rc > 0 ? Math.hypot(x - h.x * u, y - h.y * u) / rc : 0;
      const toRim = (1 - rc) * (radius || u);
      const toFissure = Math.abs(x) - gap;
      return Math.min(toRim, toFissure);
    },
  };
}

/** The loose arrangement has no outline: everything is inside and nothing has a rim. */
function loose(): Pick<RegionView, 'inside' | 'depthInside'> {
  return { inside: () => false, depthInside: () => -1 };
}

/**
 * Regions from the clusters, while the layout does not name them itself.
 *
 * A cluster already is what a region is meant to be — notes that belong
 * together, named after their folder — and the layout already gives each one a
 * place, a radius and a side. The one thing missing is the hub, which is simply
 * the best-connected member: the waypoint a bundled link runs through.
 */
function deriveRegions(layout: BrainLayout, shaped: boolean): Pick<RegionView, 'regions' | 'regionOf'> {
  const { nodes } = layout.graph;
  const regionOf = new Int32Array(nodes.length).fill(-1);
  if (!shaped) return { regions: [], regionOf };

  const { clusters } = layout.graph.clusters;
  const regions: Region[] = clusters.map((cluster, c) => {
    let hub = cluster.members[0] ?? -1;
    for (const i of cluster.members) {
      regionOf[i] = c;
      if (hub < 0 || nodes[i]!.degree > nodes[hub]!.degree) hub = i;
    }
    return {
      id: c,
      name: cluster.name,
      side: (layout.side[c] === -1 ? -1 : 1) as -1 | 1,
      cx: layout.placeX[c]!,
      cy: layout.placeY[c]!,
      hub,
      members: cluster.members,
    };
  });
  return { regions, regionOf };
}

/** Where a region's name is written, and the curve that ties it to the tissue. */
export interface RegionLabel {
  readonly region: number;
  readonly text: string;
  /** Where the text sits, world units. */
  readonly x: number;
  readonly y: number;
  /** Where the leader starts: the member nearest the rim point. */
  readonly fromX: number;
  readonly fromY: number;
  /** The leader's single control point. */
  readonly cx: number;
  readonly cy: number;
  readonly align: 'left' | 'right' | 'center';
  /** True when the text sits above its rim point: the second line goes up, not down. */
  readonly above: boolean;
}

/** How far outside the rim a name sits, as a share of the rim radius. */
const LABEL_OUT = 1.13;
/** A name that has to go over or under the brain sits closer in. */
const LABEL_OUT_CENTRED = 1.05;
/** Vertical room between two names on the same flank, in world units per note-scale. */
const LABEL_GAP = 0.16;

/**
 * Places every region's name outside the silhouette.
 *
 * Outward from the hemisphere's centre through the region's own centre of mass,
 * so a name sits on the side of the brain its notes are on. Two corrections stop
 * the obvious failures: a region against the fissure would point its name into
 * the gap between the halves, so it is labelled above or below instead; and
 * names on the same flank are pushed apart until they no longer overlap.
 *
 * Pure geometry over the region view and the positions — no canvas, so the
 * collision rule can be tested without one.
 */
export function regionLabels(view: RegionView, x: ArrayLike<number>, y: ArrayLike<number>): RegionLabel[] {
  if (!view.shaped) return [];
  const u = view.unit;
  const out: Array<RegionLabel & { ry: number; rx: number }> = [];

  for (const region of view.regions) {
    if (region.members.length === 0) continue;
    let mx = 0;
    let my = 0;
    for (const i of region.members) {
      mx += x[i]!;
      my += y[i]!;
    }
    mx /= region.members.length;
    my /= region.members.length;

    const side = region.side;
    const home = centre(side);
    let phi = Math.atan2(my / u - home.y, (mx / u - home.x) * side);
    // Never into the fissure: a medial region is named above or below instead.
    if (Math.cos(phi) < 0.1) phi = Math.sign(Math.sin(phi) || 1) * (Math.PI / 2 - 0.5);
    // And never straight under the brain, where the footer is.
    if (Math.sin(phi) > 0.6 && Math.cos(phi) > 0) phi = Math.min(phi, Math.PI / 2 - 0.5);

    const centred = Math.abs(Math.cos(phi)) < 0.3;
    const rim = pointAt(side, phi, 1);
    const seat = pointAt(side, phi, centred ? LABEL_OUT_CENTRED : LABEL_OUT);
    const rimX = rim.x * u;
    const rimY = rim.y * u;
    const lx = seat.x * u;
    const ly = seat.y * u;

    // The leader ends at the member nearest the rim point, not at the hub across
    // the region: a line over the whole cell would read as a link.
    let from = region.members[0]!;
    let best = Infinity;
    for (const i of region.members) {
      const d = (x[i]! - rimX) ** 2 + (y[i]! - rimY) ** 2;
      if (d < best) {
        best = d;
        from = i;
      }
    }

    out.push({
      region: region.id,
      text: region.name,
      x: lx,
      y: ly,
      fromX: x[from]!,
      fromY: y[from]!,
      cx: 0,
      cy: 0,
      align: centred ? 'center' : lx >= 0 ? 'left' : 'right',
      above: ly < rimY,
      rx: rimX,
      ry: rimY,
    });
  }

  // Push apart names that would collide: down each flank, along each of the two
  // ends. Sorted first, so the rule is the same however the regions arrived.
  const gap = LABEL_GAP * u;
  for (const align of ['left', 'right'] as const) {
    const column = out.filter((l) => l.align === align).sort((a, b) => a.y - b.y);
    for (let i = 1; i < column.length; i += 1) {
      const prev = column[i - 1]!;
      const here = column[i]!;
      if (here.y - prev.y < gap) (here as { y: number }).y = prev.y + gap;
    }
  }
  for (const top of [true, false]) {
    const row = out.filter((l) => l.align === 'center' && l.y < l.ry === top).sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.length; i += 1) {
      const prev = row[i - 1]!;
      const here = row[i]!;
      if (here.x - prev.x < gap * 2.6) (here as { x: number }).x = prev.x + gap * 2.6;
    }
  }

  // Pushing names apart can slide one back over the tissue — a name down the
  // flank moves towards the middle of the hemisphere, not away from it. So each
  // one is walked outwards until it is clear of the outline again. This is the
  // rule the prototype did not have and the reason a region near the front used
  // to have its name written across its own notes.
  const clearance = view.unit * 0.05;
  for (const l of out) {
    const dirX = l.align === 'center' ? 0 : l.align === 'left' ? 1 : -1;
    const dirY = l.align === 'center' ? (l.above ? -1 : 1) : 0;
    let steps = 0;
    while (steps < 80 && (view.inside(l.x, l.y) || view.inside(l.x + dirX * clearance, l.y + dirY * clearance))) {
      (l as { x: number }).x = l.x + dirX * clearance;
      (l as { y: number }).y = l.y + dirY * clearance;
      steps += 1;
    }
  }

  // The swung leader: one quadratic, bowed away from the brain so it reads as a
  // pointer rather than as another tract.
  for (const l of out) {
    const dx = l.x - l.fromX;
    const dy = l.y - l.fromY;
    const d = Math.hypot(dx, dy) || 1;
    const bow = (l.above ? -1 : 1) * (l.align === 'right' ? -1 : 1) * 0.18 * d;
    (l as { cx: number }).cx = (l.fromX + l.x) / 2 - (dy / d) * bow;
    (l as { cy: number }).cy = (l.fromY + l.y) / 2 + (dx / d) * bow;
  }

  return out.map(({ rx: _rx, ry: _ry, ...label }) => label);
}
