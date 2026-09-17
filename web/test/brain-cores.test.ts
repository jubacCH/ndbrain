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
  FOCUS_EDGE_DIM,
  FOCUS_NODE_DIM,
  HUB_PLANES,
  NOTE_PLANES,
  PLANE_LIGHT,
  PLANE_SIZE,
  SceneBuilder,
  WARM_HUE,
  amber,
  bodyRadius,
} from '../src/brain/scene';
import { createCanvasRenderer } from '../src/brain/renderer';
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

/** 8-bit sRGB to OKLCH: lightness, chroma, hue in degrees. */
function toOklch(r: number, g: number, b: number): { l: number; c: number; h: number } {
  const lin = (v: number): number => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = ((Math.atan2(Bb, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c: Math.hypot(A, Bb), h };
}

type Lch = { l: number; c: number; h: number; text: string };

/** Every colour in a CSS colour string, as OKLCH. */
function coloursIn(style: string): Lch[] {
  const out: Lch[] = [];
  for (const m of style.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)/g)) {
    out.push({ ...toOklch(Number(m[1]), Number(m[2]), Number(m[3])), text: m[0] });
  }
  return out;
}

/**
 * The band between the two hues: greens and mints. A colour here with any
 * real chroma is what a blend of cyan and amber looks like.
 */
const MINT = { from: 100, to: 180, chroma: 0.025 };
const isMint = (c: { c: number; h: number }): boolean => c.c > MINT.chroma && c.h > MINT.from && c.h < MINT.to;

