/**
 * What a click and a drag do to the brain.
 *
 * The spatial memory this view is for can be destroyed without anybody meaning
 * to: a layout that warms up on every press moves the whole brain a little each
 * time, the movement is stored, and five clicks later the notes are somewhere
 * else. So these tests go through the component, with pointer events, and read
 * the result where it would do the damage — the stored positions.
 *
 * Three promises:
 *
 *  - **A click moves nothing.** Not the note clicked, not anything else, not
 *    after five clicks, not after a double click.
 *  - **A drag moves the note to where it was dropped, and only its neighbours
 *    make room.** Every other note stays exactly where it was, however often
 *    notes are dragged.
 *  - **A click on the dark lets go of the selection**, as does Escape; a pan
 *    does not. The selection is read from what each frame is built with.
 *
 * Positions are compared with `toBe`: a tolerance is exactly what would hide a
 * small drift that adds up.
 */

import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PulseEvent } from '../src/api';
import { Brain } from '../src/Brain';
import type { Activity } from '../src/brain/activity';
import type { Camera } from '../src/brain/camera';
import { fit, toScreen, toWorld } from '../src/brain/camera';
import { BrainLayout } from '../src/brain/layout';
import { buildGraph } from '../src/brain/model';
import type { Place } from '../src/brain/layout';
import { loadPositions } from '../src/brain/positions';
import { SceneBuilder } from '../src/brain/scene';
import { paraVault } from './fixtures/para-vault';

const W = 1200;
const H = 800;
const INSET = { top: 0, right: 0, bottom: 0, left: 0 };
const remember = { account: 'jb', store: 'network' };
const { data } = paraVault();
const graph = buildGraph(data);

/** The resting camera the component will use: it depends only on the data and the canvas. */
const home: Camera = fit(new BrainLayout(graph, { arrangement: 'brain' }).bounds, W, H, INSET);

/**
 * The frames the component has asked for: how many in total, and which are
 * still queued. The loop is scheduled, not standing, so these are what says
 * whether it runs.
 */
const frames = { requested: 0, pending: new Set<number>() };

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  frames.requested = 0;
  frames.pending.clear();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.requested += 1;
    const id = window.setTimeout(() => {
      frames.pending.delete(id);
      cb(performance.now());
    }, 16);
    frames.pending.add(id);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.pending.delete(id);
    window.clearTimeout(id);
  });
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

describe('the selection', () => {
  /** The note the last frame was built with as selected, or -1. */
  const selected = (spy: { mock: { calls: unknown[][] } }): number => spy.mock.calls.at(-1)![3] as number;

  it('is let go by a click on the dark and by Escape, but kept through a pan', async () => {
    const before = await firstVisit();
    const build = vi.spyOn(SceneBuilder.prototype, 'build');
    const { canvas, unmount } = await mount();
    const key = targets[2]!;
    const note = graph.index.get(key)!;
    const p = at(before, key);
    const select = async (): Promise<void> => {
      fireEvent.pointerDown(canvas, { clientX: p.x, clientY: p.y, pointerId: 1 });
      fireEvent.pointerUp(window, { clientX: p.x, clientY: p.y, pointerId: 1 });
      await run(100);
      expect(selected(build)).toBe(note);
    };
    // A corner of the canvas, well away from the brain.
    const dark = { clientX: 4, clientY: 4, pointerId: 1 };

    await select();
    fireEvent.pointerDown(canvas, dark);
    fireEvent.pointerUp(window, dark);
    await run(100);
    expect(selected(build)).toBe(-1);

    await select();
    fireEvent.pointerDown(canvas, dark);
    fireEvent.pointerMove(canvas, { clientX: 60, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 60, clientY: 40, pointerId: 1 });
    await run(100);
    expect(selected(build)).toBe(note);

    fireEvent.keyDown(canvas, { key: 'Escape' });
    await run(100);
    expect(selected(build)).toBe(-1);
    unmount();
  });
});

/**
 * The frame loop runs only while something moves.
 *
 * It is scheduled rather than standing (`Brain.tsx`, `ask`), which makes four
 * things load-bearing that no picture shows at once: that it stops at rest,
 * that a pulse starts it again, that reduced motion keeps every note where it
 * is, and that a key that changes the picture asks for exactly the frame it
 * needs. Each test names the mutation it was checked against.
 */
