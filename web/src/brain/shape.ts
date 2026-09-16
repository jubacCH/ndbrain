/**
 * The outline the brain grows into.
 *
 * Not a mask and not a picture — nothing is ever drawn from it. Since phase 4 it
 * is not a soft wall either: it is the **container**. `layout.ts` samples the
 * inside of this outline, divides it into one cell per region and puts the notes
 * on places inside their cell, so the silhouette carries whether or not the
 * simulation runs. Before, regions were laid out freely and pressed into shape
 * by a force; the outline then held only as long as the forces balanced, and the
 * rim was ragged wherever they did not.
 *
 * Seen from above: two hemispheres side by side, the longitudinal fissure
 * between them running top to bottom. Each hemisphere is a star-shaped outline
 * around its own centre — round on the outer side, much flatter where it faces
 * the other one, a little narrower at the front — and the two differ slightly in
 * size, height and ripple. A perfectly mirrored pair of ellipses reads as a
 * diagram; this should read as something grown.
 *
 * **The numbers come from the optics prototype** (round 4, `brain-proto`), which
 * was tuned against the target picture and then measured: a bounding box of
 * about 1.11 : 1 over both halves, the back (screen down) ten percent wider than
 * the front, a medial side round enough (superellipse exponent 2.7) that the
 * fissure is narrow in the middle and cuts deeper at both ends, and a rim
 * notched by two slow ripples plus two faster gyri ripples (11 and 17 periods).
 * The earlier outline here was 1.42 : 1 with a flatter medial side; side by side
 * with the target it read as two eggs.
 *
 * Normalised coordinates here: the brain spans about −1.2…1.2 across. The layout
 * scales by a world length that grows with the number of notes, so a larger
 * vault gets a larger brain at the same density instead of a more crowded one.
 */

export type Side = -1 | 1;

interface Hemisphere {
  /** Centre, normalised. The outline is measured as a radius around it. */
  cx: number;
  cy: number;
  /** Half-width and half-height of the underlying oval. */
  rx: number;
  ry: number;
  /** Overall size, for the asymmetry between the halves. */
  scale: number;
  /** Phase of the four rim ripples, different per side. */
  phase2: number;
  phase3: number;
  phase11: number;
  phase17: number;
}

/**
 * The two halves.
 *
 * The left one is two percent larger and sits a touch higher; the ripples are
 * out of phase. Small enough that nobody sees a lopsided brain, large enough that
 * nobody sees a mirror.
 */
const HEMISPHERES: Record<Side, Hemisphere> = {
  [-1]: { cx: -0.575, cy: -0.01, rx: 0.565, ry: 1.0, scale: 1.02, phase2: 0.4, phase3: 1.1, phase11: 0.9, phase17: 2.6 },
  [1]: { cx: 0.575, cy: 0.01, rx: 0.555, ry: 0.99, scale: 1, phase2: 2.2, phase3: 4.0, phase11: 3.7, phase17: 0.4 },
};

/**
 * Superellipse exponents: how much flatter the inner side is than the outer.
 *
 * Both above 2, so neither side is a plain ellipse. The medial one is the larger
 * of the two — round rather than flat — which is what narrows the fissure in the
 * middle and lets it cut deeper at the front and the back.
 */
const MEDIAL_FLATNESS = 2.7;
const LATERAL_FLATNESS = 2.2;
/** How much narrower the front (top) is than the back. */
const FRONT_TAPER = 0.1;
/** Amplitude of the two slow rim ripples, and of the two faster gyri notches. */
const RIPPLE2 = 0.022;
const RIPPLE3 = 0.016;
const GYRI11 = 0.013;
const GYRI17 = 0.009;
/**
 * The fissure is never narrower than this, whatever the outline measures.
 *
 * With a round medial side the two rims can come within a few thousandths of
 * each other, and a gap that small is no gap: notes on either side would touch
 * across it and the eye would stop seeing two halves.
 */
const MIN_FISSURE = 0.028;

/**
 * The outline's radius around a hemisphere's centre, in the direction `phi`.
 *
 * `phi` is measured from the outward direction: 0 points away from the fissure,
 * ±π towards it, −π/2 to the front (screen up). Normalised units.
 */
