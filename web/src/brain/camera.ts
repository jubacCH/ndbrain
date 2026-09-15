/**
 * The camera: one transform, both directions.
 *
 * Before this existed there was no camera at all — the simulation ran in canvas
 * pixels and the hit test compared pointer pixels against them, which worked
 * only because the two were the same number. Zoom breaks that the moment it
 * exists, and the failure mode is quiet: the picture moves and the clicks stay
 * where they were.
 *
 * So there is exactly one place that converts, and everything goes through it —
 * drawing, hit testing, dragging, the pan itself. `toWorld(toScreen(p))` has to
 * return `p`, and a test says so.
 *
 * No rotation and a single scale: `screen = world * scale + offset`. A full 2×3
 * matrix would buy skew and rotation that nothing here wants, and would make the
 * inverse a thing that can be got wrong.
 */

export interface Camera {
  scale: number;
  /** Screen position, in CSS pixels, of the world origin. */
  x: number;
  y: number;
}

/**
 * The view the graph was laid out for.
 *
 * Not an arbitrary starting point: the simulation is bounded by a rectangle the
 * size of the viewport, so at scale 1 with no offset the entire graph is on
 * screen by construction. That makes "reset" mean "return to identity", with no
 * bounding box to measure, and it makes the first frame after this rewrite the
 * same picture as the last frame before it.
 */
export const HOME: Camera = { scale: 1, x: 0, y: 0 };

/**
 * How far out and in the wheel may go.
 *
 * Below 1 there is nothing new to see — the world ends at the viewport — but a
 * little margin helps when a node has been dragged to the rim, so the floor sits
 * just under it rather than at it.
 */
export const MIN_SCALE = 0.4;
export const MAX_SCALE = 8;

export function toScreen(cam: Camera, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * cam.scale + cam.x, y: wy * cam.scale + cam.y };
}

export function toWorld(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - cam.x) / cam.scale, y: (sy - cam.y) / cam.scale };
}

/** True when the camera is where it started, give or take a rounding error. */
export function isHome(cam: Camera): boolean {
  return Math.abs(cam.scale - 1) < 1e-4 && Math.abs(cam.x) < 0.5 && Math.abs(cam.y) < 0.5;
}

/**
 * Zooms about a point on screen.
 *
 * Anchoring on the pointer rather than on the middle of the canvas is the whole
 * difference between a zoom that feels like moving closer and one that feels
 * like the picture sliding away: whatever is under the cursor has to stay under
 * the cursor. Which is the entire rule — find the world point below the pointer,
 * change the scale, then move the camera so that point lands on the same pixel.
 */
export function zoomAt(cam: Camera, sx: number, sy: number, factor: number): Camera {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cam.scale * factor));
  if (scale === cam.scale) return cam;
  const before = toWorld(cam, sx, sy);
  return { scale, x: sx - before.x * scale, y: sy - before.y * scale };
}

export function panBy(cam: Camera, dx: number, dy: number): Camera {
  return { scale: cam.scale, x: cam.x + dx, y: cam.y + dy };
}

/**
 * A step of the way from one camera to another.
 *
 * The scale is interpolated geometrically, the offset linearly. Halfway between
 * 1× and 4× is 2×, not 2.5× — a zoom that moved linearly would crawl at the
 * near end and lurch at the far one, which is exactly the "wild movement" the
 * design direction rules out.
 */
export function between(from: Camera, to: Camera, t: number): Camera {
  const k = Math.min(1, Math.max(0, t));
  return {
    scale: from.scale * Math.pow(to.scale / from.scale, k),
    x: from.x + (to.x - from.x) * k,
    y: from.y + (to.y - from.y) * k,
  };
}

/** Smoothstep: no jolt at either end of a transition. */
export function ease(t: number): number {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
}
