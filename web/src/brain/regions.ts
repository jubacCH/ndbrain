/**
 * The silhouette and its regions, as everything that paints reads them.
 *
 * This file is the seam between the two halves of the brain work. The layout
 * owns the shape — which note sits in which cell of the outline, where a cell's
 * hub is, and where the outline runs — and everything below it (edges,
 * decoration, labels) only reads. The contract was fixed in writing so both
 * halves could be built at once, and `layout.ts` now implements it:
 *
 * ```ts
 * readonly regions: readonly Region[];
 * readonly regionOf: Int32Array;
 * readonly nodeSide: Int8Array;
 * inside(x, y): boolean;
 * depthInside(x, y): number;
 * ```
 *
 * Until the layout carried those, this file derived a stand-in from the
 * clusters. That is gone. It mattered while the two halves were built in
 * parallel and it is a liability now: its region names were cluster names, and
 * a cluster is named after its folder — which is how "22_Selfhosted-Services ·
 * MOC — Selfhosted Services (Konflikt 2026-08-17 10.29)" came to be written
 * along the rim of the brain. A region's name is `Region.name` and nothing else.
 *
 * What is left here is the small amount of work that is genuinely the picture's
 * and not the layout's: `RegionView` names the two geometric questions so that
 * `deco.ts` and `edges.ts` can be written against an interface rather than
 * against `BrainLayout`, and `regionAnchors` says, per region, which way is out.
 *
 * World units throughout, the layout's own: normalised outline coordinates
 * times `unitLength`. Callers never see the normalised ones.
 */

import type { BrainLayout, Region } from './layout';

export type { Region };

/** What a layout hands to everything that paints. */
export interface RegionView {
  readonly regions: readonly Region[];
  /** Region index per node index. */
  readonly regionOf: Int32Array;
  /** Hemisphere per node index, -1 or 1. */
  readonly nodeSide: Int8Array;
  /** True when the point lies inside the silhouette. Decoration clips against this. */
  inside(x: number, y: number): boolean;
  /** Distance from (x, y) to the silhouette edge, in world units, negative outside. */
  depthInside(x: number, y: number): number;
  /** World length of one normalised outline unit. */
  readonly unit: number;
  /** The world rectangle the brain fills. */
  readonly bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** True when this is a brain, not the loose neighbourhood arrangement. */
  readonly shaped: boolean;
}

/**
 * Reads the contract off a layout.
 *
 * The two geometry calls are bound once here rather than being reached through
 * the layout on every one of the several hundred thousand `inside` tests the
 * tissue makes while it grows.
 */
export function regionView(layout: BrainLayout): RegionView {
  const shaped = layout.arrangement === 'brain';
  return {
    regions: shaped ? layout.regions : [],
    regionOf: layout.regionOf,
    nodeSide: layout.nodeSide,
    inside: (x, y) => layout.inside(x, y),
    depthInside: (x, y) => layout.depthInside(x, y),
    unit: layout.unitLength,
    bounds: layout.bounds,
    shaped,
  };
}

/**
 * One way a region's name can go: where its leader starts, which way is out,
 * and where the rim is in that direction. World units.
 */
export interface LabelWay {
  /** Where the leader starts: a note of the region, or the middle of its largest cluster. */
  anchorX: number;
  anchorY: number;
  rimX: number;
  rimY: number;
  /** Outward, a unit vector. */
  dirX: number;
  dirY: number;
}

/**
 * What a region's name needs to know about the world. Where the name is actually
 * written is a screen question — text width, canvas size, controls over the
 * canvas — and is `labels.ts`'s.
 */
export interface RegionAnchor {
  region: number;
  text: string;
  side: -1 | 1;
  /** Notes in the region: larger regions keep their name when room runs out. */
  weight: number;
  /** True for a region against the fissure: one of its ways goes above or below the brain. */
  medial: boolean;
  /** World x of the fissure, the same for every region. */
  fissureX: number;
  /**
   * The longest a leader may be, world units. Further than this from its notes a
   * name no longer reads as theirs, and is better left out.
   */
  reach: number;
  /**
   * The ways the name may go, at least one. Placement takes whichever gives the
   * shortest leader that keeps every rule — not the first that fits.
   */
  ways: readonly LabelWay[];
}

/**
 * How close to the fissure a region's centre may be, as a share of the way from
 * the fissure to its hemisphere's centre, before it counts as medial.
 */
const MEDIAL_NEAR = 0.45;
/**
 * A leader may be at most this share of the brain's width.
 *
 * 18 % since 2026-09-16, down from 28 %. At 28 % every name kept the rules, and
 * still the eye did not join "Networking" at the bottom to notes half way up
 * the hemisphere. Julian asked for names visibly beside their regions; a name
 * that cannot be placed that near is left out.
 */
