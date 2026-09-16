// @vitest-environment node
/**
 * The brain, measured.
 *
 * "It looks like a brain" is not something a test can say, so this file says
 * several smaller things that together are hard to fake:
 *
 *  - the notes stay inside the outline, allowing a cell body to overlap it;
 *  - the fissure between the hemispheres is empty;
 *  - both hemispheres carry a fair share of the vault;
 *  - the whole is wider than tall, in the proportion of the outline;
 *  - the notes reach the outline, rather than huddling in the middle of it;
 *  - and — the one that tells a brain grown from clusters from dots scattered
 *    into a silhouette — a cluster's notes are much nearer each other than
 *    they are to the next cluster.
 *
 * Plus the promises that make the shape usable: it holds still when nothing
 * changed, moves only locally when something did, comes to rest, and ignores
 * the window entirely.
 *
 * All of it runs on the fixture vault with the real vault's proportions (109
 * notes in PARA folders, about 270 linked pairs, maps of content, orphans).
 * The thresholds are set with margin against what that vault measures; each
 * says why it sits where it does.
 */

import { describe, expect, it } from 'vitest';

import type { GraphData } from '../src/api';
import type { BrainLayout } from '../src/brain/layout';
import { BrainLayout as Layout } from '../src/brain/layout';
import { buildGraph, nodeKey } from '../src/brain/model';
import { FISSURE, OUTLINE, angleOf, reach, rim } from '../src/brain/shape';
import { paraVault } from './fixtures/para-vault';

function settled(data: GraphData, remembered?: ReturnType<BrainLayout['positions']>): BrainLayout {
  const layout = new Layout(buildGraph(data), { arrangement: 'brain', remembered });
  layout.settle();
  return layout;
}

interface Form {
  inside: number;
  inFissure: number;
  leftShare: number;
  aspect: number;
  reachX: number;
  reachY: number;
  cohesion: number;
}

function measure(layout: BrainLayout): Form {
  const { x, y, r, unitLength: u } = layout;
  const n = x.length;
  let inside = 0;
  let inFissure = 0;
  let left = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const side = x[i]! < 0 ? -1 : 1;
    // A cell body may lie across the line: its centre counts as inside while it
    // is within its own radius of the rim.
    const edge = rim(side, angleOf(side, x[i]! / u, y[i]! / u)) * u;
    if (reach(side, x[i]! / u, y[i]! / u) <= 1 + r[i]! / edge) inside += 1;
    if (Math.abs(x[i]!) < FISSURE * u) inFissure += 1;
    if (side < 0) left += 1;
    minX = Math.min(minX, x[i]!);
    maxX = Math.max(maxX, x[i]!);
    minY = Math.min(minY, y[i]!);
    maxY = Math.max(maxY, y[i]!);
  }

  // Cohesion: for every region of four or more, the mean distance of its notes
  // to its own centre, against the distance from that centre to the nearest
  // other region's centre.
  const centres = layout.regions.map((c) => {
    let sx = 0;
    let sy = 0;
    for (const i of c.members) {
      sx += x[i]!;
      sy += y[i]!;
    }
    return { x: sx / c.members.length, y: sy / c.members.length, members: c.members };
  });
  let ratio = 0;
  let counted = 0;
  centres.forEach((c, k) => {
    if (c.members.length < 4) return;
    let spread = 0;
    for (const i of c.members) spread += Math.hypot(x[i]! - c.x, y[i]! - c.y);
    spread /= c.members.length;
    let nearest = Infinity;
    centres.forEach((o, j) => {
      if (j !== k) nearest = Math.min(nearest, Math.hypot(o.x - c.x, o.y - c.y));
    });
    ratio += spread / nearest;
    counted += 1;
  });

  return {
    inside: inside / n,
    inFissure,
    leftShare: left / n,
    aspect: (maxX - minX) / (maxY - minY),
    reachX: (maxX - minX) / ((OUTLINE.maxX - OUTLINE.minX) * u),
    reachY: (maxY - minY) / ((OUTLINE.maxY - OUTLINE.minY) * u),
    cohesion: ratio / counted,
  };
}

