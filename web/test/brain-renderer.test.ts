/**
 * The canvas renderer obeys the opacity the scene hands it.
 *
 * Against a recording stand-in for the 2D context: what is checked is which
 * tracts are filled, and at which `globalAlpha`. A held-back link must still
 * be painted — faintly, not skipped — and a loud one must not be painted at
 * the same strength as a quiet one.
 */

import { describe, expect, it, vi } from 'vitest';

import { NO_DECORATION } from '../src/brain/deco';
import { placeRegionNames } from '../src/brain/labels';
import type { RegionAnchor } from '../src/brain/regions';
import { createCanvasRenderer } from '../src/brain/renderer';
import type { Scene, SceneEdge } from '../src/brain/scene';
import { TISSUE } from '../src/brain/scene';

// Counted, not run: what is under test is how often the renderer asks for a
// placement, and the placement itself has its own tests (`brain-labels`).
vi.mock('../src/brain/labels', async (original) => ({
  ...(await original<typeof import('../src/brain/labels')>()),
  placeRegionNames: vi.fn(() => []),
}));

interface Fill {
  alpha: number;
  style: unknown;
  composite: string;
}

function recorder(): { canvas: HTMLCanvasElement; fills: Fill[]; alpha: () => number } {
  const fills: Fill[] = [];
  const gradient = { addColorStop: () => {} };
  const ctx = {
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '' as unknown,
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'start',
    lineJoin: 'miter',
    stack: [] as Array<{ alpha: number; composite: string }>,
    setTransform: () => {},
    fillRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    arc: () => {},
    strokeText: () => {},
    fillText: () => {},
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
    quadraticCurveTo: () => {},
    stroke: () => {},
    measureText: (text: string) => ({ width: text.length * 6 }),
    save(): void {
      this.stack.push({ alpha: this.globalAlpha, composite: this.globalCompositeOperation });
    },
    restore(): void {
      const top = this.stack.pop();
      if (top) {
        this.globalAlpha = top.alpha;
        this.globalCompositeOperation = top.composite;
      }
    },
    fill(): void {
      fills.push({ alpha: this.globalAlpha, style: this.fillStyle, composite: this.globalCompositeOperation });
    },
  };
  const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  return { canvas, fills, alpha: () => ctx.globalAlpha };
}

/** A straight tract from (10, y) to (200, y), sampled the way the scene samples one. */
const edge = (alpha: number, y: number): SceneEdge => {
  const n = 8;
  const pts = new Float64Array(n * 2);
  for (let i = 0; i < n; i += 1) {
    pts[i * 2] = 10 + (190 * i) / (n - 1);
    pts[i * 2 + 1] = y;
  }
  return {
    pts,
    n,
    ax: 10,
    ay: y,
    bx: 200,
    by: y,
    w0: 1.5,
    w1: 0.5,
    alpha,
    tail: alpha * 0.32,
    restAlpha: alpha,
    restTail: alpha * 0.32,
    colour: TISSUE,
    depth: 1,
    strands: false,
    radiant: 0,
    warm: 0,
    warmColour: [0, 0, 0],
  };
};

const sceneWith = (edges: SceneEdge[]): Scene => ({
  nodes: [],
  order: [],
  edges,
  forks: [],
  sparks: [],
  labels: [],
  regions: [],
  blocked: [],
  inside: () => false,
  depthInside: () => -1,
  brainWidth: 1,
  regionAlpha: 0,
  deco: NO_DECORATION,
  decoAlpha: 0,
  camera: { scale: 1, x: 0, y: 0 },
  zoom: 1,
  width: 400,
  height: 300,
  parallaxX: 0,
  parallaxY: 0,
  hovered: -1,
  pickedRegion: -1,
  stamp: 1,
});

describe('the canvas renderer', () => {
  it('paints a link at rest into the layer, and what a spark adds over it, live', () => {
    const { canvas, fills } = recorder();
    const paint = createCanvasRenderer(canvas);
    paint.resize(400, 300);
    // A held-back link with a spark on it: resting at a ghost, lit to 0.5.
    const lit = { ...edge(0.012, 20), alpha: 0.5, tail: 0.16 };
    paint.draw(sceneWith([lit]));
    // Two fills: the resting link, then the spark's share on top. Never the lit
    // value in the layer, which would outlive the spark.
    expect(fills.map((f) => f.alpha)).toEqual([0.012, 0.5 - 0.012]);
  });

  it('fills each tract at the opacity the scene gave it, ghosts included', () => {
    const { canvas, fills, alpha } = recorder();
    const paint = createCanvasRenderer(canvas);
    paint.resize(400, 300);
    // A quiet link inside a cluster, a held-back ghost below the line
    // threshold, a focused link, and one with nothing to draw.
    paint.draw(sceneWith([edge(0.16, 20), edge(0.012, 60), edge(0.6, 100), edge(0, 140)]));

    // The background is a fillRect; every path fill here is a tract.
    expect(fills.map((f) => f.alpha)).toEqual([0.16, 0.012, 0.6]);
    // The opacity does not leak into what is drawn after the tracts.
    expect(alpha()).toBe(1);
  });
});

describe('the region names', () => {
  /** A scene with names to place; what the anchors say does not matter to a counted placement. */
  const named = (): Scene => ({
    ...sceneWith([]),
    regions: [{ region: 0, text: 'Homelab' } as unknown as RegionAnchor],
    regionAlpha: 1,
    blocked: [{ x: 10, y: 250, w: 120, h: 40 }],
  });

  it('are placed once per stand, not once per frame', () => {
    const place = vi.mocked(placeRegionNames);
    place.mockClear();
    const { canvas } = recorder();
    const paint = createCanvasRenderer(canvas);
    paint.resize(400, 300);
    const scene = named();

    // Two frames of the same stand — a pulse running over a settled brain.
    // The font stack is read on resize, not per frame.
    const style = vi.spyOn(window, 'getComputedStyle');
    paint.draw(scene);
    paint.draw(scene);
    expect(place).toHaveBeenCalledTimes(1);
    expect(style).not.toHaveBeenCalled();
    style.mockRestore();

    // Each input of the placement, changed on its own, places again.
    const changes: Array<[string, (s: Scene) => void]> = [
      ['camera scale', (s) => (s.camera = { ...s.camera, scale: 1.1 })],
      ['camera x', (s) => (s.camera = { ...s.camera, x: 5 })],
      ['camera y', (s) => (s.camera = { ...s.camera, y: -5 })],
      ['width', (s) => (s.width = 420)],
      ['height', (s) => (s.height = 310)],
      ['stamp', (s) => (s.stamp += 1)],
      ['blocked areas', (s) => (s.blocked = [{ x: 10, y: 240, w: 120, h: 50 }])],
      ['anchors', (s) => (s.regions = [...s.regions])],
    ];
    for (const [what, change] of changes) {
      const calls = place.mock.calls.length;
      change(scene);
      paint.draw(scene);
      expect(place.mock.calls.length, `after a change of ${what}`).toBe(calls + 1);
      paint.draw(scene);
      expect(place.mock.calls.length, `a second frame after a change of ${what}`).toBe(calls + 1);
    }
  });
});
