/**
 * The optics: where a link runs, what the tissue is made of, and what the zoom
 * does to both.
 *
 * All of it against the real vault's structure and without a canvas. The three
 * things that are easy to get wrong and impossible to see in a screenshot are a
 * curve with a NaN in it (which throws inside the frame and freezes the whole
 * view), decoration that leaves the silhouette, and decoration that is brighter
 * than the notes it is supposed to sit behind.
 */

import { describe, expect, it } from 'vitest';

import { Activity } from '../src/brain/activity';
import type { Camera } from '../src/brain/camera';
import {
  DENDRITE_ALPHA,
  DENDRITE_TIP_WIDTH,
  DENDRITE_WIDTH,
  buildDecoration,
} from '../src/brain/deco';
import {
  CURVE_STEPS,
  GHOST,
  TRACT_BASE_MIN,
  keepInside,
  planRoutes,
  traceEdge,
} from '../src/brain/edges';
import { BrainLayout } from '../src/brain/layout';
import { buildGraph } from '../src/brain/model';
import { regionView } from '../src/brain/regions';
import { RAY, SceneBuilder, amber, planeOf } from '../src/brain/scene';
import { paraVault } from './fixtures/para-vault';

const ROOM = 4000;
const IDENTITY: Camera = { scale: 1, x: 0, y: 0 };

const graph = buildGraph(paraVault().data);
const layout = new BrainLayout(graph, { arrangement: 'brain' });
layout.settle();
const view = regionView(layout);
const geometry = {
  inside: view.inside,
  depthInside: view.depthInside,
  regionOf: view.regionOf,
  regions: view.regions,
};
const routes = planRoutes({
  edges: graph.edges,
  keys: graph.nodes.map((n) => n.key),
  degree: graph.nodes.map((n) => n.degree),
  geometry,
});

describe('the region contract', () => {
  it('gives every note a region, a side and a hub, and answers for the outline', () => {
    expect(view.shaped).toBe(true);
    expect(view.regions.length).toBeGreaterThan(1);
    for (let i = 0; i < graph.nodes.length; i += 1) {
      const region = view.regions[view.regionOf[i]!];
      expect(region, `note ${i} has no region`).toBeDefined();
      expect(region!.members).toContain(i);
      expect(Math.abs(region!.side)).toBe(1);
      expect(region!.hub).toBeGreaterThanOrEqual(0);
    }
    // Inside is inside, and the fissure is not.
    const first = view.regions[0]!;
    expect(view.inside(first.cx, first.cy)).toBe(true);
    expect(view.inside(0, 0)).toBe(false);
    expect(view.depthInside(first.cx, first.cy)).toBeGreaterThan(0);
    // Far outside, in every direction.
    for (const [x, y] of [
      [1e6, 0],
      [-1e6, 0],
      [0, 1e6],
      [0, -1e6],
    ] as const) {
      expect(view.inside(x, y)).toBe(false);
    }
  });
});

