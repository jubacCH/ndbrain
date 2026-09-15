/**
 * The camera.
 *
 * One property carries most of the weight: screen → world → screen has to
 * return what went in. Everything that can go wrong in this view once zoom
 * exists goes wrong quietly — the picture moves and the clicks stay behind —
 * and a broken round trip is what that failure looks like in the small.
 *
 * The second property is the one that decides whether the zoom feels right:
 * whatever is under the pointer must still be under the pointer afterwards.
 */

import { describe, expect, it } from 'vitest';

import {
  HOME,
  MAX_SCALE,
  MIN_SCALE,
  between,
  ease,
  isHome,
  panBy,
  toScreen,
  toWorld,
  zoomAt,
} from '../src/brain/camera';

const CAMERAS = [
  HOME,
  { scale: 2.5, x: -120, y: 64 },
  { scale: 0.4, x: 800, y: -300 },
  { scale: 7.25, x: 13.5, y: -0.25 },
];

describe('screen and world', () => {
  it('comes back to where it started, at every zoom and offset', () => {
    for (const cam of CAMERAS) {
      for (const [sx, sy] of [
        [0, 0],
        [640, 360],
        [-17.5, 1023.25],
      ]) {
        const world = toWorld(cam, sx!, sy!);
        const back = toScreen(cam, world.x, world.y);
        expect(back.x).toBeCloseTo(sx!, 9);
        expect(back.y).toBeCloseTo(sy!, 9);
      }
    }
  });

  it('starts as a plain one-to-one mapping, so the first frame is the old picture', () => {
    expect(toScreen(HOME, 123, 456)).toEqual({ x: 123, y: 456 });
    expect(isHome(HOME)).toBe(true);
  });
});

describe('zoom', () => {
  it('keeps the point under the pointer under the pointer', () => {
    for (const cam of CAMERAS) {
      for (const factor of [1.2, 0.8, 3]) {
        const anchor = { x: 410, y: 275 };
        const before = toWorld(cam, anchor.x, anchor.y);
        const after = zoomAt(cam, anchor.x, anchor.y, factor);
        const moved = toScreen(after, before.x, before.y);
        expect(moved.x).toBeCloseTo(anchor.x, 6);
        expect(moved.y).toBeCloseTo(anchor.y, 6);
      }
    }
  });

  it('is not the same as zooming on the middle of the canvas', () => {
    const onPointer = zoomAt(HOME, 100, 100, 2);
    const onCentre = zoomAt(HOME, 500, 300, 2);
    expect(onPointer).not.toEqual(onCentre);
  });

  it('stops at the limits instead of running away', () => {
    let out = HOME;
    for (let i = 0; i < 200; i += 1) out = zoomAt(out, 300, 200, 0.8);
    expect(out.scale).toBe(MIN_SCALE);

    let far = HOME;
    for (let i = 0; i < 200; i += 1) far = zoomAt(far, 300, 200, 1.25);
    expect(far.scale).toBe(MAX_SCALE);
  });

  it('holds the anchor even when the limit is what stopped it', () => {
    const at = { scale: MAX_SCALE, x: -50, y: -20 };
    expect(zoomAt(at, 200, 150, 4)).toBe(at);
  });
});

describe('pan', () => {
  it('moves the picture by exactly the pointer movement, at any zoom', () => {
    for (const cam of CAMERAS) {
      const before = toScreen(cam, 40, 90);
      const after = toScreen(panBy(cam, 25, -12), 40, 90);
      expect(after.x - before.x).toBeCloseTo(25, 9);
      expect(after.y - before.y).toBeCloseTo(-12, 9);
    }
  });

  it('does not change the zoom', () => {
    expect(panBy({ scale: 3, x: 0, y: 0 }, 10, 10).scale).toBe(3);
  });
});

describe('transitions', () => {
  it('halves the zoom geometrically, so the middle of the move is the middle of it', () => {
    const mid = between({ scale: 1, x: 0, y: 0 }, { scale: 4, x: 100, y: 0 }, 0.5);
    expect(mid.scale).toBeCloseTo(2, 9);
    expect(mid.x).toBeCloseTo(50, 9);
  });

  it('arrives exactly, and does not overshoot when a frame comes late', () => {
    const to = { scale: 1, x: 0, y: 0 };
    expect(between({ scale: 4, x: 200, y: 80 }, to, 1)).toEqual(to);
    expect(between({ scale: 4, x: 200, y: 80 }, to, 2.7)).toEqual(to);
  });

  it('eases in and out rather than starting at full speed', () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.5, 9);
    expect(ease(0.1)).toBeLessThan(0.1);
    expect(ease(0.9)).toBeGreaterThan(0.9);
  });
});

describe('finding the way back', () => {
  it('counts a camera as home only once both the zoom and the offset are back', () => {
    expect(isHome({ scale: 1, x: 0, y: 0 })).toBe(true);
    expect(isHome({ scale: 1, x: 40, y: 0 })).toBe(false);
    expect(isHome({ scale: 1.6, x: 0, y: 0 })).toBe(false);
    // A gesture leaves rounding behind; a control that stays on screen because
    // the camera is a hundredth of a pixel off would never go away.
    expect(isHome({ scale: 1.00001, x: 0.2, y: -0.1 })).toBe(true);
  });
});