const LEADER_REACH = 0.18;
/** A medial name leans this much towards its own side as it goes up or down. */
const MEDIAL_LEAN = 0.12;
/** Walking out to the rim: march in these steps (share of a unit), then bisect. */
const RIM_MARCH = 0.02;
const RIM_MARCHES = 150;
const RIM_STEPS = 10;
/**
 * Two notes of a region belong to the same cluster when they are within this
 * many times the region's median nearest-neighbour distance, directly or
 * through other notes. The layout draws notes as star clusters around a few
 * cores; this finds those clusters from the positions alone.
 */
const CLUSTER_LINK = 2.4;

/**
 * Per region, the ways its name may go.
 *
 * **From its largest cluster.** Since the layout draws regions as star clusters,
 * the middle of a region's notes can lie in the empty space between two of its
 * clusters, and a leader to it points at nothing. The middle of its largest
 * cluster is where the eye already is. Outward from there to the rim.
 *
 * **From its outermost note.** Outward from the middle of the region, starting
 * at the member nearest that rim point: the rule this file had before, kept as
 * a way because it is often the shorter one.
 *
 * **Above or below, for a region against the fissure.** Pointing outward from its
 * hemisphere's middle would send its name across the whole half to the far
 * flank. Up or down instead, whichever rim is nearer, leaning a little to its
 * own side.
 *
 * Two things are measured rather than assumed, so that this follows whatever the
 * layout does: a hemisphere's middle is the mean of its regions' centres, and
 * the fissure is half way between the two. Nothing here depends on what a region
 * is called or how many there are.
 */
export function regionAnchors(view: RegionView, x: ArrayLike<number>, y: ArrayLike<number>): RegionAnchor[] {
  if (!view.shaped) return [];

  const middle = { [-1]: { x: 0, y: 0, n: 0 }, [1]: { x: 0, y: 0, n: 0 } };
  for (const r of view.regions) {
    const m = middle[r.side];
    const w = Math.max(1, r.members.length);
    m.x += r.cx * w;
    m.y += r.cy * w;
    m.n += w;
  }
  const hemi = (side: -1 | 1): { x: number; y: number } => {
    const m = middle[side];
    return m.n > 0 ? { x: m.x / m.n, y: m.y / m.n } : { x: side * view.unit * 0.6, y: 0 };
  };
  const fissure = (hemi(-1).x + hemi(1).x) / 2;
  const width = view.bounds.maxX - view.bounds.minX;

  const out: RegionAnchor[] = [];
  for (const region of view.regions) {
    if (region.members.length === 0) continue;
    const side = region.side;
    const h = hemi(side);

    let mx = 0;
    let my = 0;
    for (const i of region.members) {
      mx += x[i]!;
      my += y[i]!;
    }
    mx /= region.members.length;
    my /= region.members.length;

    /** Outward from the hemisphere's middle through (px, py); sideways if they coincide. */
    const outward = (px: number, py: number): { dx: number; dy: number } => {
      const dx = px - h.x;
      const dy = py - h.y;
      const l = Math.hypot(dx, dy);
      return l > 1e-6 ? { dx: dx / l, dy: dy / l } : { dx: side, dy: 0 };
    };

    const towardFissure = Math.abs(mx - fissure) < MEDIAL_NEAR * Math.abs(h.x - fissure);
    const regionOut = outward(mx, my);
    const medial = towardFissure || regionOut.dx * side < 0;

    const ways: LabelWay[] = [];

    // From the largest cluster.
    const cluster = largestCluster(region.members, x, y);
    if (cluster !== null) {
      const dir = outward(cluster.x, cluster.y);
      if (dir.dx * side >= 0) {
        const rim = walkToRim(view, cluster.x, cluster.y, dir.dx, dir.dy);
        ways.push({ anchorX: cluster.x, anchorY: cluster.y, rimX: rim.x, rimY: rim.y, dirX: dir.dx, dirY: dir.dy });
      }
    }

    // From the outermost note.
    if (!medial) {
      const rim = walkToRim(view, mx, my, regionOut.dx, regionOut.dy);
      const pick = nearest(region.members, x, y, rim.x, rim.y);
      ways.push({ anchorX: x[pick]!, anchorY: y[pick]!, rimX: rim.x, rimY: rim.y, dirX: regionOut.dx, dirY: regionOut.dy });
    }

    // Above or below, for a region against the fissure.
    if (medial) {
      for (const up of [true, false]) {
        let ux = side * MEDIAL_LEAN;
        let uy = up ? -1 : 1;
        const l = Math.hypot(ux, uy);
        ux /= l;
        uy /= l;
        // The note furthest in that direction, nearest the fissure among those.
        let pick = region.members[0]!;
        let bestScore = -Infinity;
        for (const i of region.members) {
          const score = (up ? -y[i]! : y[i]!) - Math.abs(x[i]! - fissure) * 0.5;
          if (score > bestScore) {
            bestScore = score;
            pick = i;
          }
        }
        const rim = walkToRim(view, x[pick]!, y[pick]!, ux, uy);
        ways.push({ anchorX: x[pick]!, anchorY: y[pick]!, rimX: rim.x, rimY: rim.y, dirX: ux, dirY: uy });
      }
    }

    // Never none: a region whose every way pointed inward still has its outward one.
    if (ways.length === 0) {
      const rim = walkToRim(view, mx, my, regionOut.dx, regionOut.dy);
      const pick = nearest(region.members, x, y, rim.x, rim.y);
      ways.push({ anchorX: x[pick]!, anchorY: y[pick]!, rimX: rim.x, rimY: rim.y, dirX: regionOut.dx, dirY: regionOut.dy });
    }

    out.push({
      region: region.id,
      text: region.name,
      side,
      weight: region.members.length,
      medial,
      fissureX: fissure,
      reach: LEADER_REACH * width,
      ways,
    });
  }
  return out;
}

