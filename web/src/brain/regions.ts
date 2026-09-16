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
 * What a region's name needs to know about the world: which way is out, where
 * the rim is in that direction, and which of its notes the leader starts at.
 *
 * World units. Where the name is actually written is a screen question —
 * text width, canvas size, controls over the canvas — and is `labels.ts`'s.
 */
export interface RegionAnchor {
  region: number;
  text: string;
  side: -1 | 1;
  /** Notes in the region: larger regions keep their name when room runs out. */
  weight: number;
  /** The member the leader starts at: the one nearest the rim point. */
  anchorX: number;
  anchorY: number;
  rimX: number;
  rimY: number;
  /** Outward, a unit vector. */
  dirX: number;
  dirY: number;
  /** True for a region against the fissure: named above or below the brain. */
  medial: boolean;
  /** World x of the fissure, the same for every region. */
  fissureX: number;
  /**
   * The longest a leader may be, world units. Further than this from its notes a
   * name no longer reads as theirs, and is better left out.
   */
  reach: number;
  /**
   * For a medial region, the ordinary outward placement, tried when there is no
   * room above or below. Null for every other region.
   */
  alternate: Omit<RegionAnchor, 'region' | 'text' | 'side' | 'weight' | 'medial' | 'fissureX' | 'alternate'> | null;
}

/**
 * How close to the fissure a region's centre may be, as a share of the way from
 * the fissure to its hemisphere's centre, before it counts as medial.
 */
const MEDIAL_NEAR = 0.45;
/** A leader may be at most this share of the brain's width. */
const LEADER_REACH = 0.28;
/**
 * A medial leader may additionally cross this share of the brain's width of
 * tissue on its way to the top or bottom rim. A region buried deeper than that
 * is not named from above or below — its leader would read as a tract.
 */
const MEDIAL_DEPTH = 0.12;
/** A medial name leans this much towards its own side as it goes up or down. */
const MEDIAL_LEAN = 0.12;
/** Walking out to the rim: march in these steps (share of a unit), then bisect. */
const RIM_MARCH = 0.02;
const RIM_MARCHES = 150;
const RIM_STEPS = 10;

/**
 * Per region, which way its name should go.
 *
 * Outward from the middle of its hemisphere through the middle of its notes —
 * so a name sits at the edge next to the notes it names. Two things are
 * measured rather than assumed, so that this follows whatever the layout does:
 * the hemisphere's middle is the mean of its regions' centres, and the fissure
 * is half way between the two hemispheres.
 *
 * A region against the fissure has no outer edge of its own; pointing its name
 * outward from its hemisphere's middle sends it across the whole half to the
 * far flank, which is how the maps of content, sitting at the fissure, came to
 * be named at the top left. Such a region is named straight above or below the
 * brain instead, leaning to its own side.
 *
 * Nothing here depends on what a region is called or how many there are.
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

  const out: RegionAnchor[] = [];
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
    const h = hemi(side);
    let dx = mx - h.x;
    let dy = my - h.y;
    const dl = Math.hypot(dx, dy);
    if (dl > 1e-6) {
      dx /= dl;
      dy /= dl;
    } else {
      dx = side;
      dy = 0;
    }

    // Medial: against the fissure, or pointing into it. A region whose outward
    // direction is merely steep — one at the top or bottom of its hemisphere —
    // is not medial; its own direction already goes up or down.
    const towardFissure = Math.abs(mx - fissure) < MEDIAL_NEAR * Math.abs(h.x - fissure);
    const medial = towardFissure || dx * side < 0;
    const width = view.bounds.maxX - view.bounds.minX;

    // The ordinary placement: outward from the middle of the notes to the rim,
    // the leader starting at the note nearest that point — a line across the
    // whole region would read as a link.
    const outward = (() => {
      const end = walkToRim(view, mx, my, dx, dy);
      let pick = region.members[0]!;
      let best = Infinity;
      for (const i of region.members) {
        const d = (x[i]! - end.x) ** 2 + (y[i]! - end.y) ** 2;
        if (d < best) {
          best = d;
          pick = i;
        }
      }
      return {
        anchorX: x[pick]!,
        anchorY: y[pick]!,
        rimX: end.x,
        rimY: end.y,
        dirX: dx,
        dirY: dy,
        reach: LEADER_REACH * width,
      };
    })();

    let primary = outward;
    let alternate: RegionAnchor['alternate'] = null;
    if (medial) {
      // Up or down, whichever rim is nearer the region's notes, leaning only a
      // little to its own side: the leader then runs along the fissure, in the
      // dark, over as little of the neighbouring regions as possible.
      let bestGap = Infinity;
      let vertical: typeof outward | null = null;
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
        const end = walkToRim(view, x[pick]!, y[pick]!, ux, uy);
        const gap = Math.hypot(end.x - x[pick]!, end.y - y[pick]!);
        // Ties go up, so the choice does not flip on a rounding error.
        if (gap < bestGap - 1e-6) {
          bestGap = gap;
          vertical = {
            anchorX: x[pick]!,
            anchorY: y[pick]!,
            rimX: end.x,
            rimY: end.y,
            dirX: ux,
            dirY: uy,
            reach: LEADER_REACH * width + Math.min(gap, MEDIAL_DEPTH * width),
          };
        }
      }
      if (vertical !== null) {
        primary = vertical;
        alternate = outward;
      }
    }
    const { anchorX, anchorY, rimX, rimY, reach } = primary;
    dx = primary.dirX;
    dy = primary.dirY;

    out.push({
      region: region.id,
      text: region.name,
      side,
      weight: region.members.length,
      anchorX,
      anchorY,
      rimX,
      rimY,
      dirX: dx,
      dirY: dy,
      medial,
      fissureX: fissure,
      reach,
      alternate,
    });
  }
  return out;
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
