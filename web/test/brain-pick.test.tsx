/**
 * Picking a link and a region, through the component and real events.
 *
 * The geometry is settled in `brain-edgehit` and `brain-walk`; what is checked
 * here is that the canvas actually offers it:
 *
 *  - **A click on a drawn link picks that link** and tells the caller which
 *    two notes it joins — the briefing's "click edge = relationship inspector"
 *    (point 22), which it calls extremely important.
 *  - **The arrows reach the same places without a mouse.** A link is a
 *    one-pixel curve; a feature only a pointer can reach is not there for half
 *    the ways of working this app has.
 *  - **The picture comes back to rest.** A new selection has to repaint the
 *    cached layers once and then stop asking for frames, or it is the pulse
 *    burning itself into the cache again.
 */

import { act, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Picked } from '../src/Brain';
import { Brain } from '../src/Brain';
import type { Camera } from '../src/brain/camera';
import { toScreen } from '../src/brain/camera';
import { VISIBLE } from '../src/brain/edges';
import { buildGraph } from '../src/brain/model';
import type { Scene } from '../src/brain/scene';
import { SceneBuilder } from '../src/brain/scene';
import { paraVault } from './fixtures/para-vault';

const W = 1200;
const H = 800;
const INSET = { top: 0, right: 0, bottom: 0, left: 0 };
const remember = { account: 'jb', store: 'network' };
const { data } = paraVault();
const graph = buildGraph(data);

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(performance.now()), 16),
  );
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

type Spy = { mock: { calls: unknown[][]; results: Array<{ value: unknown }> } };

const lastScene = (spy: Spy): Scene => spy.mock.results.at(-1)!.value as Scene;

/**
 * A screen point on a drawn link, well clear of every cell body.
 *
 * "Clear" matters: the node test runs first and wins, as it should, so a point
 * near a note says nothing about whether links can be picked at all.
 */
function linkPoint(scene: Scene, camera: Camera): { x: number; y: number; a: number; b: number } {
  for (let i = 0; i < scene.edges.length; i += 1) {
    const edge = scene.edges[i]!;
    if (edge.n < 2 || edge.restAlpha < VISIBLE) continue;
    for (let k = 2; k < edge.n - 2; k += 1) {
      const p = toScreen(camera, edge.pts[k * 2]!, edge.pts[k * 2 + 1]!);
      if (p.x < 20 || p.x > W - 20 || p.y < 20 || p.y > H - 20) continue;
      let clear = true;
      for (const node of scene.nodes) {
        const q = toScreen(camera, node.x, node.y);
        if (Math.hypot(q.x - p.x, q.y - p.y) < 40) {
          clear = false;
          break;
        }
      }
      if (clear) return { x: p.x, y: p.y, a: graph.edges[i]!.a, b: graph.edges[i]!.b };
    }
  }
  throw new Error('no link on the canvas clear of every note');
}

/** Lays the brain out once and stores it, as a first visit does. */
async function firstVisit(): Promise<void> {
  const view = render(
    <Brain
      data={data}
      events={[]}
      onOpen={vi.fn()}
      view="network"
      arrangement="brain"
      remember={remember}
      inset={INSET}
    />,
  );
  await run(200);
  view.unmount();
}

async function mountFocused(): Promise<{
  canvas: HTMLCanvasElement;
  onPick: ReturnType<typeof vi.fn>;
  unmount: () => void;
}> {
  const onPick = vi.fn();
  function Focused(): React.JSX.Element {
    const [picked, setPicked] = useState<Picked | null>(null);
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
          onPick: (next) => {
            onPick(next);
            setPicked(next);
          },
        }}
      />
    );
  }
  const view = render(<Focused />);
  await run(200);
  return { canvas: view.container.querySelector('canvas')!, onPick, unmount: view.unmount };
}

const click = (canvas: HTMLCanvasElement, p: { x: number; y: number }): void => {
  fireEvent.pointerDown(canvas, { clientX: p.x, clientY: p.y, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: p.x, clientY: p.y, pointerId: 1 });
};

