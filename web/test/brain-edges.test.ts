// @vitest-environment node
/**
 * How loudly links are drawn: the weighting and threshold rule in `edges.ts`,
 * and the numbers the scene hands the renderer because of it.
 *
 * All on the PARA-shaped fixture vault, laid out as a brain, because the rule
 * only means something on a graph with regions, hubs and a fissure.
 */

import { describe, expect, it } from 'vitest';

import type { GraphData } from '../src/api';
import { Activity } from '../src/brain/activity';
import type { Camera } from '../src/brain/camera';
import { IDENTITY } from '../src/brain/camera';
import type { EdgePlan } from '../src/brain/edges';
import {
  BRIDGE,
  FISSURE,
  FOCUS,
  FURROW,
  GLOW_REST,
  TRACT,
  TRACT_BASE_MAX,
  TWIN,
  VISIBLE,
  WITHIN,
  edgeAlpha,
  glow,
  opening,
  planEdges,
  tractBase,
  tractMid,
  visibleShare,
} from '../src/brain/edges';
import { BrainLayout } from '../src/brain/layout';
import type { BrainGraph } from '../src/brain/model';
import { buildGraph } from '../src/brain/model';
import { SceneBuilder } from '../src/brain/scene';
import { paraVault, shuffled } from './fixtures/para-vault';

/** Large enough that the whole brain fits at the design scale: the overview is scale 1. */
const ROOM = 4000;

function brain(data: GraphData = paraVault().data): { graph: BrainGraph; layout: BrainLayout; plan: EdgePlan } {
  const graph = buildGraph(data);
  const layout = new BrainLayout(graph, { arrangement: 'brain' });
  layout.settle();
  const plan = planEdges({
    edges: graph.edges,
    keys: graph.nodes.map((n) => n.key),
    clusterOf: graph.clusters.of,
    sideOf: layout.side,
  });
  return { graph, layout, plan };
}

const fixture = brain();

function scene(picked = -1, camera: Camera = IDENTITY, activity?: Activity): ReturnType<SceneBuilder['build']> {
  const { graph, layout } = fixture;
  return new SceneBuilder(graph).build(layout, activity ?? new Activity(graph), camera, picked, ROOM, ROOM);
}

const drawnPairs = (plan: EdgePlan): number[] =>
  Array.from(plan.kind.keys()).filter((i) => plan.kind[i] !== TWIN);