describe('where a link runs', () => {
  it('traces every link as a finite curve, bundled or not', () => {
    const out = new Float64Array((CURVE_STEPS + 1) * 2);
    let bundled = 0;
    for (let i = 0; i < graph.edges.length; i += 1) {
      const n = traceEdge(out, routes, i, layout.x, layout.y, geometry);
      expect(n).toBeGreaterThan(2);
      for (let k = 0; k < n * 2; k += 1) {
        expect(Number.isFinite(out[k]!), `edge ${i} point ${k}`).toBe(true);
      }
      // It starts and ends on the two cell bodies, whatever it does between.
      expect(out[0]).toBeCloseTo(layout.x[routes.hubEnd[i]!]!, 6);
      expect(out[(n - 1) * 2]).toBeCloseTo(layout.x[routes.leafEnd[i]!]!, 6);
      if (routes.via[i]! >= 0) bundled += 1;
    }
    expect(bundled).toBeGreaterThan(10);
  });

  it('bundles a link into another region through that region’s hub', () => {
    const out = new Float64Array((CURVE_STEPS + 1) * 2);
    /** How close a curve comes to a point, and how close the straight line does. */
    const nearest = (pts: Float64Array, n: number, px: number, py: number): number => {
      let best = Infinity;
      for (let k = 0; k < n; k += 1) best = Math.min(best, Math.hypot(pts[k * 2]! - px, pts[k * 2 + 1]! - py));
      return best;
    };

    let checked = 0;
    let closer = 0;
    for (let i = 0; i < graph.edges.length; i += 1) {
      const hub = routes.via[i]!;
      if (hub < 0) continue;
      const a = routes.hubEnd[i]!;
      const b = routes.leafEnd[i]!;
      const direct = Math.hypot(layout.x[b]! - layout.x[a]!, layout.y[b]! - layout.y[a]!);
      const detour =
        (Math.hypot(layout.x[hub]! - layout.x[a]!, layout.y[hub]! - layout.y[a]!) +
          Math.hypot(layout.x[b]! - layout.x[hub]!, layout.y[b]! - layout.y[hub]!)) /
        Math.max(1e-6, direct);
      // A detour too long to be worth a corridor is drawn straight on purpose.
      if (detour > 2.2) continue;
      const n = traceEdge(out, routes, i, layout.x, layout.y, geometry);
      const curved = nearest(out, n, layout.x[hub]!, layout.y[hub]!);

      // The same measurement for the straight line the link would otherwise be.
      const line = new Float64Array(n * 2);
      for (let k = 0; k < n; k += 1) {
        const t = k / (n - 1);
        line[k * 2] = layout.x[a]! + (layout.x[b]! - layout.x[a]!) * t;
        line[k * 2 + 1] = layout.y[a]! + (layout.y[b]! - layout.y[a]!) * t;
      }
      const straight = nearest(line, n, layout.x[hub]!, layout.y[hub]!);
      if (curved <= straight + 1e-6) closer += 1;
      // And it is a corridor plus a branch, not a hub-to-hub line.
      expect(b).not.toBe(hub);
      checked += 1;
    }
    // An aggregate, not a promise about every single link: a bow is a bow, and
    // where two notes already sit on top of the target hub the straight line is
    // unbeatable. What has to hold is that bundling moves the traffic onto the
    // corridors, and it does for the large majority.
    expect(checked).toBeGreaterThan(5);
    expect(closer / checked).toBeGreaterThan(0.75);
  });

  it('pulls a control point back inside the outline instead of out into the dark', () => {
    const region = view.regions[0]!;
    const out = { x: 0, y: 0 };
    // A point far outside, with the region's own centre as the anchor.
    keepInside(geometry, region.cx * 40, region.cy * 40, region.cx, region.cy, out);
    expect(view.inside(out.x, out.y)).toBe(true);
    // A point already inside is left alone.
    keepInside(geometry, region.cx, region.cy, region.cx, region.cy, out);
    expect(out.x).toBe(region.cx);
    expect(out.y).toBe(region.cy);
  });

  it('puts a note in one of three planes, the same one every time', () => {
    const planes = new Set<number>();
    for (const node of graph.nodes) {
      const plane = planeOf(node.degree, node.key);
      expect(plane).toBe(planeOf(node.degree, node.key));
      planes.add(plane);
    }
    expect(planes.size).toBe(3);
  });
});

