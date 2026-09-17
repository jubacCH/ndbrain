/**
 * Focus mode, through the component and real pointer events.
 *
 * The promises, in the order somebody would notice them broken:
 *
 *  - **A click on a note focuses it.** The caller is told, and the camera
 *    glides — not jumps — so that the note is framed.
 *  - **Only the camera moves.** Five focusing clicks and a double click leave
 *    every stored position exactly where it was.
 *  - **Escape and a click on the dark end the focus and leave the camera
 *    where it is.** Going home is the reset control's job.
 *  - **The caller can move the focus**, as the inspector does for a neighbour.
 */

import { act, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Brain } from '../src/Brain';
import type { Camera } from '../src/brain/camera';
import { toScreen } from '../src/brain/camera';
import type { BrainLayout } from '../src/brain/layout';
import { buildGraph } from '../src/brain/model';
import { loadPositions } from '../src/brain/positions';
import { SceneBuilder } from '../src/brain/scene';
import { paraVault } from './fixtures/para-vault';

const W = 1200;
const H = 800;
const INSET = { top: 0, right: 0, bottom: 0, left: 0 };
const remember = { account: 'jb', store: 'network' };
const { data } = paraVault();
const graph = buildGraph(data);
const targets = [3, 20, 47, 71, 96].map((i) => graph.nodes[i]!.key);

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

/** The camera, layout and selection of the last frame built. */
function lastFrame(spy: { mock: { calls: unknown[][] } }): { layout: BrainLayout; camera: Camera; picked: number } {
  const call = spy.mock.calls.at(-1)!;
  return { layout: call[0] as BrainLayout, camera: call[2] as Camera, picked: call[3] as number };
}

/** Where a note is on screen in the last frame. */
function onScreen(spy: { mock: { calls: unknown[][] } }, key: string): { x: number; y: number } {
  const { layout, camera } = lastFrame(spy);
  const i = graph.index.get(key)!;
  return toScreen(camera, layout.x[i]!, layout.y[i]!);
}

/** Lays the brain out once and stores it, as a first visit does. */
async function firstVisit(): Promise<void> {
  const view = render(<Brain data={data} events={[]} onOpen={vi.fn()} view="network" arrangement="brain" remember={remember} inset={INSET} />);
  await run(200);
  view.unmount();
}

/** A caller that holds the selection, as the network frame does. */
async function mountFocused(): Promise<{
  canvas: HTMLCanvasElement;
  onPick: ReturnType<typeof vi.fn>;
  setPicked: (key: string | null) => void;
  unmount: () => void;
}> {
  const onPick = vi.fn();
  const handle: { set: (key: string | null) => void } = { set: () => {} };
  function Focused(): React.JSX.Element {
    const [picked, setPicked] = useState<string | null>(null);
    handle.set = setPicked;
    return (
      <Brain
        data={data}
        events={[]}
        onOpen={vi.fn()}
        view="network"
        arrangement="brain"
        remember={remember}
        inset={INSET}
        focus={{
          picked,
          onPick: (key) => {
            onPick(key);
            setPicked(key);
          },
        }}
      />
    );
  }
  const view = render(<Focused />);
  await run(200);
  return {
    canvas: view.container.querySelector('canvas')!,
    onPick,
    setPicked: (key) => act(() => handle.set(key)),
    unmount: view.unmount,
  };
}

const click = (canvas: HTMLCanvasElement, p: { x: number; y: number }): void => {
  fireEvent.pointerDown(canvas, { clientX: p.x, clientY: p.y, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: p.x, clientY: p.y, pointerId: 1 });
};

describe('focus mode', () => {
  it('focuses a clicked note: tells the caller, and glides the camera onto it', async () => {
    await firstVisit();
    const build = vi.spyOn(SceneBuilder.prototype, 'build');
    const { canvas, onPick, unmount } = await mountFocused();
    const key = targets[2]!;
    const home = lastFrame(build).camera;

    click(canvas, onScreen(build, key));
    expect(onPick).toHaveBeenLastCalledWith(key);

    // Partway: moving, not there yet.
    await run(120);
    const partway = lastFrame(build).camera;
    await run(600);
    const settled = lastFrame(build);
    expect(settled.picked).toBe(graph.index.get(key));
    expect(partway).not.toEqual(home);
    expect(partway).not.toEqual(settled.camera);
    expect(settled.camera.scale).toBeGreaterThan(home.scale);

    // Framed: the note is on the canvas, and so is every direct neighbour.
    const i = graph.index.get(key)!;
    const members = [i, ...graph.touching[i]!.map((e) => (graph.edges[e]!.a === i ? graph.edges[e]!.b : graph.edges[e]!.a))];
    for (const m of members) {
      const p = toScreen(settled.camera, settled.layout.x[m]!, settled.layout.y[m]!);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(W);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(H);
    }

    // And it rests there.
    await run(1000);
    expect(lastFrame(build).camera).toEqual(settled.camera);
    unmount();
  });

  it('moves no note, five focusing clicks and a double click over', { timeout: 30_000 }, async () => {
    await firstVisit();
    const before = loadPositions(remember);
    const build = vi.spyOn(SceneBuilder.prototype, 'build');
    const { canvas, onPick, unmount } = await mountFocused();

    // Each click lands on the note where it is now: the camera moved after the last one.
    for (const key of targets) {
      click(canvas, onScreen(build, key));
      await run(600);
      expect(onPick).toHaveBeenLastCalledWith(key);
    }
    const p = onScreen(build, targets[0]!);
    click(canvas, p);
    click(canvas, p);
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

  it('is ended by Escape and by a click on the dark, and the camera stays where it was', async () => {
    await firstVisit();
    const build = vi.spyOn(SceneBuilder.prototype, 'build');
    const { canvas, onPick, unmount } = await mountFocused();
    const key = targets[1]!;

    click(canvas, onScreen(build, key));
    await run(600);
    const focused = lastFrame(build).camera;

    fireEvent.keyDown(canvas, { key: 'Escape' });
    await run(600);
    expect(onPick).toHaveBeenLastCalledWith(null);
    expect(lastFrame(build).picked).toBe(-1);
    expect(lastFrame(build).camera).toEqual(focused);

    click(canvas, onScreen(build, key));
    await run(600);
    const again = lastFrame(build).camera;
    // A corner of the canvas, away from the focused notes.
    click(canvas, { x: 2, y: 2 });
    await run(600);
    expect(onPick).toHaveBeenLastCalledWith(null);
    expect(lastFrame(build).picked).toBe(-1);
    expect(lastFrame(build).camera).toEqual(again);
    unmount();
  });

  it('follows the caller moving the focus to another note, and letting go of it', async () => {
    await firstVisit();
    const build = vi.spyOn(SceneBuilder.prototype, 'build');
    const { setPicked, unmount } = await mountFocused();
    const home = lastFrame(build).camera;
    const key = targets[4]!;

    setPicked(key);
    await run(600);
    expect(lastFrame(build).picked).toBe(graph.index.get(key));
    const focused = lastFrame(build).camera;
    expect(focused).not.toEqual(home);

    setPicked(null);
    await run(600);
    expect(lastFrame(build).picked).toBe(-1);
    expect(lastFrame(build).camera).toEqual(focused);
    unmount();
  });
});
