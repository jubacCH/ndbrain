/**
 * What a click and a drag do to the brain.
 *
 * The spatial memory this view is for can be destroyed without anybody meaning
 * to: a layout that warms up on every press moves the whole brain a little each
 * time, the movement is stored, and five clicks later the notes are somewhere
 * else. So these tests go through the component, with pointer events, and read
 * the result where it would do the damage — the stored positions.
 *
 * Two promises:
 *
 *  - **A click moves nothing.** Not the note clicked, not anything else, not
 *    after five clicks, not after a double click.
 *  - **A drag moves the note to where it was dropped, and only its neighbours
 *    make room.** Every other note stays exactly where it was, however often
 *    notes are dragged.
 *
 * Positions are compared with `toBe`: a tolerance is exactly what would hide a
 * small drift that adds up.
 */

import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Brain } from '../src/Brain';
import type { Camera } from '../src/brain/camera';
import { fit, toScreen, toWorld } from '../src/brain/camera';
import { BrainLayout } from '../src/brain/layout';
import { buildGraph } from '../src/brain/model';
import type { Place } from '../src/brain/layout';
import { loadPositions } from '../src/brain/positions';
import { paraVault } from './fixtures/para-vault';

const W = 1200;
const H = 800;
const INSET = { top: 0, right: 0, bottom: 0, left: 0 };
const remember = { account: 'jb', store: 'network' };
const { data } = paraVault();
const graph = buildGraph(data);

/** The resting camera the component will use: it depends only on the data and the canvas. */
const home: Camera = fit(new BrainLayout(graph, { arrangement: 'brain' }).bounds, W, H, INSET);

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ x: 0, y: 0, top: 0, left: 0, right: W, bottom: H, width: W, height: H, toJSON: () => ({}) }) as DOMRect,
  );
  // jsdom has no pointer capture.
  Object.defineProperty(HTMLCanvasElement.prototype, 'setPointerCapture', { value: () => {}, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function run(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Mounts the network, lets it run, and returns the canvas and a way to unmount. */
async function mount(): Promise<{ canvas: HTMLCanvasElement; unmount: () => void }> {
  const view = render(
    <Brain data={data} events={[]} onOpen={vi.fn()} view="network" arrangement="brain" remember={remember} inset={INSET} />,
  );
  await run(200);
  return { canvas: view.container.querySelector('canvas')!, unmount: view.unmount };
}

/** A first visit: lays the brain out and stores it. */
async function firstVisit(): Promise<Map<string, Place>> {
  const { unmount } = await mount();
  unmount();
  return loadPositions(remember);
}

const at = (positions: Map<string, Place>, key: string): { x: number; y: number } => {
  const p = positions.get(key)!;
  return toScreen(home, p.x, p.y);
};

/** Keys of the notes linked to `key`. */
function neighbours(key: string): Set<string> {
  const i = graph.index.get(key)!;
  return new Set(
    graph.touching[i]!.map((e) => {
      const edge = graph.edges[e]!;
      return graph.nodes[edge.a === i ? edge.b : edge.a]!.key;
    }),
  );
}

/** Notes spread over the brain, each clearly apart from its neighbours on screen. */
const targets = [3, 20, 47, 71, 96].map((i) => graph.nodes[i]!.key);

describe('a click', () => {
  it('moves nothing, five times over, double clicks included', async () => {
    const before = await firstVisit();
    const { canvas, unmount } = await mount();

    for (const key of targets) {
      const p = at(before, key);
      fireEvent.pointerDown(canvas, { clientX: p.x, clientY: p.y, pointerId: 1 });
      fireEvent.pointerUp(window, { clientX: p.x, clientY: p.y, pointerId: 1 });
      await run(600);
    }
    // A double click is two presses and a dblclick.
    const p = at(before, targets[0]!);
    for (let k = 0; k < 2; k += 1) {
      fireEvent.pointerDown(canvas, { clientX: p.x, clientY: p.y, pointerId: 1 });
      fireEvent.pointerUp(window, { clientX: p.x, clientY: p.y, pointerId: 1 });
    }
    fireEvent.doubleClick(canvas, { clientX: p.x, clientY: p.y });
    await run(3000);
    unmount();

    const after = loadPositions(remember);
    expect(after.size).toBe(before.size);
    for (const [key, was] of before) {
      expect(after.get(key)!.x, key).toBe(was.x);
      expect(after.get(key)!.y, key).toBe(was.y);
    }
  });

  it('ignores a pointer that trembles by a pixel or two', async () => {
    const before = await firstVisit();
    const { canvas, unmount } = await mount();
    const p = at(before, targets[1]!);
    fireEvent.pointerDown(canvas, { clientX: p.x, clientY: p.y, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: p.x + 2, clientY: p.y - 1, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: p.x + 2, clientY: p.y - 1, pointerId: 1 });
    await run(3000);
    unmount();
    const after = loadPositions(remember);
    for (const [key, was] of before) expect(after.get(key)!.x, key).toBe(was.x);
  });
});

describe('a drag', () => {
  it('leaves the note where it was dropped and every note but its neighbours exactly where it was, five times over', async () => {
    const original = await firstVisit();
    let before = original;
    const untouched = new Set(original.keys());

    for (const [round, key] of targets.entries()) {
      const { canvas, unmount } = await mount();
      const from = at(before, key);
      const to = { x: from.x + 70, y: from.y - 40 };
      fireEvent.pointerDown(canvas, { clientX: from.x, clientY: from.y, pointerId: 1 });
      for (let k = 1; k <= 10; k += 1) {
        fireEvent.pointerMove(canvas, {
          clientX: from.x + ((to.x - from.x) * k) / 10,
          clientY: from.y + ((to.y - from.y) * k) / 10,
          pointerId: 1,
        });
      }
      fireEvent.pointerUp(window, { clientX: to.x, clientY: to.y, pointerId: 1 });
      await run(8000);
      unmount();

      const after = loadPositions(remember);
      const dropped = toWorld(home, to.x, to.y);
      expect(after.get(key)!.x, `round ${round}: dropped x`).toBeCloseTo(dropped.x, 0);
      expect(after.get(key)!.y, `round ${round}: dropped y`).toBeCloseTo(dropped.y, 0);

      untouched.delete(key);
      for (const n of neighbours(key)) untouched.delete(n);
      // Every note never dragged and never next to a dragged note is where the
      // first visit put it — so nothing adds up across rounds.
      for (const other of untouched) {
        expect(after.get(other)!.x, `round ${round}: ${other}`).toBe(original.get(other)!.x);
        expect(after.get(other)!.y, `round ${round}: ${other}`).toBe(original.get(other)!.y);
      }
      before = after;
    }
    expect(untouched.size).toBeGreaterThan(60);
  });
});
