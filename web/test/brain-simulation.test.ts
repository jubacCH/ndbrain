// @vitest-environment node
/**
 * The simulation, pinned to frozen numbers.
 *
 * **This reference replaced an older one on purpose.** Until phase 3 of the
 * brain redesign the numbers here were produced by the `step()` of commit
 * 8c3c1db — the loop that lived inside `Brain.tsx` — and the refactored layout
 * reproduced them bit for bit. Phase 3 changed the simulation deliberately: an
 * own world instead of the viewport, clusters with regions, cohesion,
 * placement and containment, a temperature that brings it to rest. None of the
 * old numbers could survive that, and keeping them would have meant keeping the
 * old loop. They were replaced in the same commit that changed the simulation,
 * after the new picture had been looked at.
 *
 * Why still frozen numbers, when `brain-form.test.ts` measures the behaviour?
 * Because behaviour tests have tolerances wide enough for the next person to
 * change a constant without noticing. Barnes-Hut will replace the repulsion
 * loop; whoever does it has to know whether they changed the approximation they
 * meant to change or, by accident, a spring. A copy of the loop next to the
 * code would be edited along with it; numbers cannot be.
 *
 * The scenario covers the ways the loop is driven in the app: a fresh layout
 * cooling down, a note picked up and moved, and let go.
 *
 * Compared to six decimals rather than exactly. V8's trigonometry has been
 * stable for years, but a test that fails on a runtime upgrade would teach
 * people to update the numbers without looking — and any real change to a force
 * shows up as whole units within a few dozen steps, far above that tolerance.
 *
 * **When this fails on purpose** — Barnes-Hut, a new force, a retuned constant —
 * the numbers are meant to be replaced. Say so in the commit, and look at the
 * picture first.
 */

import { describe, expect, it } from 'vitest';

import { BrainLayout } from '../src/brain/layout';
import { buildGraph } from '../src/brain/model';
import { paraVault, shuffled } from './fixtures/para-vault';

const PROBES = [0, 17, 42, 77, 108];

interface Fingerprint {
  sumX: number;
  sumY: number;
  probes: Array<[number, number]>;
}

/** Produced by this commit's `step()`; see the header before changing any of it. */
const REFERENCE: Record<number, Fingerprint> = {
  50: {
    sumX: 4179.391316696708,
    sumY: 2403.0733679265254,
    probes: [
      [-98.95199201889464, -248.1442611931106],
      [-464.73931668820813, -106.59896033116065],
      [164.44043619998416, -85.78217711430734],
      [365.1015159713861, 337.4062922921136],
      [274.06909650217705, -291.2018297217238],
    ],
  },
  160: {
    sumX: 4831.9755563206745,
    sumY: 2980.631143228091,
    probes: [
      [-90.1387537510175, -223.50404136724896],
      [-464.16409097901385, -95.7345654357586],
      [146.69097619524885, -111.21923788795532],
      [389.2137801673563, 313.38122142398936],
      [289.68374745445647, -312.8187949457619],
    ],
  },
  400: {
    sumX: 4901.3819851542485,
    sumY: 3209.7427664660686,
    probes: [
      [-88.99506502556792, -222.0992096388492],
      [-462.4753864432969, -86.86084566054316],
      [136.3595716044445, -113.41328310140861],
      [399.9871392859241, 298.60078386597644],
      [296.3248355548215, -312.50159039698946],
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

/** Runs the scenario and returns fingerprints at the steps the reference names. */
function run(layout: BrainLayout, at: number[]): Record<number, Fingerprint> {
  const seen: Record<number, Fingerprint> = {};
  for (let t = 1; t <= Math.max(...at); t += 1) {
    if (t === 120) {
      layout.hold(3);
      layout.place(3, layout.x[3]! + 90, layout.y[3]! - 40);
    }
    if (t === 180) layout.release();
    layout.step();
    if (at.includes(t)) seen[t] = fingerprint(layout);
  }
  return seen;
}

describe('the force simulation', () => {
  it('still moves every node the way it did when these numbers were frozen', () => {
    const { data } = paraVault();
    const seen = run(new BrainLayout(buildGraph(data), { arrangement: 'brain' }), [50, 160, 400]);
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

  it('lays out the same vault identically whatever order the server listed it in', () => {
    // Not "close": every force is summed in key order, so a reshuffled reply
    // gives the same arithmetic in the same order. A tolerance here would hide
    // the day somebody loops over the server's order again, and a force layout
    // amplifies a rounding difference into a visibly different brain.
    const { data } = paraVault();
    const a = new BrainLayout(buildGraph(data), { arrangement: 'brain' });
    a.settle();
    for (const seed of [1, 2]) {
      const b = new BrainLayout(buildGraph(shuffled(data, seed)), { arrangement: 'brain' });
      b.settle();
      for (let i = 0; i < a.x.length; i += 1) {
        const j = b.graph.index.get(a.graph.nodes[i]!.key)!;
        expect(b.x[j]).toBe(a.x[i]);
        expect(b.y[j]).toBe(a.y[i]);
      }
    }
  });
});
