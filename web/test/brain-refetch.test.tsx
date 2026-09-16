/**
 * What a refetch of the same view costs.
 *
 * The graph is refetched whenever anything in the vault changes, and most of
 * those changes are invisible to the network: a note's text edited, an agent
 * reading. Growing the tissue and finding the region anchors again for an
 * identical picture is a stutter on a large vault, so a refetch that leaves the
 * positions and the regions as they were keeps both. One that changes them
 * grows them again.
 */

import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GraphData, PulseEvent } from '../src/api';
import { Brain } from '../src/Brain';
import { buildDecoration } from '../src/brain/deco';
import { BrainLayout } from '../src/brain/layout';
import { Activity } from '../src/brain/activity';
import { buildGraph } from '../src/brain/model';
import { regionAnchors } from '../src/brain/regions';
import { SceneBuilder } from '../src/brain/scene';
import { paraVault } from './fixtures/para-vault';

vi.mock('../src/brain/deco', async (original) => {
  const real = await original<typeof import('../src/brain/deco')>();
  return { ...real, buildDecoration: vi.fn(real.buildDecoration) };
});
vi.mock('../src/brain/regions', async (original) => {
  const real = await original<typeof import('../src/brain/regions')>();
  return { ...real, regionAnchors: vi.fn(real.regionAnchors) };
});

const W = 1200;
const H = 800;
const INSET = { top: 0, right: 0, bottom: 0, left: 0 };
const remember = { account: 'jb', store: 'network' };
const { data } = paraVault();

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  vi.mocked(buildDecoration).mockClear();
  vi.mocked(regionAnchors).mockClear();
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

/** Lets the loop run in steps, so React commits what the frames set in between. */
async function settle(steps = 6): Promise<void> {
  for (let k = 0; k < steps; k += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
  }
}

async function mounted(): Promise<{ refetch: (next: GraphData) => Promise<void>; unmount: () => void }> {
  const props = { events: [] as PulseEvent[], onOpen: vi.fn(), view: 'network', arrangement: 'brain', remember, inset: INSET } as const;
  const view = render(<Brain {...props} data={data} />);
  await settle();
  return {
    // Long enough for a capture to come to rest on screen, which is when the
    // tissue is grown.
    refetch: async (next) => {
      view.rerender(<Brain {...props} data={next} />);
      await settle(24);
    },
    unmount: view.unmount,
  };
}

