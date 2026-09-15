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
    const { rerender } = render(<Brain data={graph('a.md')} events={[]} onOpen={open} view="a.md" />);
    await frames();
    expect(reset()).toBeNull();

    zoomIn();
    await frames();
    expect(reset()).not.toBeNull();

    // A new object with one note more: what a refetch after an edit delivers.
    rerender(<Brain data={graph('a.md', 1)} events={[]} onOpen={open} view="a.md" />);
    await frames();
    expect(reset()).not.toBeNull();
  });

  it('starts from the overview when the canvas is switched to another note', async () => {
    const open = vi.fn();
    const { rerender } = render(<Brain data={graph('a.md')} events={[]} onOpen={open} view="a.md" />);
    zoomIn();
    await frames();
    expect(reset()).not.toBeNull();

    rerender(<Brain data={graph('b.md')} events={[]} onOpen={open} view="b.md" />);
    await frames();
    expect(reset()).toBeNull();
  });
});