describe('the warm accent', () => {
  it('keeps one amber hue across the whole fortnight, brighter the more recent', () => {
    let last = -1;
    for (let k = 0; k <= 1000; k += 1) {
      const [r, g, b] = amber(k / 1000);
      const c = toOklch(r, g, b);
      // The map's hue, give or take what rounding to 8 bits does.
      expect(Math.abs(c.h - WARM_HUE), `warmth ${k / 1000}: ${r},${g},${b}`).toBeLessThan(3);
      expect(c.l).toBeGreaterThanOrEqual(last - 1e-3);
      last = c.l;
    }
  });

  it('is never drawn as a blend: no colour the renderer is handed is mint, at any warmth', () => {
    const styles: string[] = [];
    const gradient = { addColorStop: (_: number, colour: string) => styles.push(colour) };
    const ctx = {
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      lineWidth: 1,
      lineCap: 'butt',
      font: '',
      textAlign: 'start',
      textBaseline: 'alphabetic',
      lineJoin: 'miter',
      set fillStyle(v: unknown) {
        if (typeof v === 'string') styles.push(v);
      },
      get fillStyle(): unknown {
        return '';
      },
      set strokeStyle(v: unknown) {
        if (typeof v === 'string') styles.push(v);
      },
      get strokeStyle(): unknown {
        return '';
      },
      setTransform: () => {},
      fillRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
      fillText: () => {},
      strokeText: () => {},
      quadraticCurveTo: () => {},
      drawImage: () => {},
      measureText: (t: string) => ({ width: t.length * 6 }),
      createRadialGradient: () => gradient,
      createLinearGradient: () => gradient,
    };
    const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
    const paint = createCanvasRenderer(canvas);
    paint.resize(W, H);

    // Eleven steps and both ends; each step grows the tissue once, which is
    // what the explicit timeout below is for on a busy runner.
    for (const warmth of [0, 0.02, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.98, 1]) {
      const builder = new SceneBuilder(graph);
      builder.recent(new Float64Array(graph.nodes.length).fill(warmth));
      // Settled layout, overview: bodies, links, rays, branches and the tissue.
      const scene = builder.build(layout, new Activity(graph), overview(), -1, W, H);
      const before = styles.length;
      paint.draw(scene);
      expect(styles.length).toBeGreaterThan(before);
    }
    const all = styles.flatMap(coloursIn);
    const mint = all.filter(isMint);
    expect(mint.map((c) => `${c.text} (h ${c.h.toFixed(0)}, c ${c.c.toFixed(3)})`)).toEqual([]);
    // And the amber is really there, so the check above is not passing on nothing.
    expect(all.some((c) => Math.abs(c.h - WARM_HUE) < 4 && c.c > 0.05)).toBe(true);
  }, 30_000);

  it('recognises a blend of cyan and amber as mint', () => {
    // The check itself, against the colour the straight mix used to produce.
    const [r0, g0, b0] = NOTE_PLANES[2];
    const [r1, g1, b1] = amber(1);
    const half = toOklch(Math.round((r0 + r1) / 2), Math.round((g0 + g1) / 2), Math.round((b0 + b1) / 2));
    expect(isMint(half)).toBe(true);
    expect(isMint(toOklch(r0, g0, b0))).toBe(false);
    expect(isMint(toOklch(r1, g1, b1))).toBe(false);
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

describe('the focus mode', () => {
  const pick = graph.hub;
  const related = new Set<number>([pick]);
  for (const e of graph.touching[pick]!) {
    related.add(graph.edges[e]!.a);
    related.add(graph.edges[e]!.b);
  }
  const touches = (i: number): boolean => graph.edges[i]!.a === pick || graph.edges[i]!.b === pick;

  /** Copied out: the builder refills one scene in place. */
  const values = (scene: ReturnType<SceneBuilder['build']>) => ({
    nodes: scene.nodes.map((n) => [n.alpha, n.restAlpha]),
    edges: scene.edges.map((e) => [e.alpha, e.restAlpha, e.radiant]),
  });

  it('dims every note and link that has nothing to do with the selection, and only those', () => {
    const builder = new SceneBuilder(graph);
    const calm = values(builder.build(layout, new Activity(graph), overview(), -1, W, H));
    const picked = builder.build(layout, new Activity(graph), overview(), pick, W, H);
    expect(related.size).toBeLessThan(graph.nodes.length);
    graph.nodes.forEach((_, i) => {
      const before = calm.nodes[i]![1]!;
      const expected = related.has(i) ? before : before * FOCUS_NODE_DIM;
      expect(picked.nodes[i]!.restAlpha, `note ${i}`).toBeCloseTo(expected, 12);
    });
    let dimmed = 0;
    graph.edges.forEach((_, i) => {
      if (touches(i)) return;
      const before = calm.edges[i]![1]!;
      expect(picked.edges[i]!.restAlpha, `link ${i}`).toBeCloseTo(before * FOCUS_EDGE_DIM, 12);
      if (before > 0) dimmed += 1;
    });
    expect(dimmed).toBeGreaterThan(10);
    expect(FOCUS_NODE_DIM).toBeLessThanOrEqual(0.3);
    expect(FOCUS_EDGE_DIM).toBeLessThanOrEqual(0.35);
  });

  it('repaints the cached layers on every change of selection, and returns exactly to rest', () => {
    const builder = new SceneBuilder(graph);
    const activity = new Activity(graph);
    const calm = builder.build(layout, activity, overview(), -1, W, H);
    const before = values(calm);
    const stampCalm = calm.stamp;
    const stampPicked = builder.build(layout, activity, overview(), pick, W, H).stamp;
    expect(stampPicked).not.toBe(stampCalm);
    // The same selection again: nothing to repaint.
    expect(builder.build(layout, activity, overview(), pick, W, H).stamp).toBe(stampPicked);
    // Another note selected: a new picture.
    const other = graph.nodes.findIndex((_, i) => !related.has(i));
    expect(builder.build(layout, activity, overview(), other, W, H).stamp).not.toBe(stampPicked);
    const back = builder.build(layout, activity, overview(), -1, W, H);
    expect(back.stamp).not.toBe(stampPicked);
    expect(values(back)).toEqual(before);
  });

  it('keeps a pulse on a dimmed note and along a dimmed link at full strength', () => {
    const far = graph.nodes.findIndex((_, i) => !related.has(i) && graph.touching[i]!.some((e) => !touches(e)));
    expect(far).toBeGreaterThanOrEqual(0);
    const pulse = (): Activity => {
      const activity = new Activity(graph);
      const n = graph.nodes[far]!;
      activity.record([{ at: 0, kind: 'write', what: 'edit_note', path: n.path, who: 'jb', agent: true, owner: n.owner }]);
      for (let k = 0; k < 6; k += 1) activity.advance();
      return activity;
    };
    const free = new SceneBuilder(graph).build(layout, pulse(), overview(), -1, W, H);
    const focused = new SceneBuilder(graph).build(layout, pulse(), overview(), pick, W, H);
    const a = free.nodes[far]!;
    const b = focused.nodes[far]!;
    expect(b.heat).toBeGreaterThan(0);
    expect(b.heat).toBe(a.heat);
    expect(b.restAlpha).toBeLessThan(a.restAlpha);
    // What the pulse adds over the resting body is the same, dimmed or not.
    expect(b.alpha - b.restAlpha).toBeCloseTo(a.alpha - a.restAlpha, 12);
    // A spark lights its link as strongly as without a selection.
    const sparked = graph.edges.map((_, i) => i).filter((i) => free.edges[i]!.alpha > free.edges[i]!.restAlpha + 0.1);
    expect(sparked.length).toBeGreaterThan(0);
    for (const i of sparked) {
      if (touches(i)) continue;
      expect(focused.edges[i]!.alpha).toBeCloseTo(free.edges[i]!.alpha, 12);
    }
  });

  it('leaves the neighbourhood beside an open note as it was', () => {
    const loose = new BrainLayout(graph, { arrangement: 'loose' });
    const camera = { scale: 1, x: 0, y: 0 };
    const builder = new SceneBuilder(graph);
    const calm = values(builder.build(loose, new Activity(graph), camera, -1, W, H));
    const picked = values(builder.build(loose, new Activity(graph), camera, pick, W, H));
    expect(picked.nodes).toEqual(calm.nodes);
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