describe('the tissue', () => {
  const deco = buildDecoration({
    view,
    x: layout.x,
    y: layout.y,
    warm: new Uint8Array(graph.nodes.length),
  });

  it('fills the outline with fog, folds, grain and branches', () => {
    expect(deco.fogCount).toBeGreaterThan(500);
    expect(deco.folds.length).toBeGreaterThan(20);
    expect(deco.dustCount).toBeGreaterThan(2000);
    expect(deco.dendriteCount).toBeGreaterThan(500);
  });

  it('never puts a grain or a branch outside the silhouette', () => {
    for (let i = 0; i < deco.dustCount; i += 1) {
      expect(view.inside(deco.dust[i * 5]!, deco.dust[i * 5 + 1]!), `grain ${i}`).toBe(true);
    }
    for (let i = 0; i < deco.dendriteCount; i += 1) {
      expect(view.inside(deco.dendrites[i * 6 + 2]!, deco.dendrites[i * 6 + 3]!), `branch ${i}`).toBe(true);
    }
    for (let i = 0; i < deco.fogCount; i += 1) {
      expect(view.inside(deco.fog[i * 3]!, deco.fog[i * 3 + 1]!), `fog ${i}`).toBe(true);
    }
  });

  it('fades out towards the rim rather than stopping at it', () => {
    // The dimmest fog is at the edge and the brightest in the middle, by
    // construction; what matters is that the weight actually reaches zero.
    let nearRim = 1;
    let deep = 0;
    for (let i = 0; i < deco.fogCount; i += 1) {
      const weight = deco.fog[i * 3 + 2]!;
      const room = view.depthInside(deco.fog[i * 3]!, deco.fog[i * 3 + 1]!);
      if (room < view.unit * 0.02) nearRim = Math.min(nearRim, weight);
      if (room > view.unit * 0.3) deep = Math.max(deep, weight);
    }
    expect(nearRim).toBeLessThan(0.35);
    expect(deep).toBeGreaterThan(0.9);
  });

  it('keeps every grain smaller and fainter than the smallest note', () => {
    // The two numbers that stop a grain reading as a note. The smallest cell
    // body in this vault is a couple of units across and is drawn with a white
    // core at full opacity; a grain is under a pixel wide, never fully opaque,
    // and has no core at all (see `renderer.ts`).
    let widest = 0;
    let loudest = 0;
    for (let i = 0; i < deco.dustCount; i += 1) {
      widest = Math.max(widest, deco.dust[i * 5 + 2]!);
      loudest = Math.max(loudest, deco.dust[i * 5 + 3]!);
    }
    expect(widest).toBeLessThanOrEqual(1);
    expect(loudest).toBeLessThanOrEqual(0.7);
    const smallest = Math.min(...Array.from(layout.r));
    expect(widest).toBeLessThan(smallest);
  });

  it('draws no branch as wide as the thinnest tract, or as long as its note is wide', () => {
    // Width is what keeps a branch from reading as a link: the narrowest tract
    // is `TRACT_BASE_MIN` per side, so twice that across, and a branch is under
    // a third of it at the cell body and a tenth at the tip.
    expect(DENDRITE_WIDTH).toBeLessThan(TRACT_BASE_MIN * 2);
    expect(DENDRITE_TIP_WIDTH).toBeLessThan(DENDRITE_WIDTH);
    // Its opacity sits between a held-back link and a quiet one, and the tissue
    // layer is dimmed again by `decoAlpha` on top of that.
    expect(DENDRITE_ALPHA).toBeGreaterThan(GHOST);
    // And a branch is short: no segment reaches further than a cell body is wide.
    const widest = Math.max(...Array.from(layout.r));
    for (let i = 0; i < deco.dendriteCount; i += 1) {
      const length = Math.hypot(
        deco.dendrites[i * 6 + 2]! - deco.dendrites[i * 6]!,
        deco.dendrites[i * 6 + 3]! - deco.dendrites[i * 6 + 1]!,
      );
      expect(length).toBeLessThan(widest * 2);
    }
  });

  it('is not grown at all for the loose neighbourhood arrangement', () => {
    const loose = new BrainLayout(graph, { arrangement: 'loose' });
    loose.settle();
    const looseView = regionView(loose);
    expect(looseView.shaped).toBe(false);
    const nothing = buildDecoration({
      view: looseView,
      x: loose.x,
      y: loose.y,
      warm: new Uint8Array(graph.nodes.length),
    });
    expect(nothing.dustCount).toBe(0);
    expect(nothing.dendriteCount).toBe(0);
  });
});

