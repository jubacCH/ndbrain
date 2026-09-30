// @vitest-environment node
/**
 * The journal and the centre, in the brain.
 *
 * Daily notes used to be clustered like any other note. Grouped by their first
 * two folders (`50_Journal/2026`), a year of them was a group well over twenty
 * and was cut in two — two "Journal" regions — and at three quarters of the
 * vault's notes they took most of the cells. Consecutive days formed short
 * chains that broke at every gap. These say what the journal is now: one
 * region, never cut, a lobe of fixed size whatever the number of days, the days
 * packed densely along a spiral by date, and the rest of the brain unmoved by
 * any of it.
 *
 * And the centre: the best-connected map sits at the fissure in the middle of
 * the brain, as in the target picture, with its region round it.
 *
 * Run on the fixture vault with the real vault's proportions, plus generated
 * daily notes: consecutive days with a few gaps, each linked to the day before
 * and after it that exists, and every fifth or ninth one to a note elsewhere.
 */

import { describe, expect, it } from 'vitest';

import { JOURNAL_ROOT, addDays, isDailyNote, journalPath } from '../../shared/journal';
import type { GraphData } from '../src/api';
import { MAP_DEGREE } from '../src/brain/edges';
import { BrainLayout } from '../src/brain/layout';
import { buildGraph, nodeKey } from '../src/brain/model';
import { FISSURE, OUTLINE, reach } from '../src/brain/shape';
import { paraVault } from './fixtures/para-vault';

const OWNER = 'jb';
const FIRST_DAY = { year: 2024, month: 3, day: 1 };

/** The fixture vault plus `count` daily notes, oldest first. */
function withDays(count: number, base: GraphData = paraVault().data): GraphData {
  const nodes = [...base.nodes];
  const edges = [...base.edges];
  const paths: string[] = [];
  // Every thirteenth day is skipped: a journal has gaps, and the chain of links
  // between days breaks at each one.
  for (let offset = 0; paths.length < count; offset += 1) {
    if (offset % 13 === 12) continue;
    const date = addDays(FIRST_DAY, offset);
    const path = journalPath(date);
    const folder = path.slice(0, path.lastIndexOf('/'));
    nodes.push({ owner: OWNER, path, title: path.slice(path.lastIndexOf('/') + 1, -3), folder, links: 0, tags: ['journal'], updatedAt: 0 });
    paths.push(path);
  }
  const exists = new Set(paths);
  paths.forEach((path, k) => {
    const next = paths[k + 1];
    // Only to a day that exists and is the next calendar day: the server does
    // not resolve a link to a day nobody wrote.
    if (next !== undefined && exists.has(next) && dayAfter(path) === next) {
      edges.push({ owner: OWNER, from: path, to: next });
      edges.push({ owner: OWNER, from: next, to: path });
    }
    if (k % 5 === 0) edges.push({ owner: OWNER, from: path, to: '10_Projects/11_Active/Project A.md' });
    if (k % 9 === 0) edges.push({ owner: OWNER, from: path, to: '20_Areas/21_Homelab/Firewall.md' });
  });
  return withDegrees({ nodes, edges });
}

function dayAfter(path: string): string {
  const [year, month, day] = path.slice(-13, -3).split('-').map(Number);
  return journalPath(addDays({ year: year!, month: month!, day: day! }, 1));
}

