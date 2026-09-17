/**
 * The cores, the depth planes and the centre.
 *
 * What the screenshot can show and a test has to hold: a body is coloured light
 * rather than white, the three planes differ in size, opacity and hue in the
 * same direction, a note is never drawn larger than the hit test's outline, and
 * the centre's rays and branches stay decoration — never a ghost brought back,
 * never outside the silhouette, gone once the camera comes closer.
 */

import { describe, expect, it } from 'vitest';

import { Activity } from '../src/brain/activity';
import type { Camera } from '../src/brain/camera';
import { fit } from '../src/brain/camera';
import type { RayFork } from '../src/brain/edges';
import { FORK_POINTS, MAP_DEGREE, RAY_FORKS, VISIBLE, branchRay, planRoutes } from '../src/brain/edges';
import { BrainLayout } from '../src/brain/layout';
import { buildGraph } from '../src/brain/model';
import { regionView } from '../src/brain/regions';
import {
  HUB_PLANES,
  NOTE_PLANES,
  PLANE_LIGHT,
  PLANE_SIZE,
  RECENT_DAYS,
  SceneBuilder,
  accentShare,
  bodyRadius,
} from '../src/brain/scene';
import { paraVault } from './fixtures/para-vault';

const graph = buildGraph(paraVault().data);
const layout = new BrainLayout(graph, { arrangement: 'brain' });
layout.settle();
const view = regionView(layout);
const W = 1400;
const H = 900;
const overview = (): Camera => fit(layout.bounds, W, H, { top: 0, right: 0, bottom: 0, left: 0 });

const forks = (): RayFork[] =>
  Array.from({ length: RAY_FORKS }, () => ({ pts: new Float64Array(FORK_POINTS * 2), n: 0, at: 0, twig: false }));

describe('the cores', () => {
  it('are coloured light: no resting body of a cool note is white', () => {
    const builder = new SceneBuilder(graph);
    builder.recent(new Float64Array(graph.nodes.length));
    const scene = builder.build(layout, new Activity(graph), overview(), -1, W, H);
    for (const n of scene.nodes) {
      const [r, g, b] = n.restColour;
      // A colour, not a grey or a white: the channels are far apart, and red
      // stays well down. The dim note with no links is the closest to grey.
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThanOrEqual(50);
      expect(r).toBeLessThan(130);
    }
  });

  it('go smaller, fainter and bluer from the front plane to the back one', () => {
    for (let p = 0; p < 2; p += 1) {
      expect(PLANE_SIZE[p]!).toBeLessThan(PLANE_SIZE[p + 1]!);
      expect(PLANE_LIGHT[p]!).toBeLessThan(PLANE_LIGHT[p + 1]!);
      for (const planes of [HUB_PLANES, NOTE_PLANES]) {
        const back = planes[p]!;
        const front = planes[p + 1]!;
        // Less light in all, and a larger share of it blue.
        expect(back[0] + back[1] + back[2]).toBeLessThan(front[0] + front[1] + front[2]);
        expect(back[2] / (back[0] + back[1] + back[2])).toBeGreaterThan(front[2] / (front[0] + front[1] + front[2]));
      }
    }
    expect(PLANE_SIZE[2]).toBe(1);
  });

  it('are never drawn larger than the outline the hit test uses', () => {
    const builder = new SceneBuilder(graph);
    for (const zoom of [1, 3]) {
      const camera = overview();
      const scene = builder.build(layout, new Activity(graph), { ...camera, scale: camera.scale * zoom }, -1, W, H);
      graph.nodes.forEach((node, i) => {
        expect(scene.nodes[i]!.r).toBeLessThanOrEqual(bodyRadius(layout.r[i]!, node.depth) + 1e-9);
      });
    }
  });
});

describe('the warm accent', () => {
  const DAY = 1 / RECENT_DAYS;
  it('is none at all after a fortnight and all of it the day a note was written', () => {
    expect(accentShare(0)).toBe(0);
    expect(accentShare(1)).toBe(1);
  });

  it('rises with the warmth without a step anywhere', () => {
    let last = 0;
    for (let k = 1; k <= 1000; k += 1) {
      const share = accentShare(k / 1000);
      expect(share).toBeGreaterThan(last);
      expect(share - last).toBeLessThan(0.02);
      last = share;
    }
  });

  it('is amber for the last few days and cyan with a trace for the rest of the fortnight', () => {
    expect(accentShare(1 - 2 * DAY)).toBeGreaterThan(0.8);
    expect(accentShare(1 - 6 * DAY)).toBeLessThan(0.1);
  });
});

