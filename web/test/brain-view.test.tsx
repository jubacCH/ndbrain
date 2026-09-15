/**
 * The camera across a change of data.
 *
 * The component gets a new graph for two very different reasons, and they
 * want opposite things. A refetch — somebody saved a note, an agent wrote one —
 * is the same picture with a detail changed, and throwing away the zoom would
 * punish whoever is looking for an edit they did not make. Opening another
 * note is a different picture: the neighbourhood panel keeps its canvas, but
 * the camera belongs to the note that was open, and carrying it over leaves the
 * new neighbourhood magnified and off to one side.
 *
 * The component cannot tell those apart from the data — two neighbouring notes
 * share most of their neighbourhood — so the caller says what the canvas is
 * showing, and these tests hold it to that.
 *
 * There is no real canvas in jsdom. None is needed: the reset control is only
 * rendered while the camera is away from home, which makes it a faithful
 * readout of the camera without reaching inside.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Brain } from '../src/Brain';
import type { GraphData } from '../src/api';
import { copy } from '../src/copy';
import { loadPositions } from '../src/brain/positions';

function graph(centre: string, extra = 0): GraphData {
  const around = Array.from({ length: 4 + extra }, (_, i) => `n${i}.md`);
  return {
    nodes: [centre, ...around].map((path) => ({ owner: 'jb', path, title: path, folder: '', links: 1 })),
    edges: around.map((to) => ({ owner: 'jb', from: centre, to })),
  };
}

/** Runs the animation loop long enough for the camera to reach React. */
async function frames(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
}

const reset = (): HTMLElement | null => screen.queryByRole('button', { name: copy.network.resetView });

describe('the camera when the graph changes', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    let clock = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      window.setTimeout(() => cb((clock += 16)), 16),
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const zoomIn = (): void => {
    const canvas = screen.getByLabelText(copy.network.canvas);
    fireEvent.wheel(canvas, { deltaY: -300, clientX: 40, clientY: 30 });
  };

  it('keeps the zoom when the same view is refetched', async () => {
    const open = vi.fn();
    const { rerender } = render(<Brain data={graph('a.md')} events={[]} onOpen={open} view="a.md" arrangement="loose" />);
    await frames();
    expect(reset()).toBeNull();

    zoomIn();
    await frames();
    expect(reset()).not.toBeNull();

    // A new object with one note more: what a refetch after an edit delivers.
    rerender(<Brain data={graph('a.md', 1)} events={[]} onOpen={open} view="a.md" arrangement="loose" />);
    await frames();
    expect(reset()).not.toBeNull();
  });

  it('starts from the overview when the canvas is switched to another note', async () => {
    const open = vi.fn();
    const { rerender } = render(<Brain data={graph('a.md')} events={[]} onOpen={open} view="a.md" arrangement="loose" />);
    zoomIn();
    await frames();
    expect(reset()).not.toBeNull();

    rerender(<Brain data={graph('b.md')} events={[]} onOpen={open} view="b.md" arrangement="loose" />);
    await frames();
    expect(reset()).toBeNull();
  });
});

describe('the layout when the window changes', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    let clock = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      window.setTimeout(() => cb((clock += 16)), 16),
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Mounts the network in a canvas of the given size, lets it run, and returns what it stored. */
  async function storedAt(width: number, height: number, resizeTo?: [number, number]): Promise<Map<string, { x: number; y: number }>> {
    let size = { width, height };
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ x: 0, y: 0, top: 0, left: 0, right: size.width, bottom: size.height, ...size, toJSON: () => ({}) }) as DOMRect,
    );
    const remember = { account: 'jb', store: 'network' };
    const data = graph('hub.md', 12);
    const { unmount } = render(
      <Brain data={data} events={[]} onOpen={vi.fn()} view="network" arrangement="brain" remember={remember} />,
    );
    await frames();
    if (resizeTo !== undefined) {
      size = { width: resizeTo[0], height: resizeTo[1] };
      await act(async () => {
        window.dispatchEvent(new Event('resize'));
      });
      await frames();
    }
    unmount();
    return loadPositions(remember);
  }

  it('lays out the same brain in a wide window, a narrow one, and one resized while open', async () => {
    // The layout used to live in the viewport's coordinates: a narrower window
    // squeezed the brain, and the positions it stored were pixels of that window.
    // Now the window only changes the camera. Unmounting stores the positions,
    // which makes them a readout of the layout from outside.
    const wide = await storedAt(1400, 900);
    window.localStorage.clear();
    const narrow = await storedAt(420, 700);
    window.localStorage.clear();
    const resized = await storedAt(1400, 900, [500, 360]);

    expect(wide.size).toBe(17);
    for (const [key, at] of wide) {
      expect(narrow.get(key)).toEqual(at);
      expect(resized.get(key)).toEqual(at);
    }
  });
});