/** The same vault with its note coordinates scattered uniformly inside the outline. */
function scattered(layout: BrainLayout): BrainLayout {
  const u = layout.unitLength;
  let s = 99;
  const rnd = (): number => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < layout.x.length; i += 1) {
    for (;;) {
      const px = OUTLINE.minX + rnd() * (OUTLINE.maxX - OUTLINE.minX);
      const py = OUTLINE.minY + rnd() * (OUTLINE.maxY - OUTLINE.minY);
      if (Math.abs(px) < FISSURE || reach(px < 0 ? -1 : 1, px, py) > 1) continue;
      layout.x[i] = px * u;
      layout.y[i] = py * u;
      break;
    }
  }
  return layout;
}

describe('the shape', () => {
  const { data } = paraVault();
  const form = measure(settled(data));

  it('keeps the notes inside the outline', () => {
    // Nine in ten (this vault: 94 %). Soft means soft: a note pulled hard by
    // its links may lean past the rim, and that is the notes shaping the
    // outline, not a leak.
    expect(form.inside).toBeGreaterThanOrEqual(0.9);
  });

  it('leaves the fissure empty', () => {
    // At most two notes of 109 in the gap between the hemispheres. Any more and
    // the eye stops seeing two halves.
    expect(form.inFissure).toBeLessThanOrEqual(2);
  });

  it('uses both hemispheres', () => {
    // Folders are shared between the hemispheres by weight, and clusters shift
    // that (this vault: 59 % left), but neither side may hold less than a third.
    expect(form.leftShare).toBeGreaterThan(1 / 3);
    expect(form.leftShare).toBeLessThan(2 / 3);
  });

  it('is wider than tall, in about the proportion of the outline', () => {
    // The outline is 1.11 : 1 since phase 4 (it was 1.42 : 1); this vault's
    // notes span 1.35 : 1. A little wider than the outline, and it has to be:
    // the medial rim is nearly vertical, so the cells reach the full width of
    // the brain, while at the top and bottom the rim curves away and the
    // outermost place is short of it. The bound allows a quarter over.
    const outline = (OUTLINE.maxX - OUTLINE.minX) / (OUTLINE.maxY - OUTLINE.minY);
    expect(form.aspect).toBeGreaterThan(outline * 0.85);
    expect(form.aspect).toBeLessThan(outline * 1.25);
  });

  it('reaches out to the outline instead of huddling in the middle', () => {
    // Three quarters of the outline in both directions; measured on this vault:
    // 0.86 across and 0.79 down.
    //
    // It was four fifths while the repulsion was what spread the notes: it
    // reached across a region and pressed them into the rim, so they ended up
    // against it everywhere. Since phase 4 a note sits on a place of its cell,
    // the outermost places of a cell are often left free — a leaf takes the free
    // place nearest its core — and at the top and bottom of the outline the rim
    // is a ripple peak that a grid of places rarely lands on. The last tenth is
    // drawn by the decoration, which has the outline itself (`depthInside`).
    expect(form.reachX).toBeGreaterThan(0.75);
    expect(form.reachY).toBeGreaterThan(0.75);
  });

  it('puts every note inside the silhouette, by the test the decoration clips against', () => {
    // Since phase 4 the outline is the container rather than a soft wall, so
    // this is not "nine in ten" any more: `inside` is the contract the renderer
    // clips its decoration against, and a note outside it would be a note in a
    // part of the picture that is not drawn.
    const layout = settled(data);
    for (let i = 0; i < layout.x.length; i += 1) {
      expect(layout.inside(layout.x[i]!, layout.y[i]!), layout.graph.nodes[i]!.key).toBe(true);
      expect(layout.depthInside(layout.x[i]!, layout.y[i]!)).toBeGreaterThan(0);
    }
    // And the measure is signed: outside is negative, and the middle of a
    // hemisphere is deeper in than a point by the rim.
    const u = layout.unitLength;
    expect(layout.inside(OUTLINE.maxX * u * 1.5, 0)).toBe(false);
    expect(layout.depthInside(OUTLINE.maxX * u * 1.5, 0)).toBeLessThan(0);
    expect(layout.depthInside(-0.575 * u, 0)).toBeGreaterThan(layout.depthInside(-1.05 * u, 0));

    // The fissure is outside, at every height. Without this the renderer's fog,
    // dust and dendrites — which clip against `inside` — would run into the gap
    // between the halves and close it.
    for (const at of [-0.8, -0.4, 0, 0.4, 0.8]) {
      expect(layout.inside(0, at * u), `the middle at y = ${at}`).toBe(false);
      expect(layout.depthInside(0, at * u)).toBeLessThan(0);
    }
    // Depth is a world length, not a normalised one: a note sitting a spring's
    // length inside the rim is that many world units deep, not a fraction.
    expect(layout.depthInside(-0.575 * u, 0)).toBeGreaterThan(REST_OF_A_SPRING);
  });

  it('spreads the notes over the whole outline rather than over a part of it', () => {
    // The evenness of the fill, as the share of empty cells in a grid over the
    // inside of the outline whose cells are about one note's worth of area.
    // Measured on this vault: 14 %. Well under a third means the notes are
    // spread over the shape; the gaps that remain are the dark space between
    // the star clusters, which is what the decoration is drawn into.
    const layout = settled(data);
    const step = Math.sqrt(4200) * 1.6;
    const { minX, minY, maxX, maxY } = layout.bounds;
    const all = new Set<string>();
    const taken = new Set<string>();
    for (let a = 0; a * step < maxX - minX; a += 1) {
      for (let b = 0; b * step < maxY - minY; b += 1) {
        if (layout.inside(minX + (a + 0.5) * step, minY + (b + 0.5) * step)) all.add(`${a}:${b}`);
      }
    }
    for (let i = 0; i < layout.x.length; i += 1) {
      taken.add(`${Math.floor((layout.x[i]! - minX) / step)}:${Math.floor((layout.y[i]! - minY) / step)}`);
    }
    let empty = 0;
    for (const cell of all) if (!taken.has(cell)) empty += 1;
    expect(all.size).toBeGreaterThan(30);
    expect(empty / all.size).toBeLessThan(1 / 3);
  });

  it('is made of clusters, not of dots scattered inside a silhouette', () => {
    // Scattered uniformly inside the outline, the same notes give a ratio far
    // above one (about 8 on this vault): every cluster's centre lands near the
    // middle of the brain, next to every other cluster's, while its notes are
    // spread over the whole outline. Grown from regions, a cluster's notes sit
    // about as far from their centre as that centre is from the next region's
    // (1.2 on this vault): regions that touch, not a scatter. The first version
    // measured 0.4 because a relaxation pushed regions apart — and that
    // relaxation was what made one capture move regions across the brain. The
    // bound of 1.6 keeps a clear distance to a scatter.
    const mask = measure(scattered(settled(data)));
    expect(mask.cohesion).toBeGreaterThan(4);
    expect(form.cohesion).toBeLessThan(1.6);
  });
});

