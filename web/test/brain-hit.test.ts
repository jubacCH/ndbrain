/**
 * What counts as clicking a node.
 *
 * Two rules, and the test is mostly about keeping them apart. At the zoom the
 * view opens with, nothing may change: a click within about 22 pixels of a cell
 * body's centre picks the nearest one, exactly as it always has. Zoomed in, the
 * cell body is what you see, so everywhere inside its *drawn* outline has to be
 * a grab — otherwise pressing on the visible rim of a node pans the camera
 * instead of moving the node, which feels like the view ignoring you.
 *
 * The drawn outline leans on depth and comes from the render model. The hit test
 * asks the render model for it rather than working it out again, so the two
 * cannot drift apart.
 */

import { describe, expect, it } from 'vitest';

import type { GraphData } from '../src/api';
import { HitIndex } from '../src/brain/hit';
import { BrainLayout } from '../src/brain/layout';
import { buildGraph } from '../src/brain/model';
import { bodyRadius } from '../src/brain/scene';

function lonely(links: number, count = 40): BrainLayout {
  const data: GraphData = {
    nodes: Array.from({ length: count }, (_, i) => ({
      owner: 'jb',
      path: `n${i}.md`,
      title: `n${i}`,
      folder: '',
      links,
    })),
    edges: [],
  };
  return new BrainLayout(buildGraph(data), { arrangement: 'loose' });
}

describe('hitting a node', () => {
  it('takes the whole drawn cell body when zoomed in, including its rim', () => {
    const layout = lonely(12);
    // The node that sits furthest forward is drawn largest — up to 1.1 times
    // its layout radius, which is exactly the ring that used to miss.
    const graph = layout.graph;
    const front = graph.order[graph.order.length - 1]!;
    const drawn = bodyRadius(layout.r[front]!, graph.nodes[front]!.depth);
    expect(drawn).toBeGreaterThan(layout.r[front]!);

    // Alone in the middle of the world, so no neighbour can claim the point.
    for (let i = 0; i < layout.x.length; i += 1) {
      layout.x[i] = 40 + (i % 8) * 20;
      layout.y[i] = 40 + Math.floor(i / 8) * 20;
    }
    layout.x[front] = 600;
    layout.y[front] = 400;

    const hits = new HitIndex(layout);
    const scale = 8;
    // Five screen pixels inside the visible edge.
    const inside = drawn - 5 / scale;
    expect(inside).toBeGreaterThan(layout.r[front]!);
    expect(hits.at(600 + inside, 400, scale)).toBe(front);
    // And just outside it is the dark, where a press pans.
    expect(hits.at(600 + drawn + 5 / scale, 400, scale)).toBe(-1);
  });

  it('answers exactly as the original test did at the starting zoom', () => {
    // The original: nearest centre, accepted within sqrt(500) pixels.
    const data: GraphData = {
      nodes: Array.from({ length: 120 }, (_, i) => ({
        owner: 'jb',
        path: `n${i}.md`,
        title: `n${i}`,
        folder: `f${i % 4}`,
        links: i % 13,
      })),
      edges: [],
    };
    const layout = new BrainLayout(buildGraph(data), { arrangement: 'brain' });
    layout.settle();
    const hits = new HitIndex(layout);
    // Probe the world the arrangement occupies, which is centred on the origin.
    const { minX, minY, maxX, maxY } = layout.bounds;

    let s = 42;
    const rnd = (): number => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    let found = 0;
    for (let k = 0; k < 20000; k += 1) {
      const x = minX + rnd() * (maxX - minX);
      const y = minY + rnd() * (maxY - minY);
      let best = -1;
      let bd = Infinity;
      for (let i = 0; i < layout.x.length; i += 1) {
        const d = (layout.x[i]! - x) ** 2 + (layout.y[i]! - y) ** 2;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      const expected = bd < 500 ? best : -1;
      if (expected !== -1) found += 1;
      expect(hits.at(x, y, 1)).toBe(expected);
    }
    // Not a vacuous pass over empty space.
    expect(found).toBeGreaterThan(1000);
  });

  it('follows the nodes once told they moved, and not before', () => {
    const layout = lonely(1, 2);
    layout.x[0] = 100;
    layout.y[0] = 100;
    layout.x[1] = 800;
    layout.y[1] = 600;
    const hits = new HitIndex(layout);
    expect(hits.at(100, 100, 1)).toBe(0);

    layout.x[0] = 400;
    layout.y[0] = 300;
    hits.invalidate();
    expect(hits.at(400, 300, 1)).toBe(0);
    expect(hits.at(100, 100, 1)).toBe(-1);
  });
});