/** Link counts the way the server reports them, so the hub is the real hub. */
function withDegrees(data: GraphData): GraphData {
  const degree = new Map<string, number>();
  for (const e of data.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  return { nodes: data.nodes.map((n) => ({ ...n, links: degree.get(n.path) ?? 0 })), edges: data.edges };
}

function settled(data: GraphData, remembered?: ReturnType<BrainLayout['positions']>): BrainLayout {
  const layout = new BrainLayout(buildGraph(data), { arrangement: 'brain', remembered });
  layout.settle();
  return layout;
}

const isDay = (layout: BrainLayout, i: number): boolean => isDailyNote(layout.graph.nodes[i]!.path);

/** Area of the convex hull of some points (monotone chain). */
function hullArea(points: Array<[number, number]>): number {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return 0;
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Array<[number, number]> = [];
  for (const p of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  let area = 0;
  hull.forEach((p, k) => {
    const q = hull[(k + 1) % hull.length]!;
    area += p[0] * q[1] - q[0] * p[1];
  });
  return Math.abs(area) / 2;
}

const COUNTS = [0, 30, 365, 800];
const base = paraVault().data;
const layouts = new Map(COUNTS.map((count) => [count, settled(withDays(count, base))]));

describe('the journal', () => {
  it('is one region holding every daily note and nothing else, however many days there are', () => {
    for (const [count, layout] of layouts) {
      const journals = layout.regions.filter((region) => region.members.some((i) => isDay(layout, i)));
      if (count === 0) {
        expect(journals, 'no days, no journal').toHaveLength(0);
        continue;
      }
      expect(journals, `${count} days`).toHaveLength(1);
      const [journal] = journals;
      expect(journal!.members).toHaveLength(count);
      expect(journal!.members.every((i) => isDay(layout, i))).toBe(true);
      expect(journal!.name).toBe('Journal');
      expect(layout.regions.filter((region) => region.name === 'Journal')).toHaveLength(1);
      // The labels still fit round the rim.
      expect(layout.regions.length).toBeLessThanOrEqual(9);
    }
  });

  it('takes at most a fifth of the brain, not a share in proportion to its days', () => {
    for (const [count, layout] of layouts) {
      if (count === 0) continue;
      const u = layout.unitLength;
      const days: Array<[number, number]> = [];
      for (let i = 0; i < layout.x.length; i += 1) if (isDay(layout, i)) days.push([layout.x[i]!, layout.y[i]!]);
      const share = hullArea(days) / (OUTLINE.area * u * u);
      expect(share, `${count} days`).toBeLessThanOrEqual(0.2);
      // Every day inside the silhouette, in the left hemisphere, clear of the fissure.
      for (const [x, y] of days) {
        expect(x).toBeLessThan(-FISSURE * u);
        expect(reach(-1, x / u, y / u)).toBeLessThan(1);
      }
    }
    // Whatever the count, the notes that are not days keep the room they had:
    // the brain grows once for the lobe, and not with every day written.
    expect(layouts.get(365)!.unitLength).toBe(layouts.get(30)!.unitLength);
    expect(layouts.get(800)!.unitLength).toBe(layouts.get(30)!.unitLength);
  });

  it('packs the days densely along a trace by date, consecutive days side by side', () => {
    for (const count of [30, 365, 800]) {
      const layout = layouts.get(count)!;
      const days = [...layout.x.keys()]
        .filter((i) => isDay(layout, i))
        .sort((a, b) => (layout.graph.nodes[a]!.path < layout.graph.nodes[b]!.path ? -1 : 1));
      const gaps = days.slice(1).map((i, k) => Math.hypot(layout.x[i]! - layout.x[days[k]!]!, layout.y[i]! - layout.y[days[k]!]!));
      gaps.sort((a, b) => a - b);
      // Nine in ten days lie within two steps of the day before: a trace, not a
      // scatter. (The rest are where the spiral crosses the rim and resumes.)
      expect(gaps[Math.floor(gaps.length * 0.9)]!, `${count} days`).toBeLessThan(31);
      // And no two days' cell bodies overlap.
      let closest = Infinity;
      for (let a = 0; a < days.length; a += 1) {
        for (let b = a + 1; b < days.length; b += 1) {
          const i = days[a]!;
          const j = days[b]!;
          closest = Math.min(closest, Math.hypot(layout.x[i]! - layout.x[j]!, layout.y[i]! - layout.y[j]!) - layout.r[i]! - layout.r[j]!);
        }
      }
      expect(closest, `${count} days`).toBeGreaterThanOrEqual(0);
    }
  });

  it('leaves the anchor and the hemisphere of every other region where they are, with no journal or three years of one', () => {
    const keysOf = (layout: BrainLayout, members: readonly number[]): string =>
      members.map((i) => layout.graph.nodes[i]!.key).sort().join('|');
    const anchors = (layout: BrainLayout): Map<string, [number, number, number]> =>
      new Map(
        layout.regions
          .filter((region) => !region.members.some((i) => isDay(layout, i)))
          .map((region) => [keysOf(layout, region.members), [region.cx / layout.unitLength, region.cy / layout.unitLength, region.side]]),
      );
    const without = anchors(layouts.get(0)!);
    expect(without.size).toBeGreaterThanOrEqual(6);
    for (const count of [30, 365, 800]) {
      const now = anchors(layouts.get(count)!);
      expect([...now.keys()].sort(), `${count} days: the same regions`).toEqual([...without.keys()].sort());
      for (const [key, [cx, cy, side]] of without) {
        const [x, y, s] = now.get(key)!;
        expect(s).toBe(side);
        expect(Math.abs(x - cx), `${count} days`).toBeLessThan(1e-12);
        expect(Math.abs(y - cy), `${count} days`).toBeLessThan(1e-12);
      }
    }
  });

  it('leaves every note that is not a day exactly where it was, from a month of days to three years', () => {
    // Stronger than the anchors: the days link to a project seventy times and
    // more, and that project must not become the hub its region is arranged
    // round. From no journal to the first one the brain grows once for the lobe
    // and the cells stop reaching into it, so that step is measured by the
    // anchors above; from then on nothing but days may change.
    const month = layouts.get(30)!;
    for (const count of [365, 800]) {
      const layout = layouts.get(count)!;
      for (let j = 0; j < month.x.length; j += 1) {
        if (isDay(month, j)) continue;
        const key = month.graph.nodes[j]!.key;
        const i = layout.graph.index.get(key)!;
        expect(layout.x[i], `${key} with ${count} days`).toBe(month.x[j]);
        expect(layout.y[i], `${key} with ${count} days`).toBe(month.y[j]);
      }
    }
  });

  it('keeps every link a day carries, to other days and to notes elsewhere', () => {
    const layout = layouts.get(365)!;
    const { graph } = layout;
    const project = graph.index.get(nodeKey(OWNER, '10_Projects/11_Active/Project A.md'))!;
    const fromDays = graph.touching[project]!.filter((e) => {
      const edge = graph.edges[e]!;
      return isDay(layout, edge.a === project ? edge.b : edge.a);
    });
    expect(fromDays).toHaveLength(73);
  });
});

describe('a new day', () => {
  const data = withDays(365, base);
  const grown = withDays(366, base);
  const newest = grown.nodes[grown.nodes.length - 1]!;

  it('moves nothing but days on a device that remembers nothing', () => {
    const before = layouts.get(365)!;
    const after = settled(grown);
    for (let j = 0; j < before.x.length; j += 1) {
      const key = before.graph.nodes[j]!.key;
      if (isDay(before, j)) continue;
      const i = after.graph.index.get(key)!;
      expect(after.x[i], key).toBe(before.x[j]);
      expect(after.y[i], key).toBe(before.y[j]);
    }
  });

  it('while the coil still fits its lobe, does not move another day either', () => {
    const before = layouts.get(30)!;
    const after = settled(withDays(31, base));
    for (let j = 0; j < before.x.length; j += 1) {
      const i = after.graph.index.get(before.graph.nodes[j]!.key)!;
      expect(after.x[i]).toBe(before.x[j]);
      expect(after.y[i]).toBe(before.y[j]);
    }
  });

  it('moves nothing at all but itself from memory — not the day before, not the notes it links to', () => {
    const before = settled(data);
    const remembered = before.positions();
    const after = new BrainLayout(buildGraph(grown), { arrangement: 'brain', remembered });
    // Nothing may move, so there is nothing to simulate.
    expect(after.settled).toBe(true);
    after.settle();
    for (const [key, at] of remembered) {
      const i = after.graph.index.get(key)!;
      expect(after.x[i], key).toBe(at.x);
      expect(after.y[i], key).toBe(at.y);
    }
    // And it lands at the end of the trace, beside the day before it.
    const fresh = after.graph.index.get(nodeKey(OWNER, newest.path))!;
    const yesterday = after.graph.index.get(nodeKey(OWNER, data.nodes[data.nodes.length - 1]!.path))!;
    expect(Math.hypot(after.x[fresh]! - after.x[yesterday]!, after.y[fresh]! - after.y[yesterday]!)).toBeLessThan(31);
  });

  it('holds still on a reload with a year of days', () => {
    const before = layouts.get(365)!;
    const again = new BrainLayout(buildGraph(data), { arrangement: 'brain', remembered: before.positions() });
    expect(again.settled).toBe(true);
    for (let j = 0; j < before.x.length; j += 1) {
      const i = again.graph.index.get(before.graph.nodes[j]!.key)!;
      expect(again.x[i]).toBe(before.x[j]);
      expect(again.y[i]).toBe(before.y[j]);
    }
  });

  it('picking up a day or a note it links to does not unravel the journal', () => {
    const layout = settled(data);
    const project = layout.graph.index.get(nodeKey(OWNER, '10_Projects/11_Active/Project A.md'))!;
    const day = layout.graph.index.get(nodeKey(OWNER, data.nodes[data.nodes.length - 1]!.path))!;
    const x = Float64Array.from(layout.x);
    const y = Float64Array.from(layout.y);
    for (const held of [project, day]) {
      layout.hold(held);
      layout.place(held, layout.x[held]! + 40, layout.y[held]! + 40);
      for (let k = 0; k < 30; k += 1) layout.step();
      layout.release();
      layout.settle();
      for (let i = 0; i < x.length; i += 1) {
        if (!isDay(layout, i) || i === held) continue;
        expect(layout.x[i]).toBe(x[i]);
        expect(layout.y[i]).toBe(y[i]);
      }
    }
  });
});

describe('the centre', () => {
  it('sits at the fissure in the middle of the brain, with its region round it', () => {
    const centreOf = (layout: BrainLayout): string => layout.graph.nodes[layout.centre]!.key;
    for (const [count, layout] of layouts) {
      const { graph, unitLength: u } = layout;
      const hub = layout.centre;
      expect(hub).toBeGreaterThanOrEqual(0);
      expect(graph.nodes[hub]!.degree).toBeGreaterThanOrEqual(MAP_DEGREE);
      // The same map with a year of days that mention a project seventy times:
      // links from days do not crown a new centre.
      expect(centreOf(layout), `${count} days`).toBe(centreOf(layouts.get(0)!));
      const region = layout.regions[layout.regionOf[hub]!]!;
      // As close to the middle as a note may come, and level with the middle.
      expect(Math.abs(layout.x[hub]!) / u, `${count} days`).toBeLessThan(FISSURE * 1.3);
      expect(Math.abs(layout.y[hub]!) / u).toBeLessThan(0.1);
      // Its region's cell is the one pinned beside the fissure.
      expect(Math.abs(region.cx) / u).toBeLessThan(0.3);
      expect(region.hub).toBe(hub);
      // And the region's notes are round it: most of them within a third of the
      // brain's height.
      const near = region.members.filter((i) => Math.hypot(layout.x[i]! - layout.x[hub]!, layout.y[i]! - layout.y[hub]!) < 0.66 * u);
      expect(near.length / region.members.length).toBeGreaterThan(0.6);
    }
  });

  it('is not put anywhere in the neighbourhood beside an open note', () => {
    // The loose arrangement has no fissure: the centre is laid out like any
    // other note there, from its hash, and moves with the simulation.
    const graph = buildGraph(base);
    const loose = new BrainLayout(graph, { arrangement: 'loose' });
    expect(loose.regions).toHaveLength(0);
    expect(loose.mobile[graph.hub]).toBe(1);
  });
});

describe('the journal in the clusters', () => {
  it('is left out of every other note’s ties, so days change no other cluster', () => {
    const without = buildGraph(base);
    const withYear = buildGraph(withDays(365, base));
    const partition = (graph: typeof without): string[] =>
      graph.clusters.clusters
        .map((cluster) => cluster.members.map((i) => graph.nodes[i]!.key).filter((key) => !key.includes(JOURNAL_ROOT)).sort().join('|'))
        .filter((members) => members !== '')
        .sort();
    expect(partition(withYear)).toEqual(partition(without));
    const journal = withYear.clusters.clusters.filter((cluster) => cluster.members.some((i) => isDailyNote(withYear.nodes[i]!.path)));
    expect(journal).toHaveLength(1);
    expect(journal[0]!.members).toHaveLength(365);
  });
});
