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
 * One world unit to one CSS pixel, world origin at the canvas's top-left.
 *
 * No longer where the view starts — the world has its own size now, and the
 * resting view is computed by `fit` — but still the neutral camera for a
 * canvas that has not been measured yet.
 */
export const IDENTITY: Camera = { scale: 1, x: 0, y: 0 };

/** A world rectangle. */
export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Screen space to keep free around the fitted world, for controls laid over the canvas. */
export interface Inset {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * The resting view never magnifies beyond one world unit per pixel.
 *
 * The world's lengths were chosen for that scale: cell bodies, tract widths and
 * label sizes are the ones the design direction settled on. A small vault in a
 * large window is shown at its natural size in the middle, not blown up until
 * six notes fill a monitor.
 */
export const FIT_MAX_SCALE = 1;

/**
 * The resting view: the whole of `box`, centred in the viewport.
 *
 * The world used to be the viewport, which made the resting view the identity
 * and let the simulation know where the legend and the footer were. Now the
 * brain has its own size, fixed by the vault, and "the view that holds
 * everything" is computed here. This is also where the one piece of screen
 * knowledge that used to leak into the simulation lives now: the room the
 * controls over the canvas take up. It is an inset on the screen, which is
 * what it always was.
 */
export function fit(box: Box, width: number, height: number, inset: Inset): Camera {
  const w = Math.max(1, box.maxX - box.minX);
  const h = Math.max(1, box.maxY - box.minY);
  const roomW = Math.max(1, width - inset.left - inset.right);
  const roomH = Math.max(1, height - inset.top - inset.bottom);
  const scale = Math.min(FIT_MAX_SCALE, roomW / w, roomH / h);
  return {
    scale,
    x: inset.left + roomW / 2 - (box.minX + w / 2) * scale,
    y: inset.top + roomH / 2 - (box.minY + h / 2) * scale,
  };
}

/** How far the wheel may zoom out and in. */
export interface ZoomLimits {
  min: number;
  max: number;
}

/**
 * The limits for a resting view.
 *
 * Out: to 40 % of the fitted size, which leaves a little margin when a node has
 * been dragged to the rim, and nothing more to see beyond it. In: to eight times
 * the design scale, absolute rather than relative, because what runs out when
 * zooming in is detail, and detail is drawn in world units.
 */
export function limitsFor(home: Camera): ZoomLimits {
  return { min: home.scale * 0.4, max: Math.max(8, home.scale * 8) };
}

export function toScreen(cam: Camera, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * cam.scale + cam.x, y: wy * cam.scale + cam.y };
}

export function toWorld(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - cam.x) / cam.scale, y: (sy - cam.y) / cam.scale };
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
export function zoomAt(cam: Camera, sx: number, sy: number, factor: number, limits: ZoomLimits): Camera {
  const scale = Math.min(limits.max, Math.max(limits.min, cam.scale * factor));
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
