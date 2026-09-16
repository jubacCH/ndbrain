/**
 * The tissue: fog, folds, dust and dendrites.
 *
 * Everything in this file is **decoration**. It is not data, it is never hit
 * tested, and it is named as decoration in the legend. It exists because of what
 * the optics prototype showed: a hundred notes and five hundred links are a
 * constellation, not a brain. What makes the silhouette read between the
 * clusters is the quiet matter around them — a faint haze over the area, folds
 * that cross and merge, a fine grain along those folds, and short branches
 * growing out of every real note into the space around it.
 *
 * Four rules keep it honest, and they are the reason Julian agreed to have it at
 * all:
 *
 *  1. **Never mistakable for a link or a note.** No grain has a white core, and
 *     no branch is drawn wider than the thinnest tract or longer than a note's
 *     own radius before it fades out. Its opacity at the cell body sits between
 *     a held-back link and a quiet one — the separation that matters is width,
 *     length and which layer it is in, and those are checked in the test rather
 *     than asserted here.
 *  2. **Never clickable.** It lives in its own layer and the hit index never
 *     sees it. There is no path from a pixel of dust to a note.
 *  3. **Always inside.** Every point is clipped against the layout's
 *     `inside`, and everything fades out over the last tenth of the reach, so
 *     the outline ends in a soft edge rather than a cut.
 *  4. **Gone when you come closer.** Zooming in is the brain dissolving into
 *     notes; the tissue fades out as the titles fade in.
 *
 * **Written against the contract, not against the outline.** Nothing here
 * imports `shape.ts`. The one thing the folds need that `inside` does not give —
 * a way to walk around the hemisphere at a fixed depth — is measured by ray
 * casting against `inside` itself (`rimTable`). So the day the silhouette
 * changes, the tissue follows it without a line of this file changing.
 *
 * Built once per layout, in world units. Rendering it is `bloom.ts`'s job, and
 * happens once per camera stand.
 */

import type { RegionView } from './regions';
import { hash32 } from './seed';

/** A polyline. A break in the line is a NaN pair, not a null: this is a flat buffer. */
export interface DecoLine {
  readonly pts: Float64Array;
  readonly n: number;
  readonly alpha: number;
}

export interface Decoration {
  /** Fog discs: x, y, weight triples. */
  readonly fog: Float32Array;
  readonly fogCount: number;
  /** Radius of one fog disc, world units. */
  readonly fogRadius: number;
  /** Opacity of one fog disc at its centre, already divided by how many overlap. */
  readonly fogAlpha: number;
  readonly folds: readonly DecoLine[];
  readonly sulci: readonly DecoLine[];
  /** Grains: x, y, radius, alpha, warm (0 or 1). */
  readonly dust: Float32Array;
  readonly dustCount: number;
  /** Branches: x1, y1, x2, y2, depth (0 at the note, 1 at the tip), warm. */
  readonly dendrites: Float32Array;
  readonly dendriteCount: number;
}

/** An empty tissue, for the neighbourhood panel and for an empty vault. */
export const NO_DECORATION: Decoration = {
  fog: new Float32Array(0),
  fogCount: 0,
  fogRadius: 1,
  fogAlpha: 0,
  folds: [],
  sulci: [],
  dust: new Float32Array(0),
  dustCount: 0,
  dendrites: new Float32Array(0),
  dendriteCount: 0,
};

/** Angular resolution of the measured rim. One degree is finer than any fold. */
const RIM_STEPS = 360;
/** Bisection steps per ray when measuring the rim. Twelve is a four-thousandth. */
const RIM_BISECT = 12;

/** Folds run from this fraction of the reach outwards, this far apart. */
const FOLD_FROM = 0.2;
const FOLD_TO = 0.985;
const FOLD_STEP = 0.04;
/** Points along one fold. */
const FOLD_POINTS = 280;
/**
 * The fold's wobble is *larger* than the spacing between folds, on purpose:
 * neighbouring folds then cross and merge into windings, instead of stacking up
 * as contour rings on a map.
 */
const WOBBLE_MIN = 0.03;
const WOBBLE_RANGE = 0.03;
/** Everything decorative fades out over the last tenth of the reach. */
const FADE = 0.1;
/** A dendrite stops here, short of the rim. */
const DENDRITE_REACH = 0.96;

