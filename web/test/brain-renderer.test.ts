/**
 * The canvas renderer obeys the opacity the scene hands it.
 *
 * Against a recording stand-in for the 2D context: what is checked is which
 * tracts are filled, and at which `globalAlpha`. A held-back link must still
 * be painted — faintly, not skipped — and a loud one must not be painted at
 * the same strength as a quiet one.
 */

import { describe, expect, it } from 'vitest';

import { createCanvasRenderer } from '../src/brain/renderer';
import type { Scene, SceneEdge } from '../src/brain/scene';

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

const edge = (alpha: number, y: number): SceneEdge => ({
  ax: 10,
  ay: y,
  bx: 200,
  by: y,
  cx: 105,
  cy: y + 10,
  aw: 1.5,
  bw: 1.5,
  mw: 0.5,
  alpha,
});

const sceneWith = (edges: SceneEdge[]): Scene => ({
  nodes: [],
  order: [],
  edges,
  sparks: [],
  labels: [],
  camera: { scale: 1, x: 0, y: 0 },
  width: 400,
  height: 300,
});

describe('the canvas renderer', () => {
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
