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
 * after the new picture had been looked at. They were replaced again when a
 * held note stopped freeing the whole brain and started freeing only its
 * neighbours: the scenario holds a note, so the numbers after step 120 changed.
 * And a third time in the same fix round, when regions stopped being pushed
 * apart by a relaxation and started being laid out one by one from their own
 * anchors: every number changed. The second fingerprint, a capture absorbed
 * from memory, was added then.
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
import { buildGraph, nodeKey } from '../src/brain/model';
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
    sumX: -3004.4558344963925,
    sumY: 5182.460267541687,
    probes: [
      [-217.23292345811637, -167.0410239980868],
      [-242.66953380152447, -324.79703195195975],
      [-120.34096582137055, 282.9273915822814],
      [270.521579694675, 358.2856259189161],
      [156.9021917492451, -73.4222995291639],
    ],
  },
  160: {
    sumX: -3007.3065813446856,
    sumY: 5307.974421988907,
    probes: [
      [-209.14232527592483, -162.44994644059764],
      [-233.78539096492807, -322.03609663138707],
      [-113.39178085255813, 276.21894449224305],
      [267.91033646603046, 362.04862766318536],
      [157.31578600055937, -63.971466541165455],
    ],
  },
  400: {
    sumX: -3009.261339222977,
    sumY: 5306.479667713254,
    probes: [
      [-209.14232527592483, -162.44994644059764],
      [-233.78539096492807, -322.03609663138707],
      [-113.39178085255813, 276.21894449224305],
      [267.91033646603046, 362.04862766318536],
      [157.31578600055937, -63.971466541165455],
    ],
  },
};

/** Produced by the same commit as `REFERENCE`, for the capture scenario. */
const REFERENCE_CAPTURE: Record<number, Fingerprint> = {
  10: {
    sumX: -2811.415670255993,
    sumY: 5625.661065930227,
    probes: [
      [333.16142769077203, 172.2285699947261],
      [284.8688009921271, 198.43478863935886],
      [-203.94424270754695, -162.45868075947593],
      [-397.04086380925077, 189.9444833027186],
      [253.9879561684412, 134.94517758375133],
    ],
  },
  60: {
    sumX: -2797.216796147464,
    sumY: 5619.628022351829,
    probes: [
      [346.1304601739454, 167.27920305059249],
      [286.0986426174831, 197.3511120050941],
      [-203.94424270754695, -162.45868075947593],
      [-397.04086380925077, 189.9444833027186],
      [253.9879561684412, 134.94517758375133],
    ],
  },
  300: {
    sumX: -2792.217674942781,
    sumY: 5619.706471631441,
    probes: [
      [350.98345854485797, 167.39908376384957],
      [286.24476545125395, 197.3096805714494],
      [-203.94424270754695, -162.45868075947593],
      [-397.04086380925077, 189.9444833027186],
      [253.9879561684412, 134.94517758375133],
    ],
  },
};

function fingerprint(layout: BrainLayout, probes: number[] = PROBES): Fingerprint {
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < layout.x.length; i += 1) {
    sumX += layout.x[i]!;
    sumY += layout.y[i]!;
  }
  return { sumX, sumY, probes: probes.map((i) => [layout.x[i]!, layout.y[i]!]) };
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

  it('places a captured note from memory the way it did when these numbers were frozen', () => {
    // The second way the loop runs in the app: a remembered brain absorbing a
    // note captured since. Few notes may move here, so a regression in who may
    // move — or in the tether on the note linked to — shows up in these
    // numbers even where the fresh scenario above would not notice.
    const { data } = paraVault();
    const first = new BrainLayout(buildGraph(data), { arrangement: 'brain' });
    first.settle();
    const hub = first.graph.nodes[first.graph.hub]!;
    const path = `${hub.folder}/zz captured.md`;
    const grown = buildGraph({
      nodes: [...data.nodes, { owner: 'jb', path, title: 'captured', folder: hub.folder, links: 1 }],
      edges: [...data.edges, { owner: 'jb', from: path, to: hub.path }],
    });
    const layout = new BrainLayout(grown, { arrangement: 'brain', remembered: first.positions() });
    const seen: Record<number, Fingerprint> = {};
    for (let t = 1; t <= 300; t += 1) {
      layout.step();
      if (t === 10 || t === 60 || t === 300) {
        seen[t] = fingerprint(layout, [grown.index.get(nodeKey('jb', path))!, grown.index.get(nodeKey('jb', hub.path))!, 0, 50, 100]);
      }
    }
    for (const [t, want] of Object.entries(REFERENCE_CAPTURE)) {
      const got = seen[Number(t)]!;
      expect(got.sumX, `sum of x at step ${t}`).toBeCloseTo(want.sumX, 6);
      expect(got.sumY, `sum of y at step ${t}`).toBeCloseTo(want.sumY, 6);
      want.probes.forEach(([x, y], k) => {
        expect(got.probes[k]![0], `probe ${k} x at step ${t}`).toBeCloseTo(x, 6);
        expect(got.probes[k]![1], `probe ${k} y at step ${t}`).toBeCloseTo(y, 6);
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
