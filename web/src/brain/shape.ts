/**
 * The outline the brain grows into.
 *
 * Not a mask and not a picture. Nothing here places a node, and nothing is ever
 * drawn from it: it is the boundary of a soft force (`layout.ts`) that nudges a
 * node back when it strays past its hemisphere's edge. The nodes fill the
 * outline because their regions are laid out inside it and repel each other
 * outwards until they reach it — so the silhouette is made of clusters pressing
 * against a wall, the way a real cortex is folded tissue inside a skull, rather
 * than of dots scattered evenly over a shape (briefing 9, 12, 52).
 *
 * Seen from above: two hemispheres side by side, the longitudinal fissure
 * between them running top to bottom. Each hemisphere is a star-shaped outline
 * around its own centre — rounder on the outer side, flatter where it faces the
 * other one, a little narrower at the front — with two slow ripples on the rim,
 * and the two differ slightly in size, height and ripple. A perfectly mirrored
 * pair of ellipses reads as a diagram; this should read as something grown.
 *
 * Landscape rather than anatomical. A real brain seen from above is longer than
 * it is wide, but this view lives in a wide window, and an upright brain would
 * fill a third of it. Squashed to about 1.3 : 1 it still has everything that
 * makes the shape recognisable — two halves, the fissure, the rounded outer
 * edge — and uses the screen.
 *
 * Normalised coordinates here: the brain spans about −1…1 across. The layout
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
  /** Phase of the two rim ripples, different per side. */
  phase2: number;
  phase3: number;
}

/**
 * The two halves.
 *
 * The left one is two percent larger and sits a touch higher; the ripples are
 * out of phase. Small enough that nobody sees a lopsided brain, large enough that
 * nobody sees a mirror.
 */
const HEMISPHERES: Record<Side, Hemisphere> = {
  [-1]: { cx: -0.63, cy: -0.012, rx: 0.45, ry: 0.75, scale: 1.02, phase2: 0.4, phase3: 1.1 },
  [1]: { cx: 0.63, cy: 0.01, rx: 0.455, ry: 0.74, scale: 1, phase2: 2.2, phase3: 4.0 },
};

/** How much flatter the inner side is than the outer: a superellipse exponent. */
const MEDIAL_FLATNESS = 2.4;
/** How much narrower the front (top) is than the back. */
const FRONT_TAPER = 0.07;
/** Amplitude of the two rim ripples. */
const RIPPLE2 = 0.03;
const RIPPLE3 = 0.022;

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
  // Outer half an ellipse, inner half a superellipse: round away from the
  // fissure, flat along it. Both give `ry` at ±π/2, so the seam is smooth.
  const p = c < 0 ? MEDIAL_FLATNESS : 2;
  const base = Math.pow(Math.pow(Math.abs(c) / h.rx, p) + Math.pow(Math.abs(s) / h.ry, p), -1 / p);
  const taper = 1 + FRONT_TAPER * s;
  const ripple = 1 + RIPPLE2 * Math.cos(2 * phi + h.phase2) + RIPPLE3 * Math.sin(3 * phi + h.phase3);
  return base * taper * ripple * h.scale;
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
 * normalised. The fissure test and the simulation both use it.
 */
export const FISSURE = OUTLINE.medial;
