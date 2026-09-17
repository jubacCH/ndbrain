/**
 * The card under the pointer names the space a note is in.
 *
 * Every other view says where a note from a space comes from — the tree, the
 * list, the map, search, the palette and the inspector. The brain mixes the
 * notes of every vault into one picture, so the card is the only place it can
 * say it, and it says it by the space's display name, never its account name.
 */

import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Brain } from '../src/Brain';
import type { GraphData } from '../src/api';
import type { Camera } from '../src/brain/camera';
import { toScreen } from '../src/brain/camera';
import type { BrainLayout } from '../src/brain/layout';
import { buildGraph } from '../src/brain/model';
import { SceneBuilder } from '../src/brain/scene';
import { copy } from '../src/copy';
import { OwnersContext, ownerDirectory } from '../src/owners';

const W = 1200;
const H = 800;
const INSET = { top: 0, right: 0, bottom: 0, left: 0 };

function vault(owner: string, prefix: string): GraphData {
  const paths = Array.from({ length: 6 }, (_, i) => `${prefix}/Notiz ${i}.md`);
  return {
    nodes: paths.map((path, i) => ({ owner, path, title: `${prefix} ${i}`, folder: prefix, links: 1, tags: [], updatedAt: 0 })),
    edges: paths.slice(1).map((to) => ({ owner, from: paths[0]!, to })),
  };
}

const own = vault('anna', 'Privat');
const space = vault('familie', 'Rezepte');
const data: GraphData = { nodes: [...own.nodes, ...space.nodes], edges: [...own.edges, ...space.edges] };
const graph = buildGraph(data);
const owners = ownerDirectory([
  { id: 'anna', kind: 'person', displayName: 'Anna' },
  { id: 'familie', kind: 'space', displayName: 'Familie Bachmann' },
]);

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

function where(spy: { mock: { calls: unknown[][] } }, key: string): { x: number; y: number } {
  const call = spy.mock.calls.at(-1)!;
  const layout = call[0] as BrainLayout;
  const camera = call[2] as Camera;
  const i = graph.index.get(key)!;
  return toScreen(camera, layout.x[i]!, layout.y[i]!);
}

/** The card's rows as `term: value`, or null when no card is shown. */
function cardRows(container: HTMLElement): string[] | null {
  const card = container.querySelector('.braincard');
  if (card === null) return null;
  return [...card.querySelectorAll('dt')].map((dt) => `${dt.textContent}: ${dt.nextElementSibling?.textContent ?? ''}`);
}

describe('the card under the pointer', () => {
  it('names the space of a note from a space, and nothing for a note of your own', async () => {
    const build = vi.spyOn(SceneBuilder.prototype, 'build');
    const view = render(
      <OwnersContext.Provider value={owners}>
        <Brain data={data} events={[]} onOpen={vi.fn()} view="network" arrangement="loose" inset={INSET} />
      </OwnersContext.Provider>,
    );
    await run(400);
    const canvas = view.container.querySelector('canvas')!;

    const spaceNote = where(build, graph.nodes[graph.index.get(`familie\u0000Rezepte/Notiz 3.md`)!]!.key);
    fireEvent.pointerMove(canvas, { clientX: spaceNote.x, clientY: spaceNote.y, pointerId: 1 });
    await run(50);
    const onSpace = cardRows(view.container);
    expect(onSpace).not.toBeNull();
    expect(onSpace).toContain(`${copy.network.card.space}: Familie Bachmann`);
    expect(view.container.querySelector('.braincard')!.textContent).not.toMatch(/\bfamilie\b/);

    const ownNote = where(build, graph.nodes[graph.index.get(`anna\u0000Privat/Notiz 3.md`)!]!.key);
    fireEvent.pointerMove(canvas, { clientX: ownNote.x, clientY: ownNote.y, pointerId: 1 });
    await run(50);
    const onOwn = cardRows(view.container);
    expect(onOwn).not.toBeNull();
    expect(onOwn!.some((row) => row.startsWith(`${copy.network.card.space}:`))).toBe(false);
    view.unmount();
  });
});
