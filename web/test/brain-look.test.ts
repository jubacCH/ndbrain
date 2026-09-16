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
import { regionLabels, regionView } from '../src/brain/regions';
import { SceneBuilder, planeOf } from '../src/brain/scene';
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

describe('the names', () => {
  it('writes every region’s name outside the outline, with a leader into it', () => {
    const labels = regionLabels(view, layout.x, layout.y);
    expect(labels.length).toBe(view.regions.length);
    for (const label of labels) {
      expect(view.inside(label.x, label.y), `${label.text} sits on the brain`).toBe(false);
      // The leader starts at one of the region's own notes — the one nearest the
      // rim, not the hub across the cell, which would read as a link.
      const members = view.regions[label.region]!.members;
      const from = members.find((i) => layout.x[i] === label.fromX && layout.y[i] === label.fromY);
      expect(from, `${label.text} points at nothing`).toBeDefined();
      expect(Number.isFinite(label.cx) && Number.isFinite(label.cy)).toBe(true);
    }
  });

  it('pushes two names on the same flank apart', () => {
    const labels = regionLabels(view, layout.x, layout.y);
    for (const align of ['left', 'right'] as const) {
      const column = labels.filter((l) => l.align === align).sort((a, b) => a.y - b.y);
      for (let i = 1; i < column.length; i += 1) {
        expect(column[i]!.y - column[i - 1]!.y).toBeGreaterThanOrEqual(0.16 * view.unit - 1e-6);
      }
    }
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