describe('the frame loop', () => {
  /** Mounts the network over a first visit's stored positions and lets it come to rest. */
  async function quiet(): Promise<{
    canvas: HTMLCanvasElement;
    rerender: (events: PulseEvent[]) => void;
    unmount: () => void;
  }> {
    await firstVisit();
    const props = { data, onOpen: vi.fn(), view: 'network', arrangement: 'brain', remember, inset: INSET } as const;
    const view = render(<Brain {...props} events={[]} />);
    // In steps, not one long run: React commits what a frame set in state only
    // when `act` ends, and a commit can ask for a frame of its own (the legend
    // appearing is a child added over the canvas).
    for (let k = 0; k < 6; k += 1) await run(500);
    return {
      canvas: view.container.querySelector('canvas')!,
      rerender: (next) => view.rerender(<Brain {...props} events={next} />),
      unmount: view.unmount,
    };
  }

  const pulse = (key: string): PulseEvent => {
    const node = graph.nodes[graph.index.get(key)!]!;
    return { at: Date.now(), kind: 'write', what: 'edit', path: node.path, who: 'jb', agent: false, owner: node.owner };
  };

  it('stops asking for frames once the brain is at rest', async () => {
    // Mutation: `if (busy) ask()` as an unconditional `ask()`.
    const { unmount } = await quiet();
    expect(frames.pending.size).toBe(0);
    const before = frames.requested;
    await run(2000);
    expect(frames.requested).toBe(before);
    unmount();
  });

  it('starts again for a new event, and the note it names is warm afterwards', async () => {
    // Mutations: `activity.record(events)` removed; `wake.current()` after it removed.
    const build = vi.spyOn(SceneBuilder.prototype, 'build');
    const { rerender, unmount } = await quiet();
    expect(frames.pending.size).toBe(0);
    const before = frames.requested;
    const key = targets[2]!;
    const note = graph.index.get(key)!;

    rerender([pulse(key)]);
    await run(100);

    expect(frames.requested).toBeGreaterThan(before);
    const activity = build.mock.calls.at(-1)![1] as Activity;
    expect(activity.warm[note]).toBeGreaterThan(0);
    expect(activity.fire[note]).toBeGreaterThan(0);
    unmount();
  });

  it('keeps every note exactly where it is under reduced motion, frame after frame, while a note is held', async () => {
    // Mutation: `if (!reduce)` around the step as `if (true)`.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const seen: Array<{ x: number[]; y: number[] }> = [];
    let camera: Camera = home;
    let layout: BrainLayout | null = null;
    const real = SceneBuilder.prototype.build;
    vi.spyOn(SceneBuilder.prototype, 'build').mockImplementation(function (this: SceneBuilder, ...args) {
      layout = args[0];
      camera = args[2];
      seen.push({ x: Array.from(args[0].x), y: Array.from(args[0].y) });
      return real.apply(this, args);
    });
    const { canvas, unmount } = await quiet();

    // Held, not released: the dragged note's neighbours are free to move, and
    // a loop that stepped the layout would move them on every frame.
    const i = graph.index.get(targets[3]!)!;
    const p = toScreen(camera, layout!.x[i]!, layout!.y[i]!);
    fireEvent.pointerDown(canvas, { clientX: p.x, clientY: p.y, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: p.x + 40, clientY: p.y + 20, pointerId: 1 });
    await run(16);
    const from = seen.length;
    await run(16 * 30);
    const frozen = seen.slice(from);

    // A drag keeps the loop running, so these are real frames, not one.
    expect(frozen.length).toBeGreaterThanOrEqual(25);
    const first = seen[from - 1]!;
    for (const [n, frame] of frozen.entries()) {
      expect(frame.x, `frame ${n}: x`).toEqual(first.x);
      expect(frame.y, `frame ${n}: y`).toEqual(first.y);
    }
    fireEvent.pointerUp(window, { clientX: p.x + 40, clientY: p.y + 20, pointerId: 1 });
    unmount();
  });

  it('asks for exactly one frame when Escape lets go of the selection', async () => {
    // Mutation: the `ask()` in the key handler removed.
    const { canvas, unmount } = await quiet();
    expect(frames.pending.size).toBe(0);
    const before = frames.requested;
    fireEvent.keyDown(canvas, { key: 'Escape' });
    await run(1000);
    expect(frames.requested - before).toBe(1);
    unmount();
  });
});