describe('a refetch of the same view', () => {
  it('keeps the tissue and the region anchors when nothing they are grown from changed', async () => {
    const { refetch, unmount } = await mounted();
    expect(buildDecoration).toHaveBeenCalledTimes(1);
    expect(regionAnchors).toHaveBeenCalledTimes(1);

    // A new reply with the same content: what an edit to some note's text returns.
    await refetch(structuredClone(data));
    await refetch(structuredClone(data));

    expect(buildDecoration).toHaveBeenCalledTimes(1);
    expect(regionAnchors).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('grows them again when a note is added', async () => {
    const build = vi.spyOn(SceneBuilder.prototype, 'build');
    const { refetch, unmount } = await mounted();
    const last = (): { deco: unknown; regions: unknown } => {
      const scene = build.mock.results.at(-1)!.value as { deco: unknown; regions: unknown };
      return { deco: scene.deco, regions: scene.regions };
    };
    const before = last();
    const next = structuredClone(data);
    const anchor = next.nodes[20]!;
    const path = `${anchor.folder === '' ? '' : `${anchor.folder}/`}zz captured.md`;
    next.nodes.push({ ...anchor, path, title: 'zz captured', links: 1, tags: [] });
    next.edges.push({ owner: anchor.owner, from: path, to: anchor.path });

    await refetch(next);

    // At least once more each; the anchors can be found twice, once for the
    // first frame and once when the capture has come to rest.
    expect(vi.mocked(buildDecoration).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(vi.mocked(regionAnchors).mock.calls.length).toBeGreaterThanOrEqual(2);
    // And what is drawn is what was grown for the new layout, not the old one.
    const after = last();
    expect(after.deco).not.toBe(before.deco);
    expect(after.regions).not.toBe(before.regions);
    unmount();
  });

  it('grows the tissue again when a new link moves notes, with every note and its warmth unchanged', async () => {
    const build = vi.spyOn(SceneBuilder.prototype, 'build');
    const { refetch, unmount } = await mounted();
    const before = (build.mock.results.at(-1)!.value as { deco: unknown }).deco;
    const next = structuredClone(data);
    // Two notes far apart in the vault, not yet linked.
    const a = next.nodes[3]!;
    const b = next.nodes[96]!;
    expect(next.edges.some((e) => (e.from === a.path && e.to === b.path) || (e.from === b.path && e.to === a.path))).toBe(false);
    next.edges.push({ owner: a.owner, from: a.path, to: b.path });

    await refetch(next);

    expect(buildDecoration).toHaveBeenCalledTimes(2);
    expect((build.mock.results.at(-1)!.value as { deco: unknown }).deco).not.toBe(before);
    unmount();
  });

  it('grows the tissue again when a note is edited and warms', async () => {
    const { refetch, unmount } = await mounted();
    const next = structuredClone(data);
    next.nodes[5] = { ...next.nodes[5]!, updatedAt: Date.now() };

    await refetch(next);

    // The branches of the note carry its warmth; the anchors do not.
    expect(buildDecoration).toHaveBeenCalledTimes(2);
    expect(regionAnchors).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe('what a builder takes over from the one it replaces', () => {
  const graph = buildGraph(data);
  const grown = (): { layout: BrainLayout; builder: SceneBuilder } => {
    const layout = new BrainLayout(graph, { arrangement: 'brain' });
    layout.settle();
    const builder = new SceneBuilder(graph);
    builder.build(layout, new Activity(graph), { scale: 1, x: 0, y: 0 }, -1, W, H);
    return { layout, builder };
  };
  /** A layout over the same graph, from the old one's positions, changed by `change` before its first frame. */
  const successor = (old: { layout: BrainLayout; builder: SceneBuilder }, change: (l: BrainLayout) => void): void => {
    const layout = new BrainLayout(graph, { arrangement: 'brain', remembered: old.layout.positions() });
    layout.settle();
    change(layout);
    const builder = new SceneBuilder(graph);
    builder.inherit(old.builder);
    builder.build(layout, new Activity(graph), { scale: 1, x: 0, y: 0 }, -1, W, H);
  };

  it('takes both when shape and positions are the same', () => {
    const old = grown();
    successor(old, () => {});
    expect(buildDecoration).toHaveBeenCalledTimes(1);
    expect(regionAnchors).toHaveBeenCalledTimes(1);
  });

  it('grows both again when one note is a unit away from where they were grown', () => {
    const old = grown();
    successor(old, (l) => {
      (l.x as Float64Array)[40] = l.x[40]! + 1;
    });
    expect(buildDecoration).toHaveBeenCalledTimes(2);
    expect(regionAnchors).toHaveBeenCalledTimes(2);
  });

  it('grows both again when a region is renamed and every note is where it was', () => {
    const old = grown();
    successor(old, (l) => {
      const [first, ...rest] = l.regions;
      (l as { regions: typeof l.regions }).regions = [{ ...first!, name: `${first!.name} (renamed)` }, ...rest];
    });
    expect(buildDecoration).toHaveBeenCalledTimes(2);
    expect(regionAnchors).toHaveBeenCalledTimes(2);
  });
});

describe('the stamp', () => {
  it('is never repeated by the builder that replaces another', () => {
    // The renderer keeps its cached layers across a refetch and reuses one whose
    // stamp matches: two builders counting from the same start would hand the
    // new picture the old one's pixels.
    const graph = buildGraph(data);
    const stamp = (): number => {
      const layout = new BrainLayout(graph, { arrangement: 'brain' });
      layout.settle();
      return new SceneBuilder(graph).build(layout, new Activity(graph), { scale: 1, x: 0, y: 0 }, -1, W, H).stamp;
    };
    const first = stamp();
    expect(stamp()).toBeGreaterThan(first);
  });
});
