// @vitest-environment node
/**
 * How loudly links are drawn: the weighting and threshold rule in `edges.ts`,
 * and the numbers the scene hands the renderer because of it.
 *
 * Mostly on the PARA-shaped fixture vault, laid out as a brain, because the
 * rule only means something on a graph with regions, hubs and a fissure. The
 * choice of a thread is also checked on a graph small enough to know the
 * answer by hand.
 */

import { describe, expect, it } from 'vitest';

import type { GraphData } from '../src/api';
import { Activity } from '../src/brain/activity';
import type { Camera } from '../src/brain/camera';
import { IDENTITY, fit } from '../src/brain/camera';
import type { EdgeInput, EdgePlan } from '../src/brain/edges';
import {
  BRIDGE,
  FISSURE,
  FOCUS,
  FURROW,
  GLOW_REST,
  HUB_DEGREE,
  SPAN,
  SPAN_LINKS,
  TRACT,
  TRACT_BASE_MAX,
  TWIN,
  VISIBLE,
  WITHIN,
  edgeAlpha,
  glow,
  growth,
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
const NONE = { top: 0, right: 0, bottom: 0, left: 0 };

function brain(data: GraphData = paraVault().data): { graph: BrainGraph; layout: BrainLayout; plan: EdgePlan } {
  const graph = buildGraph(data);
  const layout = new BrainLayout(graph, { arrangement: 'brain' });
  layout.settle();
  const plan = planEdges(inputOf(graph, layout));
  return { graph, layout, plan };
}

function inputOf(graph: BrainGraph, layout: BrainLayout): EdgeInput {
  return {
    edges: graph.edges,
    keys: graph.nodes.map((n) => n.key),
    clusterOf: graph.clusters.of,
    nodeSide: layout.nodeSide,
  };
}

const fixture = brain();

type Scene = ReturnType<SceneBuilder['build']>;

function scene(picked = -1, camera: Camera = IDENTITY, activity?: Activity, width = ROOM, height = ROOM): Scene {
  const { graph, layout } = fixture;
  return new SceneBuilder(graph).build(layout, activity ?? new Activity(graph), camera, picked, width, height);
}

/** A camera at `scale`, looking at world point (wx, wy) in the middle of a width × height view. */
const looking = (scale: number, wx: number, wy: number, width: number, height: number): Camera => ({
  scale,
  x: width / 2 - wx * scale,
  y: height / 2 - wy * scale,
});

const drawnPairs = (plan: EdgePlan): number[] =>
  Array.from(plan.kind.keys()).filter((i) => plan.kind[i] !== TWIN);

const pairKey = (graph: BrainGraph, i: number): string =>
  [graph.nodes[graph.edges[i]!.a]!.key, graph.nodes[graph.edges[i]!.b]!.key].sort().join('\u0000');

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
    const loudest = (list: number[]): number => Math.max(...list.map((i) => plan.rest[i]!));
    const hubWithin = graph.touching[hub]!.filter((i) => plan.kind[i] === WITHIN);
    expect(hubWithin.length).toBeGreaterThan(0);
    // Even the loudest spoke of a forty-link hub is quieter than an ordinary link...
    expect(loudest(hubWithin)).toBeLessThan(TRACT);
    // ...but still a visible line: damped, not hidden.
    for (const i of hubWithin) expect(plan.rest[i]!).toBeGreaterThanOrEqual(VISIBLE);
  });

  it('draws links between clusters quieter than links inside one, in the overview', () => {
    const { plan } = fixture;
    const within = drawnPairs(plan).filter((i) => plan.kind[i] === WITHIN);
    const between = drawnPairs(plan).filter((i) => plan.kind[i] !== WITHIN);
    expect(within.length).toBeGreaterThan(0);
    for (const kind of [FISSURE, FURROW, BRIDGE, SPAN]) {
      expect(between.some((i) => plan.kind[i] === kind)).toBe(true);
    }

    const loudestBetween = Math.max(...between.map((i) => edgeAlpha(plan, i, 0, false, 0)));
    const quietestWithin = Math.min(...within.map((i) => edgeAlpha(plan, i, 0, false, 0)));
    expect(loudestBetween).toBeLessThan(quietestWithin);
    // A thread across the fissure is quieter than one beside it on the same side.
    const bridge = between.find((i) => plan.kind[i] === BRIDGE)!;
    const span = between.find((i) => plan.kind[i] === SPAN)!;
    expect(plan.rest[span]!).toBeLessThan(plan.rest[bridge]!);
    // Everything else across the fissure and the furrows is below a line.
    for (const i of between.filter((j) => plan.kind[j] === FISSURE || plan.kind[j] === FURROW)) {
      expect(edgeAlpha(plan, i, 0, false, 0)).toBeLessThan(VISIBLE);
    }
  });

  it('gives every pair of linked regions one thread: always on one side, from two links across the fissure', () => {
    const { graph, layout, plan } = fixture;
    const of = graph.clusters.of;
    const links = new Map<string, number>();
    const threads = new Map<string, number>();
    for (const i of drawnPairs(plan)) {
      const e = graph.edges[i]!;
      const [ca, cb] = [of[e.a]!, of[e.b]!].sort((x, y) => x - y);
      if (ca === cb) continue;
      const across = layout.nodeSide[e.a] !== layout.nodeSide[e.b];
      const regions = `${ca}:${cb}:${across ? 'across' : 'beside'}`;
      links.set(regions, (links.get(regions) ?? 0) + 1);
      if (plan.kind[i] === BRIDGE) expect(across).toBe(false);
      if (plan.kind[i] === SPAN) expect(across).toBe(true);
      if (plan.kind[i] === BRIDGE || plan.kind[i] === SPAN) {
        expect(plan.rest[i]!).toBeGreaterThanOrEqual(VISIBLE);
        threads.set(regions, (threads.get(regions) ?? 0) + 1);
      }
    }
    let spans = 0;
    for (const [regions, count] of links) {
      const across = regions.endsWith(':across');
      const expected = !across || count >= SPAN_LINKS ? 1 : 0;
      expect(threads.get(regions) ?? 0, regions).toBe(expected);
      if (across && expected === 1) spans += 1;
    }
    expect(spans).toBeGreaterThan(0);
  });

  it('chooses as thread the link that binds two regions, not the weakest one', () => {
    // Three regions on one side: 0 = {a, c}, 1 = {x, y}, 2 = {w}. Two links
    // between regions 0 and 1: a–x closes a triangle through w, which links
    // both; c–y closes none. The thread is a–x whatever order the links arrive
    // in and whatever the keys say — c–y has the smaller keys on purpose.
    const keys = ['n-a', 'a-c', 'n-x', 'a-y', 'n-w'];
    const [a, c, x, y, w] = [0, 1, 2, 3, 4];
    const edges = [
      { a: a, b: c },
      { a: x, b: y },
      { a: a, b: w },
      { a: x, b: w },
      { a: c, b: y },
      { a: a, b: x },
    ];
    const clusterOf = [0, 0, 1, 1, 2];
    for (const order of [edges, [...edges].reverse()]) {
      const plan = planEdges({ edges: order, keys, clusterOf, nodeSide: [1, 1, 1, 1, 1] });
      const kindOf = (p: number, q: number): number =>
        plan.kind[order.findIndex((e) => (e.a === p && e.b === q) || (e.a === q && e.b === p))]!;
      expect(kindOf(a, x)).toBe(BRIDGE);
      expect(kindOf(c, y)).toBe(FURROW);
    }

    // A link between two ordinary notes beats one that touches a hub, even with
    // fewer shared neighbours: a hub links into every region.
    const hubKeys = ['h', 'p', 'q', ...Array.from({ length: HUB_DEGREE }, (_, i) => `leaf${i}`)];
    const hubEdges = [
      { a: 0, b: 1 }, // hub -> region-1 note p: the hub shares p's neighbour q
      { a: 0, b: 2 },
      { a: 1, b: 2 },
      ...Array.from({ length: HUB_DEGREE }, (_, i) => ({ a: 0, b: 3 + i })),
      { a: 3, b: 2 }, // leaf0 (region 0, ordinary) -> q (region 1)
    ];
    const hubClusters = [0, 1, 1, ...Array.from({ length: HUB_DEGREE }, () => 0)];
    const plan = planEdges({ edges: hubEdges, keys: hubKeys, clusterOf: hubClusters, nodeSide: hubKeys.map(() => 1) });
    expect(plan.kind[hubEdges.length - 1]).toBe(BRIDGE);
    expect(plan.kind[0]).toBe(FURROW);
  });

  it('does not move a thread when a note elsewhere gains a leaf', () => {
    // Every possible capture of one new note linked to one existing note, with
    // clusters and sides held: the only thread allowed to move is one whose
    // choice depends on that very note crossing the hub threshold.
    const { graph, layout, plan } = fixture;
    const input = inputOf(graph, layout);
    const threadsOf = (p: EdgePlan, edges: EdgeInput['edges'], keys: readonly string[]): string[] =>
      Array.from(p.kind.keys())
        .filter((i) => p.kind[i] === BRIDGE || p.kind[i] === SPAN)
        .map((i) => [keys[edges[i]!.a]!, keys[edges[i]!.b]!].sort().join('\u0000'))
        .sort();
    const before = threadsOf(plan, input.edges, input.keys);
    const neighbours = graph.nodes.map(() => new Set<number>());
    for (const e of graph.edges) {
      neighbours[e.a]!.add(e.b);
      neighbours[e.b]!.add(e.a);
    }

    let moved = 0;
    for (let at = 0; at < graph.nodes.length; at += 1) {
      if (neighbours[at]!.size === HUB_DEGREE - 1) continue;
      const leaf = graph.nodes.length;
      const edges = [...graph.edges, { a: leaf, b: at }];
      const keys = [...input.keys, `zz-capture-${at}`];
      const clusterOf = [...Array.from(graph.clusters.of), graph.clusters.of[at]!];
      const nodeSide = [...Array.from(layout.nodeSide), layout.nodeSide[at]!];
      const after = planEdges({ edges, keys, clusterOf, nodeSide });
      if (threadsOf(after, edges, keys).join('\n') !== before.join('\n')) moved += 1;
    }
    expect(moved).toBe(0);
  });

  it('draws no tract over the fissure for a remembered note that changed cluster and stayed on its side', () => {
    // A project note on the left, remembered there, gains three links into the
    // service region on the right. It joins that cluster, but a remembered
    // note keeps its hemisphere. Its new links are inside one cluster and still
    // cross the fissure on screen: by the cluster's side they would be three
    // bright tracts straight over it.
    const data = paraVault().data;
    const first = brain(data);
    const from = '10_Projects/11_Active/Game one.md';
    const owner = data.nodes[0]!.owner;
    // The three targets are searched for rather than named: which notes end up
    // in which half depends on the layout, and three names pinned this test to
    // one arrangement. Wanted: three notes of one cluster, in the half `from` is
    // not in, that `from` really joins once it links them — a tie is divided by
    // the degrees at both ends, so linking three maps of content joins nothing.
    const start = first.layout;
    const here = start.nodeSide[start.graph.index.get(`${owner}\u0000${from}`)!]!;
    const overThere = new Map<number, number[]>();
    start.graph.nodes.forEach((_, i) => {
      if (start.nodeSide[i] === here) return;
      const c = start.graph.clusters.of[i]!;
      overThere.set(c, [...(overThere.get(c) ?? []), i]);
    });
    const candidates = [...overThere.values()]
      .filter((list) => list.length >= 3)
      .sort((a, b) => b.length - a.length)
      .map((list) =>
        [...list]
          .sort((a, b) => start.graph.nodes[a]!.degree - start.graph.nodes[b]!.degree)
          .slice(0, 3)
          .map((i) => start.graph.nodes[i]!.path),
      );
    let targets: string[] = [];
    let graph = first.graph;
    for (const pick of candidates) {
      const grown = buildGraph({ nodes: data.nodes, edges: [...data.edges, ...pick.map((to) => ({ owner, from, to }))] });
      const moved = grown.index.get(`${owner}\u0000${from}`)!;
      if (grown.clusters.of[moved] !== grown.clusters.of[grown.index.get(`${owner}\u0000${pick[0]}`)!]) continue;
      targets = pick;
      graph = grown;
      break;
    }
    expect(targets.length, 'a cluster in the other half that the note would join').toBe(3);
    const layout = new BrainLayout(graph, { arrangement: 'brain', remembered: first.layout.positions() });
    layout.settle();

    const note = graph.index.get(`${owner}\u0000${from}`)!;
    const service = graph.index.get(`${owner}\u0000${targets[0]}`)!;
    const cluster = graph.clusters.of[note]!;
    expect(cluster).toBe(graph.clusters.of[service]);
    // What makes the links cross: the note stayed in the half it was remembered
    // in, and the notes it now shares a cluster with are in the other one.
    // (Until phase 4 this was phrased as "its cluster's side is not its own";
    // clusters no longer carry a side, regions do, and a note's region can be
    // the one it is in while the cluster it joined lives across the fissure.)
    expect(layout.nodeSide[service]).not.toBe(layout.nodeSide[note]);
    expect(Math.sign(layout.x[note]!)).toBe(layout.nodeSide[note]);

    const plan = planEdges(inputOf(graph, layout));
    const s = new SceneBuilder(graph).build(layout, new Activity(graph), IDENTITY, -1, ROOM, ROOM);
    let over = 0;
    for (const i of graph.touching[note]!) {
      const e = s.edges[i]!;
      if (Math.sign(e.ax) === Math.sign(e.bx)) continue;
      over += 1;
      if (plan.kind[i] === WITHIN || plan.kind[i] === BRIDGE) {
        expect(e.alpha, `edge ${i} kind ${plan.kind[i]}`).toBeLessThan(VISIBLE);
      }
      if (graph.clusters.of[graph.edges[i]!.a] === graph.clusters.of[graph.edges[i]!.b]) {
        expect(e.alpha).toBeLessThan(VISIBLE);
      }
    }
    expect(over).toBeGreaterThanOrEqual(3);
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

  it('draws about 60 % of the links as lines in the overview', () => {
    // Band: the briefing asks for about 40 % fewer visible links. Below 55 %,
    // regions lose the links that make them regions. The upper bound is 72 %:
    // the threads across the fissure (fix round 1) add about four points, and
    // past that fewer than 28 % of the links would be held back, too far from
    // the forty the briefing asks for. Measured with notes classified by their
    // own hemisphere and regions anchored to folders: 68 % on this fixture
    // (157 of 231 linked pairs), 63 % on the real vault's structure (171 of 270).
    const share = visibleShare(fixture.plan);
    expect(share).toBeGreaterThanOrEqual(0.55);
    expect(share).toBeLessThanOrEqual(0.72);
    expect(visibleShare(fixture.plan, 1)).toBe(1);

    // Through the scene, at the overview: the same share.
    const count = (s: Scene): number =>
      drawnPairs(fixture.plan).filter((i) => s.edges[i]!.alpha >= VISIBLE).length / drawnPairs(fixture.plan).length;
    expect(count(scene())).toBeCloseTo(share, 9);
  });

  it('measures the zoom against the overview of this viewport, not against scale 1', () => {
    // A small canvas: the overview is far below the design scale, so a camera at
    // the overview scale is not zoomed in, and one at 2.6 times it is, although
    // its absolute scale is still below 1.
    const { layout, plan } = fixture;
    const [w, h] = [320, 240];
    const overview = fit(layout.bounds, w, h, NONE);
    expect(overview.scale).toBeLessThan(0.35);
    const cx = (layout.bounds.minX + layout.bounds.maxX) / 2;
    const cy = (layout.bounds.minY + layout.bounds.maxY) / 2;
    const held = drawnPairs(plan).filter((i) => plan.kind[i] === FURROW || plan.kind[i] === FISSURE);

    const atOverview = scene(-1, overview, undefined, w, h);
    for (const i of held) expect(atOverview.edges[i]!.alpha).toBeLessThan(VISIBLE);

    const scale = overview.scale * 2.6;
    expect(scale).toBeLessThan(1);
    const closer = scene(-1, looking(scale, cx, cy, w, h), undefined, w, h);
    const inView = (x: number, y: number): boolean =>
      Math.abs(x - cx) * scale <= w / 2 && Math.abs(y - cy) * scale <= h / 2;
    const seen = held.filter((i) => {
      const e = closer.edges[i]!;
      return inView(e.ax, e.ay) || inView(e.bx, e.by);
    });
    expect(seen.length).toBeGreaterThan(10);
    for (const i of seen) expect(closer.edges[i]!.alpha).toBeGreaterThanOrEqual(VISIBLE);
  });

  it('brings held-back links back when zoomed in on one of their ends, not when they only pass through', () => {
    const { graph, layout, plan } = fixture;
    // Zoom 3x onto the middle of the largest cluster.
    const largest = [...graph.clusters.clusters].sort((p, q) => q.members.length - p.members.length)[0]!;
    let wx = 0;
    let wy = 0;
    for (const i of largest.members) {
      wx += layout.x[i]!;
      wy += layout.y[i]!;
    }
    wx /= largest.members.length;
    wy /= largest.members.length;
    const [w, h] = [900, 600];
    const scale = fit(layout.bounds, w, h, NONE).scale * 3;
    const s = scene(-1, looking(scale, wx, wy, w, h), undefined, w, h);
    const inView = (x: number, y: number): boolean =>
      Math.abs(x - wx) * scale <= w / 2 && Math.abs(y - wy) * scale <= h / 2;

    let open = 0;
    let passing = 0;
    for (const i of drawnPairs(plan)) {
      const e = s.edges[i]!;
      const seen = inView(e.ax, e.ay) || inView(e.bx, e.by);
      if (seen) {
        expect(e.alpha).toBeGreaterThanOrEqual(VISIBLE);
        open += 1;
      } else if (plan.kind[i] === FURROW || plan.kind[i] === FISSURE) {
        expect(e.alpha).toBeLessThan(VISIBLE);
        passing += 1;
      }
    }
    expect(open).toBeGreaterThan(0);
    expect(passing).toBeGreaterThan(0);
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
    expect(growth(0.5)).toBe(1);
    expect(tractBase(20, growth(4), false) * 4).toBeCloseTo(tractBase(20, growth(1), false) * 2, 9);
    expect(tractMid(growth(4), 4) * 4).toBeCloseTo(tractMid(growth(1), 1) * 2, 9);
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

  it('sends one spark along a link in both directions, on the line that is drawn', () => {
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
    activity.advance();
    const hot = scene(-1, IDENTITY, activity);
    expect(hot.edges[twin]!.alpha).toBe(0);
    expect(hot.edges[carrier]!.alpha).toBeGreaterThanOrEqual(0.4);
    // One spark per drawn link of the note, none for its twins.
    const drawn = graph.touching[from]!.filter((i) => plan.kind[i] !== TWIN).length;
    expect(graph.touching[from]!.length).toBeGreaterThan(drawn);
    expect(hot.sparks).toHaveLength(drawn);
  });

  it('draws exactly one edge per linked pair, and the same one for any server order', () => {
    const { graph, plan } = fixture;
    const pairs = new Map<string, number>();
    for (const i of drawnPairs(plan)) {
      const pair = pairKey(graph, i);
      expect(pairs.has(pair)).toBe(false);
      pairs.set(pair, i);
    }
    const all = new Set(graph.edges.map((_, i) => pairKey(graph, i)));
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
      nodes: data.nodes.filter((n) => keys.has(`${n.owner}\u0000${n.path}`)),
      edges: data.edges.filter(
        (e) => keys.has(`${e.owner}\u0000${e.from}`) && keys.has(`${e.owner}\u0000${e.to}`),
      ),
    };
    const g = buildGraph(sub);
    expect(g.nodes.length).toBe(near.size);
    const layout = new BrainLayout(g, { arrangement: 'loose' });
    const s = new SceneBuilder(g).build(layout, new Activity(g), IDENTITY, -1, 800, 500);
    const plan = planEdges({ edges: g.edges, keys: g.nodes.map((n) => n.key), clusterOf: null, nodeSide: null });
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