describe('edge weighting', () => {
  it('keeps the tracts of the largest hub no wider than a mid-sized note', () => {
    const { graph, layout } = fixture;
    const hub = graph.hub;
    expect(graph.touching[hub]!.length).toBeGreaterThanOrEqual(30);

    // X: the full width where a tract leaves the cell body, in world units at
    // the design scale. The old tracts were 0.55 + 0.9 · 0.42 · r wide per side,
    // about 20 units across at this hub. 5.4 is two capped half-widths plus the
    // 1px line; 7 leaves room for the focus widening.
    const rest = scene();
    const focused = scene(hub);
    for (const i of graph.touching[hub]!) {
      const e = rest.edges[i]!;
      expect(2 * (e.mw + Math.max(e.aw, e.bw))).toBeLessThanOrEqual(5.4 + 1e-9);
      const f = focused.edges[i]!;
      expect(2 * (f.mw + Math.max(f.aw, f.bw))).toBeLessThanOrEqual(7);
    }
    expect(tractBase(layout.r[hub]!, 1, false)).toBe(TRACT_BASE_MAX);
    expect(tractBase(1000, 1, false)).toBe(TRACT_BASE_MAX);
  });

  it('does not let a hub outshine the notes around it: its links are no louder than anyone else’s', () => {
    const { graph, plan } = fixture;
    const hub = graph.hub;
    const quietest = (list: number[]): number => Math.max(...list.map((i) => plan.rest[i]!));
    const hubWithin = graph.touching[hub]!.filter((i) => plan.kind[i] === WITHIN);
    expect(hubWithin.length).toBeGreaterThan(0);
    // A spoke of a forty-link hub is quieter than the loudest ordinary link...
    expect(quietest(hubWithin)).toBeLessThan(TRACT);
    // ...but still a visible line: damped, not hidden.
    for (const i of hubWithin) expect(plan.rest[i]!).toBeGreaterThanOrEqual(VISIBLE);
  });

  it('draws links between clusters quieter than links inside one, in the overview', () => {
    const { plan } = fixture;
    const within = drawnPairs(plan).filter((i) => plan.kind[i] === WITHIN);
    const between = drawnPairs(plan).filter((i) => plan.kind[i] !== WITHIN);
    expect(within.length).toBeGreaterThan(0);
    expect(between.some((i) => plan.kind[i] === FISSURE)).toBe(true);
    expect(between.some((i) => plan.kind[i] === FURROW)).toBe(true);
    expect(between.some((i) => plan.kind[i] === BRIDGE)).toBe(true);

    const loudestBetween = Math.max(...between.map((i) => edgeAlpha(plan, i, 0, false, 0)));
    const quietestWithin = Math.min(...within.map((i) => edgeAlpha(plan, i, 0, false, 0)));
    expect(loudestBetween).toBeLessThan(quietestWithin);
    // And the fissure is held back below the threshold of a line altogether.
    for (const i of between.filter((j) => plan.kind[j] === FISSURE)) {
      expect(edgeAlpha(plan, i, 0, false, 0)).toBeLessThan(VISIBLE);
    }
  });

  it('keeps one thread per pair of neighbouring regions, never across the fissure', () => {
    const { graph, layout, plan } = fixture;
    const of = graph.clusters.of;
    const seen = new Set<string>();
    for (const i of drawnPairs(plan).filter((j) => plan.kind[j] === BRIDGE)) {
      const e = graph.edges[i]!;
      const [ca, cb] = [of[e.a]!, of[e.b]!].sort((x, y) => x - y);
      expect(ca).not.toBe(cb);
      expect(layout.side[ca!]).toBe(layout.side[cb!]);
      const regions = `${ca}:${cb}`;
      expect(seen.has(regions)).toBe(false);
      seen.add(regions);
      expect(plan.rest[i]!).toBeGreaterThanOrEqual(VISIBLE);
    }
  });

  it('shows every link of the picked note in full, whatever kind it is', () => {
    const { graph, plan } = fixture;
    const hub = graph.hub;
    const kinds = new Set(graph.touching[hub]!.map((i) => plan.kind[i]));
    expect(kinds.size).toBeGreaterThan(1);

    const picked = scene(hub);
    const drawn = graph.touching[hub]!.filter((i) => plan.kind[i] !== TWIN);
    for (const i of drawn) expect(picked.edges[i]!.alpha).toBe(FOCUS);
    // The pair is still drawn once: the twin stays out of it.
    for (const i of graph.touching[hub]!.filter((j) => plan.kind[j] === TWIN)) {
      expect(picked.edges[i]!.alpha).toBe(0);
      expect(picked.edges[plan.primary[i]!]!.alpha).toBe(FOCUS);
    }

    // A link across the fissure, too: focus overrides the overview rule.
    const across = drawnPairs(plan).find((i) => plan.kind[i] === FISSURE)!;
    expect(scene(graph.edges[across]!.a).edges[across]!.alpha).toBe(FOCUS);
    // Nothing else changes when a note is picked.
    const rest = scene();
    const untouched = drawnPairs(plan).find((i) => graph.edges[i]!.a !== hub && graph.edges[i]!.b !== hub)!;
    expect(picked.edges[untouched]!.alpha).toBe(rest.edges[untouched]!.alpha);
  });

  it('draws about 60 % of the links as lines in the overview, and all of them zoomed in', () => {
    // Band: the briefing asks for about 40 % fewer visible links. Below half,
    // regions lose the links that make them regions; above 70 %, the furrows
    // fill again. Measured: 65 % on this fixture, 60 % on the real vault's
    // structure (163 of 270 linked pairs).
    const share = visibleShare(fixture.plan);
    expect(share).toBeGreaterThanOrEqual(0.5);
    expect(share).toBeLessThanOrEqual(0.7);
    expect(visibleShare(fixture.plan, 1)).toBe(1);

    // Through the scene: at the overview the same share, at 3x all of them.
    const count = (s: ReturnType<typeof scene>): number =>
      drawnPairs(fixture.plan).filter((i) => s.edges[i]!.alpha >= VISIBLE).length / drawnPairs(fixture.plan).length;
    expect(count(scene())).toBeCloseTo(share, 9);
    expect(count(scene(-1, { scale: 3, x: 0, y: 0 }))).toBe(1);
  });

  it('brings held-back links back smoothly with the zoom, not in a jump', () => {
    expect(opening(1)).toBe(0);
    expect(opening(1.3)).toBe(0);
    expect(opening(2.6)).toBe(1);
    let last = 0;
    for (let z = 1; z <= 3; z += 0.05) {
      const o = opening(z);
      expect(o).toBeGreaterThanOrEqual(last);
      expect(o - last).toBeLessThan(0.12);
      last = o;
    }
    // A tract grows on screen by the square root of the zoom, not the zoom.
    expect(tractBase(20, 4, false) * 4).toBeCloseTo(tractBase(20, 1, false) * 2, 9);
    expect(tractMid(4, 4) * 4).toBeCloseTo(tractMid(1, 1) * 2, 9);
  });

  it('lights a held-back link while a pulse runs along it', () => {
    const { graph, plan } = fixture;
    const ghost = drawnPairs(plan).find((i) => plan.kind[i] === FISSURE)!;
    const from = graph.edges[ghost]!.a;
    const node = graph.nodes[from]!;
    const activity = new Activity(graph);
    activity.record([
      { at: 0, kind: 'read', what: 'get_note', path: node.path, who: 'jb', agent: false, owner: node.owner },
    ]);
    const hot = scene(-1, IDENTITY, activity);
    expect(scene().edges[ghost]!.alpha).toBeLessThan(VISIBLE);
    expect(hot.edges[ghost]!.alpha).toBeGreaterThanOrEqual(0.4);
    // The firing note glows at full strength while the rest stay at the calmer halo.
    expect(hot.nodes[from]!.glow).toBe(1);
    expect(hot.sparks.length).toBeGreaterThan(0);

    for (let i = 0; i < 60; i += 1) activity.advance();
    expect(scene(-1, IDENTITY, activity).edges[ghost]!.alpha).toBeLessThan(VISIBLE);
  });

  it('sends a spark on a link in both directions along the line that is drawn', () => {
    const { graph, plan } = fixture;
    const twin = Array.from(plan.kind.keys()).find((i) => plan.kind[i] === TWIN)!;
    const carrier = plan.primary[twin]!;
    expect(plan.kind[carrier]).not.toBe(TWIN);
    const from = graph.edges[twin]!.a;
    const activity = new Activity(graph);
    const node = graph.nodes[from]!;
    activity.record([
      { at: 0, kind: 'write', what: 'edit_note', path: node.path, who: 'jb', agent: true, owner: node.owner },
    ]);
    const hot = scene(-1, IDENTITY, activity);
    expect(hot.edges[twin]!.alpha).toBe(0);
    expect(hot.edges[carrier]!.alpha).toBeGreaterThanOrEqual(0.4);
  });

  it('draws exactly one edge per linked pair, and the same one for any server order', () => {
    const { graph, plan } = fixture;
    const pairs = new Map<string, number>();
    for (const i of drawnPairs(plan)) {
      const e = graph.edges[i]!;
      const pair = [graph.nodes[e.a]!.key, graph.nodes[e.b]!.key].sort().join(' ');
      expect(pairs.has(pair)).toBe(false);
      pairs.set(pair, i);
    }
    const all = new Set(graph.edges.map((e) => [graph.nodes[e.a]!.key, graph.nodes[e.b]!.key].sort().join(' ')));
    expect(pairs.size).toBe(all.size);

    const describe = (b: ReturnType<typeof brain>): string[] =>
      drawnPairs(b.plan)
        .map((i) => {
          const e = b.graph.edges[i]!;
          return `${b.graph.nodes[e.a]!.key}>${b.graph.nodes[e.b]!.key}=${b.plan.kind[i]}:${b.plan.rest[i]}:${b.plan.near[i]}`;
        })
        .sort();
    expect(describe(brain(shuffled(paraVault().data)))).toEqual(describe(fixture));
  });

  it('keeps the small neighbourhood beside a note clearly drawn', () => {
    const { graph } = fixture;
    const hub = graph.hub;
    const near = new Set([hub]);
    for (const i of graph.touching[hub]!) near.add(graph.edges[i]!.a).add(graph.edges[i]!.b);
    const data = paraVault().data;
    const keys = new Set([...near].map((i) => graph.nodes[i]!.key));
    const sub: GraphData = {
      nodes: data.nodes.filter((n) => keys.has(`${n.owner} ${n.path}`)),
      edges: data.edges.filter(
        (e) => keys.has(`${e.owner} ${e.from}`) && keys.has(`${e.owner} ${e.to}`),
      ),
    };
    const g = buildGraph(sub);
    expect(g.nodes.length).toBe(near.size);
    const layout = new BrainLayout(g, { arrangement: 'loose' });
    const s = new SceneBuilder(g).build(layout, new Activity(g), IDENTITY, -1, 800, 500);
    const plan = planEdges({ edges: g.edges, keys: g.nodes.map((n) => n.key), clusterOf: null, sideOf: null });
    const drawn = drawnPairs(plan);
    expect(drawn.length).toBeGreaterThan(10);
    for (const i of drawn) {
      expect(plan.kind[i]).toBe(WITHIN);
      expect(s.edges[i]!.alpha).toBeGreaterThanOrEqual(VISIBLE * 2);
    }
    expect(visibleShare(plan)).toBe(1);
  });

  it('takes 30 % off the halo of a note at rest and none off a note that fires', () => {
    expect(glow(0)).toBe(GLOW_REST);
    expect(GLOW_REST).toBeCloseTo(0.7, 9);
    expect(glow(1)).toBe(1);
    const rest = scene();
    for (const n of rest.nodes) expect(n.glow).toBe(GLOW_REST);
  });
});
