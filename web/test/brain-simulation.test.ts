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
 * **Replaced a fourth time in phase 4**, and the largest change of the four.
 * The simulation stopped placing the notes at all: the outline is divided into
 * a cell per region, each cell filled with places, and every note put on one
 * (`layout.ts`). What is left here is a fine correction, and it had to be
 * retuned around that — a much weaker and shorter-ranged repulsion, since the
 * places do the spreading now and the old one pushed the galaxies back apart; a
 * link inside a region resting at a step between the places of its cell rather
 * than at a fixed seventy units; the placement force gone, since a cell is
 * where a region is; and a hard wall at the rim, because a force scaled by a
 * temperature that falls to zero cannot hold an outline. The outline itself
 * changed shape as well. Not one of the old numbers could survive any of that.
 * They were replaced after the new picture had been looked at in the browser.
 *
 * **And a fifth time with the galaxies**: the notes of a region gather into one
 * to three star clusters instead of spreading over its cell, a link inside a
 * region rests at a step of a cluster, the repulsion shrank again to what keeps
 * two cell bodies apart, the fresh layout cools from a lower temperature so the
 * clusters are not shaken open, and a region is at least eight notes. Every
 * position changed; the picture was compared against the prototype first.
 *
 * **A sixth time for the journal and the centre.** The cells are relaxed around
 * a lobe reserved for the journal, the best-connected map is placed at the
 * fissure and held there in a fresh layout, and two points of a cell at the
 * same distance from a core no longer go to whichever the rounding of a brain
 * one note larger favoured. The fixture has no daily notes, but every cell of
 * the left hemisphere moved.
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
    sumX: 1991.025078338326,
    sumY: -1199.2228010233616,
    probes: [
      [265.287559777276, -148.42909018167921],
      [239.66865502393858, -145.9998644584116],
      [-191.14498992473713, 224.0805721629664],
      [12.102528175791987, -15.5519899615419],
      [-51.52130740378483, -180.14721746902285],
    ],
  },
  160: {
    sumX: 2003.5808045851325,
    sumY: -1281.7558288086518,
    probes: [
      [265.1556738746585, -146.86357796063785],
      [239.63241905292918, -146.45999245584585],
      [-185.34786110278736, 211.18544152782235],
      [12.102528175791987, -16.196891070652157],
      [-56.53289755941869, -180.21561192560293],
    ],
  },
  400: {
    sumX: 2006.0171145319762,
    sumY: -1276.1787032624916,
    probes: [
      [265.1556738746585, -146.86357796063785],
      [239.63241905292918, -146.45999245584585],
      [-185.34786110278736, 211.18544152782235],
      [12.102528175791987, -16.196891070652157],
      [-56.53289755941869, -180.21561192560293],
    ],
  },
};

/** Produced by the same commit as `REFERENCE`, for the capture scenario. */
const REFERENCE_CAPTURE: Record<number, Fingerprint> = {
  10: {
    sumX: 1964.2907285360172,
    sumY: -1274.4597158066335,
    probes: [
      [52.83526327769669, -18.019927545639444],
      [39.81974863171523, 7.734117051044843],
      [265.1114001325405, -146.30678085973304],
      [257.8726655627495, 92.23553917233815],
      [83.6157843532682, -103.58194593307944],
    ],
  },
  60: {
    sumX: 1969.22562492362,
    sumY: -1280.919690326403,
    probes: [
      [59.71334336125457, -25.238616625017816],
      [37.87656493576016, 8.492831610653742],
      [265.1114001325405, -146.30678085973304],
      [257.8726655627495, 92.23553917233815],
      [83.6157843532682, -103.58194593307944],
    ],
  },
  300: {
    sumX: 1971.203274441539,
    sumY: -1282.9606445496954,
    probes: [
      [61.64028838056386, -27.23776734431277],
      [37.927269434369784, 8.451028106656189],
      [265.1114001325405, -146.30678085973304],
      [257.8726655627495, 92.23553917233815],
      [83.6157843532682, -103.58194593307944],
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
      nodes: [...data.nodes, { owner: 'jb', path, title: 'captured', folder: hub.folder, links: 1, tags: [], updatedAt: 0 }],
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