/**
 * How a branch is drawn: width and opacity at the cell body, and at the tip.
 *
 * Here rather than in the renderer because they are what keeps decoration from
 * reading as data, and the test that fixes that compares them against the tract
 * widths in `edges.ts`. The renderer only obeys them.
 */
export const DENDRITE_WIDTH = 1.2;
export const DENDRITE_TIP_WIDTH = 0.4;
export const DENDRITE_ALPHA = 0.38;
export const DENDRITE_TIP_ALPHA = 0.1;

/**
 * The haze over the brain's area, and how it is spread.
 *
 * `FOG_GAIN` is the only brightness knob and is what the luminance measurement
 * is tuned against; the step and the radius decide the texture. Measured
 * against the target picture on 2026-09-16.
 */
const FOG_GAIN = 0.42;
const FOG_STEP = 0.02;
const FOG_RADIUS = 0.075;

/** Grains per fold, and how many more the outer folds carry. */
const GRAIN_BASE = 120;
const GRAIN_REACH = 280;
/** Attractor points per hemisphere, and how they grow with the vault. */
const ATTRACT_BASE = 3400;
const ATTRACT_PER_NOTE = 10;
const ATTRACT_MAX = 6000;

/** Space colonisation: how far a note reaches, how far it steps, what it kills. */
const GROW_STEPS = 26;
const GROW_INFLUENCE = 0.06;
const GROW_KILL = 0.0095;
const GROW_STEP = 0.007;
const GROW_REACH = 0.6;
const GROW_REACH_MIN = 0.05;
const GROW_REACH_MAX = 0.14;

/** Deterministic noise: the same vault gives the same tissue on any machine. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

/**
 * Where each hemisphere sits, and how far its rim is in every direction.
 *
 * Measured, not assumed: a ray from the hemisphere's middle, bisected until it
 * finds the last point `inside` still accepts. That is the only way to walk
 * around the outline while knowing nothing about it — and it means the tissue
 * follows a changed silhouette for free.
 */
interface Rim {
  cx: number;
  cy: number;
  /** Rim radius per whole degree, world units. */
  radius: Float64Array;
}

function rimTable(view: RegionView, side: -1 | 1): Rim | null {
  let cx = 0;
  let cy = 0;
  let weight = 0;
  for (const region of view.regions) {
    if (region.side !== side) continue;
    const w = Math.max(1, region.members.length);
    cx += region.cx * w;
    cy += region.cy * w;
    weight += w;
  }
  if (weight === 0) return null;
  cx /= weight;
  cy /= weight;
  if (!view.inside(cx, cy)) return null;

  const radius = new Float64Array(RIM_STEPS);
  // Far enough that no rim can be beyond it: the outline is a couple of units
  // wide and the search only ever shrinks.
  const far = Math.max(1, Math.abs(cx) + Math.abs(cy)) * 8 + view.unit * 4;
  for (let k = 0; k < RIM_STEPS; k += 1) {
    const phi = (k / RIM_STEPS) * Math.PI * 2;
    const dx = Math.cos(phi);
    const dy = Math.sin(phi);
    let lo = 0;
    let hi = far;
    for (let b = 0; b < RIM_BISECT; b += 1) {
      const mid = (lo + hi) / 2;
      if (view.inside(cx + dx * mid, cy + dy * mid)) lo = mid;
      else hi = mid;
    }
    radius[k] = lo;
  }
  return { cx, cy, radius };
}

/** A point at `fraction` of the rim in direction `phi` (radians), world units. */
function at(rim: Rim, phi: number, fraction: number, out: { x: number; y: number }): void {
  const turns = phi / (Math.PI * 2);
  const k = ((turns % 1) + 1) % 1;
  const i = k * RIM_STEPS;
  const a = Math.floor(i) % RIM_STEPS;
  const b = (a + 1) % RIM_STEPS;
  const f = i - Math.floor(i);
  const r = (rim.radius[a]! + (rim.radius[b]! - rim.radius[a]!) * f) * fraction;
  out.x = rim.cx + Math.cos(phi) * r;
  out.y = rim.cy + Math.sin(phi) * r;
}

export interface DecoInput {
  view: RegionView;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  /** True for a note drawn in the warm accent. Its branches are warm too. */
  warm: ArrayLike<number>;
}

/**
 * Builds the whole tissue for one layout.
 *
 * Runs once when the layout settles, not per frame and not per camera stand. On
 * the real vault it is a few tens of milliseconds and a couple of megabytes of
 * flat arrays; on a layout that is still moving it would be wasted work, which
 * is why the caller waits.
 */
