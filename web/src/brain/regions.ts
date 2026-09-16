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
 * against `BrainLayout`, and `regionLabels` decides where a name is written.
 *
 * World units throughout, the layout's own: normalised outline coordinates
 * times `unitLength`. Callers never see the normalised ones.
 */

import type { BrainLayout, Region } from './layout';
import { centre, pointAt } from './shape';

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
    shaped,
  };
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