export function rim(side: Side, phi: number): number {
  const h = HEMISPHERES[side];
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  // Two superellipses meeting at ±π/2, where both give `ry`, so the seam is
  // smooth: rounder towards the fissure than away from it.
  const p = c < 0 ? MEDIAL_FLATNESS : LATERAL_FLATNESS;
  const base = Math.pow(Math.pow(Math.abs(c) / h.rx, p) + Math.pow(Math.abs(s) / h.ry, p), -1 / p);
  // `s < 0` is the front (screen up): narrower there than at the back.
  const taper = 1 + FRONT_TAPER * s;
  const ripple =
    1 +
    RIPPLE2 * Math.cos(2 * phi + h.phase2) +
    RIPPLE3 * Math.sin(3 * phi + h.phase3) +
    GYRI11 * Math.sin(11 * phi + h.phase11) +
    GYRI17 * Math.sin(17 * phi + h.phase17);
  return base * taper * ripple * h.scale;
}

/** Which hemisphere a normalised point belongs to. The fissure is at x = 0. */
export function sideOf(x: number): Side {
  return x < 0 ? -1 : 1;
}

/** A hemisphere's centre, normalised. */
export function centre(side: Side): { x: number; y: number } {
  const h = HEMISPHERES[side];
  return { x: h.cx, y: h.cy };
}

/** The direction angle `rim` expects, for a normalised point relative to a side. */
export function angleOf(side: Side, x: number, y: number): number {
  const h = HEMISPHERES[side];
  return Math.atan2(y - h.cy, (x - h.cx) * side);
}

/**
 * How far out a normalised point lies, as a fraction of its hemisphere's rim in
 * that direction: below 1 inside, above 1 outside.
 */
export function reach(side: Side, x: number, y: number): number {
  const h = HEMISPHERES[side];
  const dx = x - h.cx;
  const dy = y - h.cy;
  return Math.hypot(dx, dy) / rim(side, Math.atan2(dy, dx * side));
}

/** A normalised point at `fraction` of the rim radius in direction `phi`. */
export function pointAt(side: Side, phi: number, fraction: number): { x: number; y: number } {
  const h = HEMISPHERES[side];
  const r = rim(side, phi) * fraction;
  return { x: h.cx + side * Math.cos(phi) * r, y: h.cy + Math.sin(phi) * r };
}

const SAMPLES = 720;

function measure(): { area: number; minX: number; maxX: number; minY: number; maxY: number; medial: number } {
  let area = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let medial = Infinity;
  for (const side of [-1, 1] as const) {
    for (let k = 0; k < SAMPLES; k += 1) {
      const phi = (k / SAMPLES) * Math.PI * 2 - Math.PI;
      const r = rim(side, phi);
      // Polar area element; the outline is star-shaped around the centre.
      area += 0.5 * r * r * ((Math.PI * 2) / SAMPLES);
      const p = pointAt(side, phi, 1);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
      medial = Math.min(medial, Math.abs(p.x));
    }
  }
  return { area, minX, maxX, minY, maxY, medial };
}

/** Measured once: both hemispheres' combined area, extent, and the fissure. */
export const OUTLINE = measure();

/**
 * Half the width of the gap between the hemispheres at its narrowest,
 * normalised. The fissure test, the cells and the simulation all use it.
 */
export const FISSURE = Math.max(OUTLINE.medial, MIN_FISSURE);

/**
 * A little wider than the fissure itself: how close to the middle a note may
 * come. A note exactly on the rim of the fissure has its cell body across it.
 */
const FISSURE_KEEP = 1.05;

/**
 * Whether a normalised point lies inside the silhouette — inside one
 * hemisphere's rim and clear of the fissure.
 *
 * `margin` scales the rim: 0.93 asks for a point comfortably inside, 1 for the
 * outline itself. This is the test the cells are sampled with, and the one
 * decoration clips against (through `BrainLayout.inside`, in world units).
 */
export function withinOutline(x: number, y: number, margin = 1): boolean {
  return Math.abs(x) > FISSURE * FISSURE_KEEP && reach(sideOf(x), x, y) < margin;
}

/**
 * How far a normalised point lies inside the silhouette: positive inside,
 * negative outside, zero on the edge.
 *
 * The radial distance to the rim, and the distance to the fissure, whichever is
 * smaller. Radial rather than truly perpendicular — for a star-shaped outline
 * the two agree except where the rim turns sharply, and this is a fade, not a
 * measurement.
 */
export function outlineDepth(x: number, y: number): number {
  const side = sideOf(x);
  const h = HEMISPHERES[side];
  const dx = x - h.cx;
  const dy = y - h.cy;
  const edge = rim(side, Math.atan2(dy, dx * side));
  return Math.min(edge - Math.hypot(dx, dy), Math.abs(x) - FISSURE * FISSURE_KEEP);
}