function nearest(members: readonly number[], x: ArrayLike<number>, y: ArrayLike<number>, px: number, py: number): number {
  let pick = members[0]!;
  let best = Infinity;
  for (const i of members) {
    const d = (x[i]! - px) ** 2 + (y[i]! - py) ** 2;
    if (d < best) {
      best = d;
      pick = i;
    }
  }
  return pick;
}

/**
 * The middle of a region's largest cluster of notes, by proximity alone.
 *
 * Single linkage over the members: two notes are in the same cluster when a
 * chain of notes connects them with no step longer than `CLUSTER_LINK` times
 * the region's median nearest-neighbour distance. Null for a region too small
 * to have clusters.
 */
export function largestCluster(
  members: readonly number[],
  x: ArrayLike<number>,
  y: ArrayLike<number>,
): { x: number; y: number; size: number } | null {
  const k = members.length;
  if (k < 3) return null;
  const nn: number[] = [];
  for (let a = 0; a < k; a += 1) {
    let best = Infinity;
    for (let b = 0; b < k; b += 1) {
      if (a === b) continue;
      best = Math.min(best, Math.hypot(x[members[a]!]! - x[members[b]!]!, y[members[a]!]! - y[members[b]!]!));
    }
    nn.push(best);
  }
  nn.sort((p, q) => p - q);
  const link = (nn[Math.floor(k / 2)] ?? 0) * CLUSTER_LINK;

  const group = new Int32Array(k).fill(-1);
  let groups = 0;
  for (let start = 0; start < k; start += 1) {
    if (group[start] !== -1) continue;
    const stack = [start];
    group[start] = groups;
    while (stack.length > 0) {
      const a = stack.pop()!;
      for (let b = 0; b < k; b += 1) {
        if (group[b] !== -1) continue;
        if (Math.hypot(x[members[a]!]! - x[members[b]!]!, y[members[a]!]! - y[members[b]!]!) <= link) {
          group[b] = groups;
          stack.push(b);
        }
      }
    }
    groups += 1;
  }

  // Largest group; ties go to the lower group number, which is member order.
  const sizes = new Array<number>(groups).fill(0);
  for (let a = 0; a < k; a += 1) sizes[group[a]!] = sizes[group[a]!]! + 1;
  let largest = 0;
  for (let g = 1; g < groups; g += 1) if (sizes[g]! > sizes[largest]!) largest = g;

  let cx = 0;
  let cy = 0;
  for (let a = 0; a < k; a += 1) {
    if (group[a] !== largest) continue;
    cx += x[members[a]!]!;
    cy += y[members[a]!]!;
  }
  return { x: cx / sizes[largest]!, y: cy / sizes[largest]!, size: sizes[largest]! };
}

/**
 * The last point still inside the silhouette, going from (x, y) along (dx, dy).
 *
 * Marched first and bisected after, not bisected over the whole range: a ray
 * can leave one hemisphere, cross the fissure and enter the other, and a plain
 * bisection over that range would happily settle on the far side.
 */
function walkToRim(view: RegionView, x: number, y: number, dx: number, dy: number): { x: number; y: number } {
  const step = view.unit * RIM_MARCH;
  const inside = (t: number): boolean => view.inside(x + dx * t, y + dy * t);
  // A note can sit just outside the rim; then the rim is behind it.
  const dir = inside(0) ? 1 : -1;
  let last = 0;
  let found = false;
  for (let k = 1; k <= RIM_MARCHES; k += 1) {
    const t = dir * k * step;
    if (inside(t) !== (dir === 1)) {
      found = true;
      break;
    }
    last = t;
  }
  if (!found) return { x: x + dx * last, y: y + dy * last };
  let lo = last;
  let hi = last + dir * step;
  for (let k = 0; k < RIM_STEPS; k += 1) {
    const mid = (lo + hi) / 2;
    if (inside(mid) === (dir === 1)) lo = mid;
    else hi = mid;
  }
  const t = dir === 1 ? lo : hi;
  return { x: x + dx * t, y: y + dy * t };
}