describe('the loose arrangement', () => {
  it('lays a neighbourhood out as a loose cluster around its middle, not as a brain', () => {
    const star: GraphData = {
      nodes: ['hub', 'a', 'b', 'c', 'd', 'e'].map((name) => ({ owner: 'jb', path: `${name}.md`, title: name, folder: '', links: 1 })),
      edges: ['a', 'b', 'c', 'd', 'e'].map((name) => ({ owner: 'jb', from: 'hub.md', to: `${name}.md` })),
    };
    const layout = new Layout(buildGraph(star), { arrangement: 'loose' });
    layout.settle();
    const hub = layout.graph.index.get(nodeKey('jb', 'hub.md'))!;
    // The hub in the middle, the leaves around it at about a spring's length.
    expect(Math.hypot(layout.x[hub]!, layout.y[hub]!)).toBeLessThan(40);
    for (let i = 0; i < layout.x.length; i += 1) {
      if (i === hub) continue;
      const d = Math.hypot(layout.x[i]! - layout.x[hub]!, layout.y[i]! - layout.y[hub]!);
      expect(d).toBeGreaterThan(40);
      expect(d).toBeLessThan(140);
    }
  });
});

/** The vault plus a note captured into the folder of `target`, linked to it. */
function capturedInto(data: GraphData, target: GraphData['nodes'][number]): GraphData {
  const folder = target.folder;
  const path = `${folder === '' ? '' : `${folder}/`}zz captured.md`;
  return {
    nodes: [...data.nodes, { owner: target.owner, path, title: 'captured', folder, links: 1 }],
    edges: [...data.edges, { owner: target.owner, from: path, to: target.path }],
  };
}

/** A link's rest length, in world units: the scale "a world unit" is measured in. */
const REST_OF_A_SPRING = 70;

