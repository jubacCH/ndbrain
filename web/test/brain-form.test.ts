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
  const { x, y, r, unitLength: u, graph } = layout;
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

  // Cohesion: for every cluster of four or more, the mean distance of its notes
  // to its own centre, against the distance from that centre to the nearest
  // other cluster's centre.
  const centres = graph.clusters.clusters.map((c) => {
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
    // Nine in ten (this vault: 96 %). Soft means soft: a note pulled hard by its links may lean
    // past the rim, and that is the notes shaping the outline, not a leak.
    expect(form.inside).toBeGreaterThanOrEqual(0.9);
  });

  it('leaves the fissure empty', () => {
    // At most two notes of 109 in the gap between the hemispheres. Any more and
    // the eye stops seeing two halves.
    expect(form.inFissure).toBeLessThanOrEqual(2);
  });

  it('uses both hemispheres', () => {
    // The anchors split the vault in half by path; clusters shift that (this
    // vault: 41 % left), but neither side may hold less than a third.
    expect(form.leftShare).toBeGreaterThan(1 / 3);
    expect(form.leftShare).toBeLessThan(2 / 3);
  });

  it('is wider than tall, in about the proportion of the outline', () => {
    // The outline is 1.31 : 1; this vault's notes span 1.38 : 1.
    const outline = (OUTLINE.maxX - OUTLINE.minX) / (OUTLINE.maxY - OUTLINE.minY);
    expect(form.aspect).toBeGreaterThan(outline * 0.85);
    expect(form.aspect).toBeLessThan(outline * 1.2);
  });

  it('reaches out to the outline instead of huddling in the middle', () => {
    // The notes span at least four fifths of the outline in both directions
    // (this vault: all of it across, 98 % top to bottom).
    expect(form.reachX).toBeGreaterThan(0.8);
    expect(form.reachY).toBeGreaterThan(0.8);
  });

  it('is made of clusters, not of dots scattered inside a silhouette', () => {
    // Scattered uniformly inside the outline, the same notes give a ratio far
    // above one (about 8 on this vault): every cluster's centre lands near the
    // middle of the brain, next to every other cluster's, while its notes are
    // spread over the whole outline. Grown from regions, a cluster's notes sit
    // closer to their own centre than that centre is to the next region (0.4 on
    // this vault). Below 0.6 is unmistakably regions; the scatter must stay
    // above 2 for the comparison to mean anything.
    const mask = measure(scattered(settled(data)));
    expect(mask.cohesion).toBeGreaterThan(2);
    expect(form.cohesion).toBeLessThan(0.6);
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
    expect(Math.hypot(layout.x[hub]!, layout.y[hub]!)).toBeLessThan(25);
    for (let i = 0; i < layout.x.length; i += 1) {
      if (i === hub) continue;
      const d = Math.hypot(layout.x[i]! - layout.x[hub]!, layout.y[i]! - layout.y[hub]!);
      expect(d).toBeGreaterThan(40);
      expect(d).toBeLessThan(140);
    }
  });
});

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

  it('moves the existing notes only minimally when a note is captured and linked', { timeout: 30_000 }, () => {
    // Briefing 47, across every fifth possible link target. What counts is
    // the mean displacement of the 109 notes that were already there.
    //
    // Threshold: 8 world units — less than the radius of a note with one link,
    // so on the overview an average note moves by less than its own size. The
    // real vault's copy measures at most 4 to 6; most captures under 1, because
    // only the new note, the note it links to and that note's neighbours may move
    // at all.
    const { data } = paraVault();
    const before = settled(data);
    const remembered = before.positions();
    const means: number[] = [];
    data.nodes.forEach((target, k) => {
      if (k % 5 !== 0) return;
      const grown: GraphData = {
        nodes: [...data.nodes, { owner: 'jb', path: '00_Inbox/captured.md', title: 'captured', folder: '00_Inbox', links: 1 }],
        edges: [...data.edges, { owner: 'jb', from: '00_Inbox/captured.md', to: target.path }],
      };
      const after = settled(grown, remembered);
      let sum = 0;
      for (const [key, at] of remembered) {
        const i = after.graph.index.get(key)!;
        const moved = Math.hypot(after.x[i]! - at.x, after.y[i]! - at.y);
        sum += moved;
        // Nothing that is neither the target nor next to it moves at all.
        const nearTarget =
          key === nodeKey('jb', target.path) ||
          after.graph.touching[i]!.some((e) => {
            const edge = after.graph.edges[e]!;
            return after.graph.nodes[edge.a === i ? edge.b : edge.a]!.path === target.path;
          });
        if (!nearTarget) expect(moved, key).toBe(0);
      }
      means.push(sum / remembered.size);
    });
    means.sort((a, b) => a - b);
    expect(means[means.length - 1]!).toBeLessThan(8);
    expect(means[Math.floor(means.length / 2)]!).toBeLessThan(1.5);
  });

  it('starts the captured note beside what it links to', () => {
    const { data } = paraVault();
    const before = settled(data);
    const grown: GraphData = {
      nodes: [...data.nodes, { owner: 'jb', path: '00_Inbox/captured.md', title: 'captured', folder: '00_Inbox', links: 1 }],
      edges: [...data.edges, { owner: 'jb', from: '00_Inbox/captured.md', to: '20_Areas/21_Homelab/Firewall.md' }],
    };
    const after = new Layout(buildGraph(grown), { arrangement: 'brain', remembered: before.positions() });
    const fresh = after.graph.index.get(nodeKey('jb', '00_Inbox/captured.md'))!;
    const anchor = after.graph.index.get(nodeKey('jb', '20_Areas/21_Homelab/Firewall.md'))!;
    expect(Math.hypot(after.x[fresh]! - after.x[anchor]!, after.y[fresh]! - after.y[anchor]!)).toBeCloseTo(18, 6);
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