describe('the semantic zoom', () => {
  const builder = new SceneBuilder(graph);
  const at = (zoom: number): ReturnType<SceneBuilder['build']> => {
    const camera: Camera = { scale: zoom, x: ROOM / 2, y: ROOM / 2 };
    return builder.build(layout, new Activity(graph), camera, -1, ROOM, ROOM);
  };

  it('trades the tissue and the region names for the titles as the camera comes closer', () => {
    // The builder hands back the same scene object every time — it refills it in
    // place — so each distance is read off at once rather than held.
    const read = (zoom: number): { deco: number; regions: number; names: number; leaders: number } => {
      const s = at(zoom);
      return { deco: s.decoAlpha, regions: s.regionAlpha, names: s.labels.length, leaders: s.regions.length };
    };

    const over = read(1);
    expect(over.deco).toBe(1);
    expect(over.regions).toBe(1);
    expect(over.names).toBeLessThanOrEqual(4);

    const hubs = read(1.9);
    expect(hubs.names).toBeGreaterThan(over.names);
    expect(hubs.deco).toBeLessThan(1);

    const close = read(3);
    expect(close.deco).toBe(0);
    expect(close.regions).toBe(0);
    expect(close.leaders).toBe(0);
    expect(close.names).toBe(graph.nodes.length);
  });

  it('keeps the neighbourhood of a selected note named, however far out the camera is', () => {
    const hub = graph.hub;
    const scene = builder.build(layout, new Activity(graph), IDENTITY, hub, ROOM, ROOM);
    const named = new Set(scene.labels.map((l) => l.text));
    let neighbours = 0;
    for (const e of graph.touching[hub]!) {
      const other = graph.edges[e]!.a === hub ? graph.edges[e]!.b : graph.edges[e]!.a;
      const title = graph.nodes[other]!.title;
      if (named.has(title.length > 26 ? `${title.slice(0, 25)}…` : title)) neighbours += 1;
    }
    expect(neighbours).toBeGreaterThan(4);
  });
});

describe('the warm accent', () => {
  it('warms a note with how recently it was written, and lets it cool back to cyan', () => {
    const builder = new SceneBuilder(graph);
    const heat = new Float64Array(graph.nodes.length);
    // Written today, written a week ago, untouched for a month.
    heat[0] = 1;
    heat[1] = 0.5;
    heat[2] = 0;
    builder.recent(heat);
    const scene = builder.build(layout, new Activity(graph), IDENTITY, -1, ROOM, ROOM);

    const hot = scene.nodes[0]!;
    const half = scene.nodes[1]!;
    const cold = scene.nodes[2]!;
    // Since 2026-09-17 the warmth is not mixed into the body's colour — a mix
    // of cyan and amber is mint — but carried beside it, and drawn as an amber
    // core whose area is the warmth. What this guards is unchanged: the warmth
    // follows the age, all of it today and none a fortnight later, and the
    // accent grows with it without a step.
    expect(hot.warm).toBe(1);
    expect(half.warm).toBe(0.5);
    expect(cold.warm).toBe(0);
    expect(hot.warmColour).toEqual(amber(1));
    expect(half.warmColour).toEqual(amber(0.5));
    // The body's own colour is the same cool colour at any warmth.
    expect(hot.restColour).toEqual(scene.nodes[0]!.restColour);
    const light = (c: readonly number[]): number => c[0]! + c[1]! + c[2]!;
    expect(light(half.warmColour)).toBeGreaterThan(light(amber(0.01)));
    expect(light(half.warmColour)).toBeLessThan(light(hot.warmColour));
  });

  it('carries the same warmth into the links a note grows and the branches around it', () => {
    const builder = new SceneBuilder(graph);
    const heat = new Float64Array(graph.nodes.length);
    heat.fill(1);
    builder.recent(heat);
    const warm = builder.build(layout, new Activity(graph), IDENTITY, -1, ROOM, ROOM);
    const drawn = warm.edges.find((e) => e.alpha > 0.05)!;
    // The link keeps its cyan and carries the warmth of the note it grows out
    // of, which the renderer draws as amber reaching along it.
    expect(drawn.colour).toEqual(RAY);
    expect(drawn.warm).toBe(1);
    expect(drawn.warmColour).toEqual(amber(1));

    const branches = buildDecoration({ view, x: layout.x, y: layout.y, warm: heat });
    let hottest = 0;
    for (let i = 0; i < branches.dendriteCount; i += 1) {
      hottest = Math.max(hottest, branches.dendrites[i * 6 + 5]!);
    }
    expect(hottest).toBe(1);
  });

  it('draws a vault nobody has touched lately entirely in cyan', () => {
    const builder = new SceneBuilder(graph);
    builder.recent(new Float64Array(graph.nodes.length));
    const scene = builder.build(layout, new Activity(graph), IDENTITY, -1, ROOM, ROOM);
    for (const node of scene.nodes) expect(node.warm).toBe(0);
    for (const edge of scene.edges) expect(edge.warm).toBe(0);
  });
});

