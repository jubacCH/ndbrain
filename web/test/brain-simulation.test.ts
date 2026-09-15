/**
 * The simulation, pinned to the behaviour it had before the view was cut apart.
 *
 * When `step()` moved out of the component it was checked to be bit-identical
 * to the loop it replaced. A measurement taken once proves nothing about the
 * next change, though, and the next change is coming: the repulsion is still
 * O(n²), and Barnes-Hut will replace exactly that loop. Whoever does it needs to
 * know whether they changed the approximation they meant to change or, by
 * accident, a spring constant.
 *
 * So the reference is **frozen numbers**, not a copy of the old loop. A copy
 * would sit next to the new code and be edited along with it the day somebody
 * "fixes" both; numbers cannot be. They were produced by the `step()` of commit
 * 8c3c1db (the last version with the simulation inside `Brain.tsx`), run
 * through the scenario below, and the refactored layout reproduced every one of
 * them bit for bit at the time of freezing.
 *
 * The scenario covers the three ways the loop is driven in the app: free
 * running, a node held by the pointer, and the viewport changing size.
 *
 * Compared to six decimals rather than exactly. V8's trigonometry is a fixed
 * port and has been stable for years, but a test that fails on a runtime
 * upgrade would teach people to update the numbers without looking — and a
 * force layout is chaotic enough that any real change to a force shows up as
 * whole pixels within a few dozen frames, far above that tolerance.
 *
 * **When this fails on purpose** — Barnes-Hut, a new force, a retuned constant —
 * the numbers are meant to be replaced. Say so in the commit, and look at the
 * picture first.
 */

import { describe, expect, it } from 'vitest';

import type { GraphData } from '../src/api';
import { BrainLayout } from '../src/brain/layout';
import { buildGraph, nodeKey } from '../src/brain/model';

/** A repeatable vault: five folders, two owners, a scatter of links. */
function vault(n: number, seed: number): GraphData {
  let s = seed;
  const rnd = (): number => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const folders = ['00_Inbox', '10_Projects', '20_Areas', '30_Resources', '40_MOCs'];
  const nodes = Array.from({ length: n }, (_, i) => {
    const folder = folders[Math.floor(rnd() * folders.length)]!;
    return { owner: i % 7 === 0 ? 'other' : 'jb', path: `${folder}/n${i}.md`, title: `n${i}`, folder, links: 0 };
  });
  const edges = [];
  for (let k = 0; k < n * 2; k += 1) {
    const a = nodes[Math.floor(rnd() * n)]!;
    const b = nodes[Math.floor(rnd() * n)]!;
    if (a.owner !== b.owner) continue;
    edges.push({ owner: a.owner, from: a.path, to: b.path });
    a.links += 1;
    b.links += 1;
  }
  return { nodes, edges };
}

const W = 1000;
const H = 700;
const PROBES = [0, 7, 23, 41, 66];

interface Fingerprint {
  sumX: number;
  sumY: number;
  probes: Array<[number, number]>;
}

/** Produced by the 8c3c1db `step()`; see the header before changing any of it. */
const REFERENCE: Record<number, Fingerprint> = {
  50: {
    sumX: 39681.60228358631,
    sumY: 27947.965913348584,
    probes: [
      [467.29809534849, 588.6016649927557],
      [820.2392041501846, 447.0704175009331],
      [508.24519433017275, 482.1865595391627],
      [286.02844830305474, 286.0015664781306],
      [391.1367992906057, 248.1357606809063],
    ],
  },
  400: {
    sumX: 27293.70214065636,
    sumY: 25730.117228445415,
    probes: [
      [304.9124518945929, 558.3388398409746],
      [609.0719536289914, 462.5935490251786],
      [348.4666075872832, 430.9251488198751],
      [276.6781361096943, 80.28314446254875],
      [293.88024768316376, 169.69168868066373],
    ],
  },
};

function fingerprint(layout: BrainLayout): Fingerprint {
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < layout.x.length; i += 1) {
    sumX += layout.x[i]!;
    sumY += layout.y[i]!;
  }
  return { sumX, sumY, probes: PROBES.map((i) => [layout.x[i]!, layout.y[i]!]) };
}

describe('the force simulation', () => {
  it('still moves every node the way the original loop did', () => {
    const data = vault(80, 20260911);
    const graph = buildGraph(data);

    // The original starting ring by array index, handed in as remembered
    // positions. It keeps the seeding out of this test on purpose: a change to
    // where nodes *start* belongs to the layout tests, not to this one.
    const start = new Map(
      data.nodes.map((n, i) => {
        const angle = (i / data.nodes.length) * Math.PI * 2;
        const radius = 40 + (i % 6) * 24;
        return [nodeKey(n.owner, n.path), { x: W / 2 + Math.cos(angle) * radius, y: H / 2 + Math.sin(angle) * radius }];
      }),
    );
    const layout = new BrainLayout(graph, W, H, start);
    expect(graph.edges.length).toBe(116);

    const seen: Record<number, Fingerprint> = {};
    for (let t = 1; t <= 400; t += 1) {
      // Held by the pointer, set directly as the old handler did — not through
      // `place()`, whose clamp is newer than the reference.
      if (t === 120) {
        layout.pinned = 3;
        layout.x[3] = 310;
        layout.y[3] = 260;
      }
      if (t === 180) layout.pinned = -1;
      if (t === 220) layout.resize(W * 0.7, H * 0.9);
      layout.step();
      if (t in REFERENCE) seen[t] = fingerprint(layout);
    }

    for (const [t, want] of Object.entries(REFERENCE)) {
      const got = seen[Number(t)]!;
      expect(got.sumX, `sum of x at step ${t}`).toBeCloseTo(want.sumX, 6);
      expect(got.sumY, `sum of y at step ${t}`).toBeCloseTo(want.sumY, 6);
      want.probes.forEach(([x, y], k) => {
        expect(got.probes[k]![0], `node ${PROBES[k]} x at step ${t}`).toBeCloseTo(x, 6);
        expect(got.probes[k]![1], `node ${PROBES[k]} y at step ${t}`).toBeCloseTo(y, 6);
      });
    }
  });
});