describe('the centre', () => {
  const hub = graph.hub;

  it('is the best-connected map, and there is one', () => {
    expect(graph.nodes[hub]!.degree).toBeGreaterThanOrEqual(MAP_DEGREE);
    const scene = new SceneBuilder(graph).build(layout, new Activity(graph), overview(), -1, W, H);
    expect(scene.nodes.filter((n) => n.centre).length).toBe(1);
    expect(scene.nodes[hub]!.centre).toBe(true);
  });

  it('radiates only along its own links, and never brings back a ghost', () => {
    const scene = new SceneBuilder(graph).build(layout, new Activity(graph), overview(), -1, W, H);
    let rays = 0;
    graph.edges.forEach((edge, i) => {
      const e = scene.edges[i]!;
      if (e.radiant > 0) {
        rays += 1;
        expect(edge.a === hub || edge.b === hub).toBe(true);
        expect(e.restAlpha).toBeGreaterThanOrEqual(VISIBLE);
      }
    });
    expect(rays).toBeGreaterThan(10);
  });

  it('sends its rays straight out rather than bundled through other hubs', () => {
    const geometry = { inside: view.inside, depthInside: view.depthInside, regionOf: view.regionOf, regions: view.regions };
    const args = { edges: graph.edges, keys: graph.nodes.map((n) => n.key), degree: graph.nodes.map((n) => n.degree), geometry };
    const plain = planRoutes(args);
    const centred = planRoutes({ ...args, centre: hub });
    graph.edges.forEach((_, i) => {
      if (centred.hubEnd[i] === hub) {
        expect(centred.ray[i]).toBe(1);
        expect(centred.via[i]).toBe(-1);
      } else {
        // Every other link keeps exactly its route.
        expect(centred.ray[i]).toBe(0);
        expect(centred.via[i]).toBe(plain.via[i]);
      }
    });
  });

  it('branches inside the silhouette, thinner than the ray it grows from', () => {
    const scene = new SceneBuilder(graph).build(layout, new Activity(graph), overview(), -1, W, H);
    expect(scene.forks.length).toBeGreaterThan(10);
    const widest = Math.max(...scene.edges.filter((e) => e.radiant > 0).map((e) => e.w0));
    for (const f of scene.forks) {
      expect(f.n).toBeGreaterThanOrEqual(2);
      expect(f.w0).toBeLessThanOrEqual(widest);
      expect(f.alpha).toBeGreaterThan(0);
      for (let k = 0; k < f.n; k += 1) {
        expect(Number.isFinite(f.pts[k * 2]!)).toBe(true);
        expect(view.inside(f.pts[k * 2]!, f.pts[k * 2 + 1]!)).toBe(true);
      }
    }
  });

  it('lets its branches go with the tissue as the camera comes closer', () => {
    const builder = new SceneBuilder(graph);
    const camera = overview();
    const near = builder.build(layout, new Activity(graph), { ...camera, scale: camera.scale * 3 }, -1, W, H);
    expect(near.decoAlpha).toBe(0);
    expect(near.forks.length).toBe(0);
  });

  it('has no centre in the loose neighbourhood arrangement', () => {
    const loose = new BrainLayout(graph, { arrangement: 'loose' });
    const scene = new SceneBuilder(graph).build(loose, new Activity(graph), { scale: 1, x: 0, y: 0 }, -1, W, H);
    expect(scene.nodes.some((n) => n.centre)).toBe(false);
    expect(scene.edges.some((e) => e.radiant > 0)).toBe(false);
    expect(scene.forks.length).toBe(0);
  });
});

describe('a ray’s branches', () => {
  /** A gently bent ray from (0, 0) to (400, 0). */
  const ray = (length: number): { pts: Float64Array; n: number } => {
    const n = 25;
    const pts = new Float64Array(n * 2);
    for (let i = 0; i < n; i += 1) {
      const t = i / (n - 1);
      pts[i * 2] = length * t;
      pts[i * 2 + 1] = 30 * t * (1 - t);
    }
    return { pts, n };
  };

  it('grow the same way for the same pair, every time', () => {
    const { pts, n } = ray(400);
    const a = forks();
    const b = forks();
    const count = branchRay(pts, n, 'hub|leaf', null, a);
    expect(count).toBeGreaterThan(2);
    expect(count).toBeLessThanOrEqual(RAY_FORKS);
    expect(branchRay(pts, n, 'hub|leaf', null, b)).toBe(count);
    for (let k = 0; k < count; k += 1) expect(Array.from(b[k]!.pts)).toEqual(Array.from(a[k]!.pts));
  });

  it('stay short beside their ray, and a ray too short grows none', () => {
    const { pts, n } = ray(400);
    const out = forks();
    const count = branchRay(pts, n, 'a|b', null, out);
    for (let k = 0; k < count; k += 1) {
      const f = out[k]!;
      const reach = Math.hypot(f.pts[(f.n - 1) * 2]! - f.pts[0]!, f.pts[(f.n - 1) * 2 + 1]! - f.pts[1]!);
      expect(reach).toBeLessThan(400 * 0.3);
    }
    const short = ray(20);
    expect(branchRay(short.pts, short.n, 'a|b', null, forks())).toBe(0);
  });

  it('stop at the first point outside', () => {
    const { pts, n } = ray(400);
    const out = forks();
    // Everything below the ray's own band is outside.
    const inside = (_x: number, y: number): boolean => Math.abs(y) < 12;
    const count = branchRay(pts, n, 'a|b', inside, out);
    for (let k = 0; k < count; k += 1) {
      for (let j = 0; j < out[k]!.n; j += 1) expect(inside(0, out[k]!.pts[j * 2 + 1]!)).toBe(true);
    }
  });
});