describe('what the cached layers are painted from', () => {
  /** The loop's own condition for stopping (`Brain.tsx`): nothing left moving. */
  const cold = (activity: Activity): boolean =>
    activity.sparks.length === 0 && !activity.fire.some((v) => v > 0) && !activity.warm.some((v) => v > 0);

  /** Everything the picture is drawn from, copied out: the builder refills one object in place. */
  const snapshot = (scene: ReturnType<SceneBuilder['build']>): unknown => ({
    nodes: scene.nodes.map((n) => [n.colour, n.alpha, n.glow, n.heat, n.restColour, n.restAlpha, n.restGlow, n.r]),
    edges: scene.edges.map((e) => [e.alpha, e.restAlpha, e.restTail, e.colour, e.w0, e.w1, e.strands]),
    sparks: scene.sparks.length,
    labels: scene.labels.map((l) => [l.text, l.alpha]),
    decoAlpha: scene.decoAlpha,
    regionAlpha: scene.regionAlpha,
  });

  const pulseOn = (activity: Activity, i: number): void => {
    const n = graph.nodes[i]!;
    activity.record([{ at: 0, kind: 'write', what: 'edit_note', path: n.path, who: 'jb', agent: true, owner: n.owner }]);
  };

  it('never lets a pulse into the resting values', () => {
    const builder = new SceneBuilder(graph);
    const calm = builder.build(layout, new Activity(graph), IDENTITY, -1, ROOM, ROOM);
    const rest = {
      nodes: calm.nodes.map((n) => [n.restColour, n.restAlpha, n.restGlow]),
      edges: calm.edges.map((e) => [e.restAlpha, e.restTail, e.strands]),
    };

    const busy = new Activity(graph);
    for (let i = 0; i < graph.nodes.length; i += 7) pulseOn(busy, i);
    for (let k = 0; k < 12; k += 1) busy.advance();
    const hot = builder.build(layout, busy, IDENTITY, -1, ROOM, ROOM);

    // The pulse is on screen...
    expect(hot.nodes.some((n) => n.heat > 0)).toBe(true);
    expect(hot.edges.some((e) => e.alpha > e.restAlpha)).toBe(true);
    // ...and not in anything a cached layer is painted from.
    expect({
      nodes: hot.nodes.map((n) => [n.restColour, n.restAlpha, n.restGlow]),
      edges: hot.edges.map((e) => [e.restAlpha, e.restTail, e.strands]),
    }).toEqual(rest);
  });

  it('brings every transition back to exactly its resting value before the loop would stop', () => {
    const hub = graph.hub;
    const builder = new SceneBuilder(graph);
    const activity = new Activity(graph);
    const before = snapshot(builder.build(layout, activity, IDENTITY, -1, ROOM, ROOM));

    // A pulse, and while it is bright a note is selected and let go again —
    // the sequence that used to leave a glow baked into the cached layers.
    pulseOn(activity, hub);
    activity.advance();
    builder.build(layout, activity, IDENTITY, hub, ROOM, ROOM);
    activity.advance();
    builder.build(layout, activity, IDENTITY, -1, ROOM, ROOM);

    let frames = 0;
    while (!cold(activity)) {
      activity.advance();
      builder.build(layout, activity, IDENTITY, -1, ROOM, ROOM);
      frames += 1;
      expect(frames, 'the pulse never goes cold').toBeLessThan(5000);
    }
    // The frame the loop stops on shows exactly what it showed before.
    expect(snapshot(builder.build(layout, activity, IDENTITY, -1, ROOM, ROOM))).toEqual(before);
  });
});