export function buildDecoration({ view, x, y, warm }: DecoInput): Decoration {
  if (!view.shaped || view.regions.length === 0) return NO_DECORATION;
  const rims: Array<{ side: -1 | 1; rim: Rim }> = [];
  for (const side of [-1, 1] as const) {
    const rim = rimTable(view, side);
    if (rim !== null) rims.push({ side, rim });
  }
  if (rims.length === 0) return NO_DECORATION;

  const notes = x.length;
  const random = rng(hash32(`cortex:${notes}:${view.regions.length}`));
  const point = { x: 0, y: 0 };

  const folds: DecoLine[] = [];
  const sulci: DecoLine[] = [];
  const dust: number[] = [];
  const attract: number[] = [];

  for (const { rim } of rims) {
    for (let f = FOLD_FROM; f < FOLD_TO; f += FOLD_STEP) {
      const ph1 = random() * 6.28;
      const ph2 = random() * 6.28;
      const ph3 = random() * 6.28;
      const ph4 = random() * 6.28;
      const k1 = 5 + Math.floor(random() * 4);
      const k2 = 9 + Math.floor(random() * 6);
      const amp = WOBBLE_MIN + random() * WOBBLE_RANGE;
      const fade = clamp((1 - f) / FADE, 0, 1);

      const path = new Float64Array((FOLD_POINTS + 1) * 2);
      let used = 0;
      for (let k = 0; k <= FOLD_POINTS; k += 1) {
        const phi = (k / FOLD_POINTS) * Math.PI * 2 - Math.PI;
        const depth =
          f +
          amp * Math.sin(k1 * phi + ph1) +
          amp * 0.6 * Math.sin(k2 * phi + ph2) +
          0.014 * Math.sin(23 * phi + ph3) +
          0.008 * Math.sin(37 * phi + ph4);
        at(rim, phi, clamp(depth, 0.05, FOLD_TO), point);
        // Gaps along each fold: broken folds, not contour rings.
        const gap = Math.sin((3 + (k1 % 3)) * phi + ph3) < -0.4;
        if (gap || !view.inside(point.x, point.y)) {
          path[used * 2] = Number.NaN;
          path[used * 2 + 1] = Number.NaN;
        } else {
          path[used * 2] = point.x;
          path[used * 2 + 1] = point.y;
        }
        used += 1;
      }

      // Three thin strands of differing brightness per fold, slightly offset:
      // one line reads as a wire, three read as a winding.
      for (const [offset, weight] of [
        [0, 1],
        [0.007, 0.55],
        [-0.006, 0.4],
      ] as const) {
        const strand = new Float64Array(used * 2);
        for (let k = 0; k < used; k += 1) {
          const px = path[k * 2]!;
          if (Number.isNaN(px)) {
            strand[k * 2] = Number.NaN;
            strand[k * 2 + 1] = Number.NaN;
            continue;
          }
          const a = (k / FOLD_POINTS) * 6.28;
          strand[k * 2] = px + offset * view.unit * Math.cos(a);
          strand[k * 2 + 1] = path[k * 2 + 1]! + offset * view.unit * Math.sin(a + 1);
        }
        folds.push({ pts: strand, n: used, alpha: (0.05 + f * 0.09) * weight * (0.6 + random() * 0.6) * fade });
      }

      // Grain along the fold. The texture then reads as gyri, not as noise.
      const grains = Math.round(GRAIN_BASE + GRAIN_REACH * f);
      for (let k = 0; k < grains; k += 1) {
        const pick = Math.floor(random() * used);
        const px = path[pick * 2]!;
        if (Number.isNaN(px)) continue;
        const gx = px + (random() - 0.5) * 0.016 * view.unit;
        const gy = path[pick * 2 + 1]! + (random() - 0.5) * 0.016 * view.unit;
        if (!view.inside(gx, gy)) continue;
        dust.push(gx, gy, 0.35 + random() * 0.6, (0.22 + random() * 0.45) * fade, random() < 0.03 ? 1 : 0);
      }
    }

    // Sulci: three long folds per half, from the rim inwards. They read as the
    // divisions between the lobes and stop the half looking like one blob.
    for (const [phi0, dir, length] of [
      [-1.35, 1, 0.62],
      [-0.3, -1, 0.55],
      [0.75, 1, 0.5],
    ] as const) {
      const pts = new Float64Array(61 * 2);
      for (let k = 0; k <= 60; k += 1) {
        const t = k / 60;
        at(rim, phi0 + dir * 0.55 * Math.sin(t * Math.PI * 0.9) + 0.03 * Math.sin(t * 19), FOLD_TO - t * length, point);
        const ok = view.inside(point.x, point.y);
        pts[k * 2] = ok ? point.x : Number.NaN;
        pts[k * 2 + 1] = ok ? point.y : Number.NaN;
      }
      sulci.push({ pts, n: 61, alpha: 0.6 });
    }

    // An even scatter over the half: a little more dust, and the attractor
    // points the dendrites grow towards. The attractors are never drawn.
    const spread = Math.min(ATTRACT_MAX, ATTRACT_BASE + ATTRACT_PER_NOTE * notes);
    for (let k = 0; k < spread; k += 1) {
      const phi = random() * Math.PI * 2;
      const depth = Math.sqrt(random()) * FOLD_TO;
      at(rim, phi, depth, point);
      if (!view.inside(point.x, point.y)) continue;
      attract.push(point.x, point.y);
      if (k % 2 === 0) {
        dust.push(
          point.x,
          point.y,
          0.35 + random() * 0.5,
          (0.12 + random() * 0.3) * clamp((1 - depth) / FADE, 0, 1),
          random() < 0.04 ? 1 : 0,
        );
      }
    }
  }

  const dendrites = grow(view, x, y, warm, attract, random);

  // Fog: soft discs over the whole area, weighted down towards the rim. Summed
  // by the bloom they lift the brain's area above the sky without an outline
  // ever being drawn.
  //
  // The grid step decides how smooth the haze is and nothing else: a disc's
  // opacity is divided by how many discs cover a point, so halving the step
  // makes the fog finer, not brighter. Tuning the density and tuning the
  // brightness used to be the same knob, and every change to one silently
  // undid a measurement of the other.
  const fog: number[] = [];
  const step = view.unit * FOG_STEP;
  const reachOf = (px: number, py: number): number => {
    const room = view.depthInside(px, py);
    return room <= 0 ? 1 : clamp(1 - room / (view.unit * 0.42), 0, 1);
  };
  for (let gx = -1.35 * view.unit; gx <= 1.35 * view.unit; gx += step) {
    for (let gy = -1.15 * view.unit; gy <= 1.15 * view.unit; gy += step) {
      if (!view.inside(gx, gy)) continue;
      const r = reachOf(gx, gy);
      fog.push(gx, gy, 1 - Math.pow(r, 6));
    }
  }

  const fogRadius = view.unit * FOG_RADIUS;
  return {
    fog: Float32Array.from(fog),
    fogCount: fog.length / 3,
    fogRadius,
    // One disc's share of the haze: the total, divided by how many discs the
    // grid puts over any one point.
    fogAlpha: (FOG_GAIN * (step * step)) / (Math.PI * fogRadius * fogRadius),
    folds,
    sulci,
    dust: Float32Array.from(dust),
    dustCount: dust.length / 5,
    dendrites,
    dendriteCount: dendrites.length / 6,
  };
}