describe('picking a link on the canvas', () => {
  it('tells the caller which two notes a clicked link joins', async () => {
    await firstVisit();
    const build = vi.spyOn(SceneBuilder.prototype, 'build') as unknown as Spy;
    const { canvas, onPick, unmount } = await mountFocused();
    const scene = lastScene(build);
    const at = linkPoint(scene, scene.camera);

    click(canvas, at);
    await run(100);

    const picked = onPick.mock.calls.at(-1)![0] as Picked;
    expect(picked.kind).toBe('link');
    // Whichever link is nearest that point; both its ends are real notes.
    if (picked.kind === 'link') {
      expect(graph.index.get(picked.from)).toBeGreaterThanOrEqual(0);
      expect(graph.index.get(picked.to)).toBeGreaterThanOrEqual(0);
      expect(picked.from).not.toBe(picked.to);
    }
    unmount();
  });

  it('leaves the camera where it is: a link is picked by pointing at it', async () => {
    await firstVisit();
    const build = vi.spyOn(SceneBuilder.prototype, 'build') as unknown as Spy;
    const { canvas, unmount } = await mountFocused();
    const scene = lastScene(build);
    const before = scene.camera;
    const at = linkPoint(scene, before);

    click(canvas, at);
    await run(800);
    // A picked *note* flies the camera onto it; a picked link must not, or the
    // thing just clicked moves out from under the pointer.
    expect(lastScene(build).camera).toEqual(before);
    unmount();
  });

  it('draws the picked link wider, repaints once, and comes back to rest', async () => {
    await firstVisit();
    const build = vi.spyOn(SceneBuilder.prototype, 'build') as unknown as Spy;
    const { canvas, unmount } = await mountFocused();
    await run(600);
    const settled = lastScene(build);
    const at = linkPoint(settled, settled.camera);
    const wasStamp = settled.stamp;
    const widths = settled.edges.map((e) => e.w0);

    click(canvas, at);
    await run(200);
    const now = lastScene(build);
    // The selection is part of the cached picture, so it has to bump the stamp:
    // a width baked into a layer that is never repainted stays there.
    expect(now.stamp).not.toBe(wasStamp);
    const wider = now.edges.filter((e, i) => e.w0 > widths[i]! + 1e-9);
    expect(wider).toHaveLength(1);

    // And then it stops. A selection is not motion; a frame loop that keeps
    // asking after one is the fault that burned a pulse into the cache.
    await run(600);
    const calls = build.mock.calls.length;
    await run(1000);
    expect(build.mock.calls.length).toBe(calls);
    expect(lastScene(build).stamp).toBe(now.stamp);
    unmount();
  });
});

describe('walking the canvas with the keyboard', () => {
  it('reaches the regions with the arrows and says which one', async () => {
    await firstVisit();
    const { canvas, onPick, unmount } = await mountFocused();

    fireEvent.keyDown(canvas, { key: 'ArrowDown' });
    await run(50);
    const first = onPick.mock.calls.at(-1)![0] as Picked;
    expect(first.kind).toBe('region');
    if (first.kind === 'region') {
      expect(first.name).not.toBe('');
      expect(first.members.length).toBeGreaterThan(0);
      // Every member is a note of this graph, named the way the rest of the
      // app names one.
      for (const key of first.members) expect(graph.index.has(key)).toBe(true);
    }

    fireEvent.keyDown(canvas, { key: 'ArrowDown' });
    await run(50);
    const second = onPick.mock.calls.at(-1)![0] as Picked;
    expect(second.kind).toBe('region');
    if (first.kind === 'region' && second.kind === 'region') expect(second.hub).not.toBe(first.hub);
    unmount();
  });

  it('reaches a note’s links with the arrows, and Escape comes back to the note', async () => {
    await firstVisit();
    const build = vi.spyOn(SceneBuilder.prototype, 'build') as unknown as Spy;
    const { canvas, onPick, unmount } = await mountFocused();
    // A note with several links, clicked where it is on screen.
    const scene = lastScene(build);
    const hub = graph.nodes.findIndex((n) => n.degree >= 4);
    expect(hub).toBeGreaterThanOrEqual(0);
    const p = toScreen(scene.camera, scene.nodes[hub]!.x, scene.nodes[hub]!.y);
    click(canvas, p);
    await run(800);
    expect((onPick.mock.calls.at(-1)![0] as Picked).kind).toBe('note');
    const note = onPick.mock.calls.at(-1)![0] as Picked;

    fireEvent.keyDown(canvas, { key: 'ArrowDown' });
    await run(50);
    const one = onPick.mock.calls.at(-1)![0] as Picked;
    expect(one.kind).toBe('link');

    fireEvent.keyDown(canvas, { key: 'ArrowDown' });
    await run(50);
    const two = onPick.mock.calls.at(-1)![0] as Picked;
    expect(two.kind).toBe('link');
    expect(two).not.toEqual(one);

    // Escape from a link goes back to the note it was walked from, not to
    // nothing: that is where carrying on makes sense.
    fireEvent.keyDown(canvas, { key: 'Escape' });
    await run(50);
    expect(onPick.mock.calls.at(-1)![0]).toEqual(note);
    fireEvent.keyDown(canvas, { key: 'Escape' });
    await run(50);
    expect(onPick.mock.calls.at(-1)![0]).toBeNull();
    unmount();
  });
});
