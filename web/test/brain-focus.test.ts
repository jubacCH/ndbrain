/**
 * Where the camera goes for a focused note.
 */

import { describe, expect, it } from 'vitest';

import { fit, toScreen } from '../src/brain/camera';
import { FOCUS_MAX_ZOOM, focusCamera } from '../src/brain/focus';

const bounds = { minX: 0, minY: 0, maxX: 1600, maxY: 1200 };
const W = 1400;
const H = 900;
const NONE = { top: 64, right: 20, bottom: 64, left: 20 };

describe('focusCamera', () => {
  it('keeps the note and every neighbour inside the room left by a reserved strip', () => {
    const x = [800, 300, 1300, 820];
    const y = [600, 250, 900, 640];
    const r = [12, 6, 6, 4];
    const inset = { ...NONE, right: 380 };
    const cam = focusCamera({ x, y, r, members: [0, 1, 2, 3], bounds, width: W, height: H, inset });
    for (let i = 0; i < 4; i += 1) {
      const p = toScreen(cam, x[i]!, y[i]!);
      expect(p.x, `x ${i}`).toBeGreaterThanOrEqual(inset.left);
      expect(p.x, `x ${i}`).toBeLessThanOrEqual(W - inset.right);
      expect(p.y, `y ${i}`).toBeGreaterThanOrEqual(inset.top);
      expect(p.y, `y ${i}`).toBeLessThanOrEqual(H - inset.bottom);
    }
  });

  it('comes closer for a close neighbourhood, but no closer than the cap', () => {
    const home = fit(bounds, W, H, NONE);
    const cam = focusCamera({ x: [800, 810], y: [600, 605], r: [4, 4], members: [0, 1], bounds, width: W, height: H, inset: NONE });
    expect(cam.scale).toBeGreaterThan(home.scale);
    expect(cam.scale).toBeLessThanOrEqual(home.scale * FOCUS_MAX_ZOOM + 1e-9);
    // Centred on the pair.
    const p = toScreen(cam, 805, 602.5);
    expect(p.x).toBeCloseTo(NONE.left + (W - NONE.left - NONE.right) / 2, 5);
    expect(p.y).toBeCloseTo(NONE.top + (H - NONE.top - NONE.bottom) / 2, 5);
  });

  it('frames a note linked across the whole brain no further out than the zoom limit', () => {
    const home = fit(bounds, W, H, NONE);
    const cam = focusCamera({
      x: [-4000, 5000],
      y: [-4000, 5000],
      r: [4, 4],
      members: [0, 1],
      bounds,
      width: W,
      height: H,
      inset: NONE,
    });
    expect(cam.scale).toBeGreaterThanOrEqual(home.scale * 0.4 - 1e-9);
  });
});