/**
 * Dendrites, by space colonisation.
 *
 * Every real note grows fine branches towards the attractor points around it,
 * reaching about half way to its nearest neighbour in the same region, so that
 * neighbouring trees meet in the middle rather than ending in mid-air. Thick and
 * (relatively) bright at the cell body, thin and faint at the tips — and still
 * darker at its brightest than the quietest real link, which is what keeps a
 * branch from being mistaken for one.
 */
function grow(
  view: RegionView,
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  warm: ArrayLike<number>,
  attract: readonly number[],
  random: () => number,
): Float32Array {
  const out: number[] = [];
  const count = attract.length / 2;
  if (count === 0) return new Float32Array(0);

  // A coarse grid over the attractors, so each note only looks at its own
  // neighbourhood instead of walking all nine thousand of them.
  const cell = view.unit * GROW_INFLUENCE * 2;
  const buckets = new Map<string, number[]>();
  const keyOf = (px: number, py: number): string => `${Math.floor(px / cell)}:${Math.floor(py / cell)}`;
  for (let k = 0; k < count; k += 1) {
    const key = keyOf(attract[k * 2]!, attract[k * 2 + 1]!);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [k]);
    else bucket.push(k);
  }

  const influence = view.unit * GROW_INFLUENCE;
  const kill = view.unit * GROW_KILL;
  const step = view.unit * GROW_STEP;

  for (let i = 0; i < x.length; i += 1) {
    const region = view.regions[view.regionOf[i]!];
    if (region === undefined) continue;
    let nearest = Infinity;
    for (const j of region.members) {
      if (j === i) continue;
      nearest = Math.min(nearest, Math.hypot(x[j]! - x[i]!, y[j]! - y[i]!));
    }
    if (!Number.isFinite(nearest)) nearest = view.unit * GROW_REACH_MAX;
    const reach = clamp(GROW_REACH * nearest, view.unit * GROW_REACH_MIN, view.unit * GROW_REACH_MAX);

    // The attractors in range, from the buckets that can hold them.
    const alive: number[] = [];
    const dead: boolean[] = [];
    const span = Math.ceil(reach / cell);
    const cx = Math.floor(x[i]! / cell);
    const cy = Math.floor(y[i]! / cell);
    for (let gx = cx - span; gx <= cx + span; gx += 1) {
      for (let gy = cy - span; gy <= cy + span; gy += 1) {
        const bucket = buckets.get(`${gx}:${gy}`);
        if (bucket === undefined) continue;
        for (const k of bucket) {
          const ax = attract[k * 2]!;
          const ay = attract[k * 2 + 1]!;
          if ((ax - x[i]!) ** 2 + (ay - y[i]!) ** 2 > reach * reach) continue;
          alive.push(ax, ay);
          dead.push(false);
        }
      }
    }
    if (dead.length === 0) continue;

    const treeX = [x[i]!];
    const treeY = [y[i]!];
    const depth = [0];
    const segments: number[] = [];
    let deepest = 1;

    for (let it = 0; it < GROW_STEPS; it += 1) {
      const pull = new Map<number, { x: number; y: number }>();
      for (let a = 0; a < dead.length; a += 1) {
        if (dead[a]) continue;
        const ax = alive[a * 2]!;
        const ay = alive[a * 2 + 1]!;
        let best = -1;
        let bestD = influence * influence;
        for (let t = 0; t < treeX.length; t += 1) {
          const d = (treeX[t]! - ax) ** 2 + (treeY[t]! - ay) ** 2;
          if (d < bestD) {
            bestD = d;
            best = t;
          }
        }
        if (best < 0) continue;
        const d = Math.sqrt(bestD) || 1;
        const acc = pull.get(best) ?? { x: 0, y: 0 };
        acc.x += (ax - treeX[best]!) / d;
        acc.y += (ay - treeY[best]!) / d;
        pull.set(best, acc);
      }
      if (pull.size === 0) break;

      const born: number[] = [];
      for (const [t, acc] of pull) {
        const l = Math.hypot(acc.x, acc.y) || 1;
        const move = step * (0.8 + random() * 0.5);
        const nx = treeX[t]! + (acc.x / l) * move + (random() - 0.5) * step * 0.3;
        const ny = treeY[t]! + (acc.y / l) * move + (random() - 0.5) * step * 0.3;
        const d = depth[t]! + 1;
        deepest = Math.max(deepest, d);
        segments.push(treeX[t]!, treeY[t]!, nx, ny, d);
        treeX.push(nx);
        treeY.push(ny);
        depth.push(d);
        born.push(treeX.length - 1);
      }
      for (let a = 0; a < dead.length; a += 1) {
        if (dead[a]) continue;
        const ax = alive[a * 2]!;
        const ay = alive[a * 2 + 1]!;
        for (const b of born) {
          if ((ax - treeX[b]!) ** 2 + (ay - treeY[b]!) ** 2 < kill * kill) {
            dead[a] = true;
            break;
          }
        }
      }
    }

    const hot = warm[i] === 1 ? 1 : 0;
    for (let s = 0; s < segments.length; s += 5) {
      const x2 = segments[s + 2]!;
      const y2 = segments[s + 3]!;
      // Cut at the silhouette: no branch past its last few percent.
      if (!view.inside(x2, y2)) continue;
      const room = view.depthInside(x2, y2);
      if (room < view.unit * (1 - DENDRITE_REACH) * 0.25) continue;
      out.push(segments[s]!, segments[s + 1]!, x2, y2, segments[s + 4]! / deepest, hot);
    }
  }

  return Float32Array.from(out);
}