const quantile = (values: number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

describe('holding still', () => {
  it('does not move a single note when the same vault is laid out again from memory', () => {
    // A reload, or a refetch after an edit that changed no link.
    const { data } = paraVault();
    const first = settled(data);
    const again = new Layout(buildGraph(data), { arrangement: 'brain', remembered: first.positions() });
    expect(again.settled).toBe(true);
    for (let i = 0; i < first.x.length; i += 1) {
      expect(again.x[again.graph.index.get(first.graph.nodes[i]!.key)!]).toBe(first.x[i]);
    }
  });

  it('moves only the note a capture links to, and that only a little, for every possible target', { timeout: 60_000 }, () => {
    // Briefing 47, from memory, over all 109 possible targets — the hub
    // included, which is where a warm restart used to set forty neighbours
    // moving. Every note but the target stays exactly where it was. The target
    // makes room for the newcomer, held back by its tether.
    //
    // Bounds: 90 % of targets move less than 25 units and none more than 50 —
    // a third and three quarters of a spring's rest length, so the target never
    // leaves the place its links define. Measured on this vault: at most ~42.
    // (Phase 3 measured ~11 against bounds of 20 and 40. The target is pushed a
    // little harder now: it is inside a cell and out of the fissure, and both
    // are forces the note it makes room for did not feel before.)
    const { data } = paraVault();
    const before = settled(data);
    const remembered = before.positions();
    const moves: number[] = [];
    const hub = data.nodes.find((n) => nodeKey(n.owner, n.path) === before.graph.nodes[before.graph.hub]!.key)!;
    const targets = [hub, ...data.nodes];
    for (const target of targets) {
      const after = settled(capturedInto(data, target), remembered);
      const key = nodeKey(target.owner, target.path);
      for (const [other, at] of remembered) {
        const i = after.graph.index.get(other)!;
        const moved = Math.hypot(after.x[i]! - at.x, after.y[i]! - at.y);
        if (other === key) moves.push(moved);
        else expect(moved, `${other} after a capture onto ${target.path}`).toBe(0);
      }
    }
    expect(moves[0]!, 'the hub').toBeLessThan(50);
    expect(quantile(moves, 0.9)).toBeLessThan(25);
    expect(Math.max(...moves)).toBeLessThan(50);
  });

  it('starts the captured note beside what it links to', () => {
    const { data } = paraVault();
    const before = settled(data);
    const target = data.nodes.find((n) => n.path === '20_Areas/21_Homelab/Firewall.md')!;
    const after = new Layout(buildGraph(capturedInto(data, target)), { arrangement: 'brain', remembered: before.positions() });
    const fresh = after.graph.index.get(nodeKey('jb', '20_Areas/21_Homelab/zz captured.md'))!;
    const anchor = after.graph.index.get(nodeKey('jb', target.path))!;
    // About where the spring between them would hold it, so neither has to
    // travel to make room.
    expect(Math.hypot(after.x[fresh]! - after.x[anchor]!, after.y[fresh]! - after.y[anchor]!)).toBeCloseTo(40, 6);
  });
});

describe('a capture on a device that remembers nothing', () => {
  // A new browser, the iPhone app, a cleared cache: the brain is laid out from
  // scratch, and it should still be the brain its owner knows.
  //
  // **This pair of tests replaced two from phase 3** ("keeps the anchor of every
  // cluster the capture did not touch" and "moves the notes of untouched
  // clusters only a little"). They measured the cluster, which is what decided a
  // note's place then; since phase 4 it is the region and its cell, and there is
  // no anchor at all. The promise they guarded is unchanged and is what these
  // measure: a capture changes the part of the brain it lands in and leaves the
  // rest of it alone.
  const { data } = paraVault();
  const before = settled(data);
  type Cell = BrainLayout['regions'][number];
  const keysOf = (layout: BrainLayout, members: readonly number[]): string =>
    members.map((i) => layout.graph.nodes[i]!.key).sort().join('|');

  /** Every possible capture, with the regions it left exactly as they were. */
  const was = new Map(before.regions.map((r) => [keysOf(before, r.members), r]));
  const runs = data.nodes.map((target) => {
    const after = settled(capturedInto(data, target));
    const kept = after.regions
      .map((now) => ({ now, then: was.get(keysOf(after, now.members)) }))
      .filter((pair): pair is { now: Cell; then: Cell } => pair.then !== undefined);
    return { after, kept };
  });
  /**
   * A capture that changed nothing but the region it landed in, *and* did not
   * push that region across a doubling of its note count.
   *
   * The second half is designed in and is the same exception the folder arcs
   * made before regions existed: a cell's share of its hemisphere is one plus
   * one for every doubling of the notes in it, so a region going from fifteen
   * notes to sixteen claims a wider cell and its neighbours give way. Not in
   * proportion to the notes, on purpose — that way every capture would move
   * every cell.
   */
  const doubles = (kept: Array<{ now: Cell; then: Cell }>, after: BrainLayout): boolean =>
    after.regions.some((now) => {
      if (kept.some((pair) => pair.now === now)) return false;
      const n = now.members.length;
      return Math.floor(Math.log2(n)) !== Math.floor(Math.log2(n - 1));
    });
  const clean = runs.filter(
    ({ after, kept }) => after.regions.length === before.regions.length && kept.length === before.regions.length - 1,
  );
  /** Of those, the ones that did not push their region across a doubling. */
  const steady = clean.filter(({ after, kept }) => !doubles(kept, after));

  it('changes no region but the one it lands in, for at least three quarters of the possible captures', { timeout: 120_000 }, () => {
    // The rest are captures that tip a note's strongest tie somewhere and carry
    // a whole cluster into another region (`clusters.ts`); the clustering
    // underneath reassigns notes for about the same share of captures, so that
    // is what clustering costs, not something the region layer added. Measured
    // on this vault: 84 of 109.
    expect(clean.length).toBeGreaterThanOrEqual(Math.ceil(data.nodes.length * 0.75));
  });

  it('keeps the cell of every region it did not change, and moves their notes only a little', { timeout: 120_000 }, () => {
    // Cells compared in brain units: one more note grows the whole brain by half
    // a percent, the same for everything, and that is not a move. Most untouched
    // cells come out identical to the last digit; the exceptions are captures
    // that change which region is the connective one, and then that hemisphere's
    // cells are dealt again. None may move by half a brain unit — that would be
    // two regions changing places.
    const drift: number[] = [];
    const moved: number[] = [];
    for (const { after, kept } of steady) {
      for (const { now, then } of kept) {
        drift.push(
          Math.hypot(now.cx / after.unitLength - then.cx / before.unitLength, now.cy / after.unitLength - then.cy / before.unitLength),
        );
        for (const i of now.members) {
          const j = before.graph.index.get(after.graph.nodes[i]!.key);
          if (j === undefined) continue;
          moved.push(Math.hypot(after.x[i]! - before.x[j]!, after.y[i]! - before.y[j]!));
        }
      }
    }
    // Zero to the last bit the arithmetic can carry: the same cell computed in a
    // brain one note bigger comes out at the same normalised point.
    expect(steady.length).toBeGreaterThan(clean.length * 0.8);
    expect(Math.max(...drift)).toBeLessThan(1e-12);
    // And their notes: half move less than 5 units (under a cell body), nine in
    // ten less than 25 (a third of a spring), none more than 400. Measured on
    // this vault: see the numbers in the report of this phase.
    expect(quantile(moved, 0.5)).toBeLessThan(5);
    expect(quantile(moved, 0.9)).toBeLessThan(25);
    expect(Math.max(...moved)).toBeLessThan(400);
  });
});

describe('coming to rest', () => {
  it('lets the motion die away below a threshold and stay there', () => {
    // Mean squared speed per note under 0.01, i.e. a tenth of a unit per frame:
    // at 60 frames a second, less than six units a second, which on the
    // overview is under a pixel every few frames. It must get there within
    // 250 steps (about four seconds if it were animated) and never rise again.
    const { data } = paraVault();
    const layout = new Layout(buildGraph(data), { arrangement: 'brain' });
    let calm = -1;
    for (let t = 1; t <= 600; t += 1) {
      layout.step();
      const e = layout.energy();
      if (calm === -1 && e < 0.01) calm = t;
      if (calm !== -1) expect(e, `energy at step ${t}`).toBeLessThan(0.01);
    }
    expect(calm).toBeGreaterThan(0);
    expect(calm).toBeLessThanOrEqual(250);
    expect(layout.settled).toBe(true);
    expect(layout.step()).toBe(false);
  });

  it('wakes while a note is held and settles again once it is let go', () => {
    const { data } = paraVault();
    const layout = settled(data);
    layout.hold(5);
    layout.place(5, layout.x[5]! + 120, layout.y[5]!);
    for (let t = 0; t < 30; t += 1) expect(layout.step()).toBe(true);
    layout.release();
    const steps = layout.settle();
    expect(layout.settled).toBe(true);
    expect(steps).toBeLessThan(600);
  });
});
