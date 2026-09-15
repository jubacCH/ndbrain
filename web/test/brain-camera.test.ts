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
  FIT_MAX_SCALE,
  IDENTITY,
  between,
  ease,
  fit,
  limitsFor,
  panBy,
  toScreen,
  toWorld,
  zoomAt,
} from '../src/brain/camera';

const LIMITS = { min: 0.4, max: 8 };
const NO_INSET = { top: 0, right: 0, bottom: 0, left: 0 };

const CAMERAS = [
  IDENTITY,
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

  it('maps one to one at the identity', () => {
    expect(toScreen(IDENTITY, 123, 456)).toEqual({ x: 123, y: 456 });
  });
});

describe('the resting view', () => {
  // A brain-sized world centred on the origin, as the layout builds it.
  const brain = { minX: -480, minY: -350, maxX: 470, maxY: 400 };

  it('puts the whole world on screen, centred in the room the insets leave', () => {
    const inset = { top: 20, right: 20, bottom: 56, left: 20 };
    const cam = fit(brain, 900, 700, inset);
    const topLeft = toScreen(cam, brain.minX, brain.minY);
    const bottomRight = toScreen(cam, brain.maxX, brain.maxY);
    expect(topLeft.x).toBeGreaterThanOrEqual(inset.left - 1e-9);
    expect(topLeft.y).toBeGreaterThanOrEqual(inset.top - 1e-9);
    expect(bottomRight.x).toBeLessThanOrEqual(900 - inset.right + 1e-9);
    expect(bottomRight.y).toBeLessThanOrEqual(700 - inset.bottom + 1e-9);
    // Centred in the free room, and touching it on the tighter axis.
    expect((topLeft.x + bottomRight.x) / 2).toBeCloseTo((inset.left + 900 - inset.right) / 2, 9);
    expect((topLeft.y + bottomRight.y) / 2).toBeCloseTo((inset.top + 700 - inset.bottom) / 2, 9);
    expect(Math.min(topLeft.x - inset.left, topLeft.y - inset.top)).toBeCloseTo(0, 9);
  });

  it('changes only the mapping when the window changes: the same world point stays the middle', () => {
    // The whole point of an own world. The layout never hears about the window;
    // resizing moves and scales the camera, so the brain is the same brain,
    // seen smaller.
    const wide = fit(brain, 1400, 900, NO_INSET);
    const narrow = fit(brain, 600, 900, NO_INSET);
    expect(narrow.scale).toBeLessThan(wide.scale);
    const centre = { x: (brain.minX + brain.maxX) / 2, y: (brain.minY + brain.maxY) / 2 };
    expect(toScreen(wide, centre.x, centre.y).x).toBeCloseTo(700, 9);
    expect(toScreen(narrow, centre.x, centre.y).x).toBeCloseTo(300, 9);
  });

  it('never magnifies a small world beyond the design scale', () => {
    const tiny = { minX: -40, minY: -40, maxX: 40, maxY: 40 };
    expect(fit(tiny, 1200, 800, NO_INSET).scale).toBe(FIT_MAX_SCALE);
  });

  it('survives a canvas with no size yet', () => {
    const cam = fit(brain, 0, 0, NO_INSET);
    expect(Number.isFinite(cam.scale) && cam.scale > 0).toBe(true);
    expect(Number.isFinite(cam.x) && Number.isFinite(cam.y)).toBe(true);
  });

  it('lets the wheel go out to 40 % of the fitted view and in to eight times the design scale', () => {
    const home = fit(brain, 500, 400, NO_INSET);
    expect(limitsFor(home)).toEqual({ min: home.scale * 0.4, max: 8 });
  });
});

describe('zoom', () => {
  it('keeps the point under the pointer under the pointer', () => {
    for (const cam of CAMERAS) {
      for (const factor of [1.2, 0.8, 3]) {
        const anchor = { x: 410, y: 275 };
        const before = toWorld(cam, anchor.x, anchor.y);
        const after = zoomAt(cam, anchor.x, anchor.y, factor, LIMITS);
        const moved = toScreen(after, before.x, before.y);
        expect(moved.x).toBeCloseTo(anchor.x, 6);
        expect(moved.y).toBeCloseTo(anchor.y, 6);
      }
    }
  });

  it('is not the same as zooming on the middle of the canvas', () => {
    const onPointer = zoomAt(IDENTITY, 100, 100, 2, LIMITS);
    const onCentre = zoomAt(IDENTITY, 500, 300, 2, LIMITS);
    expect(onPointer).not.toEqual(onCentre);
  });

  it('stops at the limits instead of running away', () => {
    let out = IDENTITY;
    for (let i = 0; i < 200; i += 1) out = zoomAt(out, 300, 200, 0.8, LIMITS);
    expect(out.scale).toBe(LIMITS.min);

    let far = IDENTITY;
    for (let i = 0; i < 200; i += 1) far = zoomAt(far, 300, 200, 1.25, LIMITS);
    expect(far.scale).toBe(LIMITS.max);
  });

  it('holds the anchor even when the limit is what stopped it', () => {
    const at = { scale: LIMITS.max, x: -50, y: -20 };
    expect(zoomAt(at, 200, 150, 4, LIMITS)).toBe(at);
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
