/**
 * The canvas renderer.
 *
 * Takes a scene and paints it. It does not know that a simulation exists, what a
 * note is, or why one cell body is brighter than another — every one of those
 * decisions arrived already made, as a number on a `SceneNode`. What is left
 * here is the part that a WebGL implementation would have to redo and nothing
 * else, which is the point: `BrainRenderer` is the whole contract.
 *
 * **Four passes, and only one of them runs every frame.**
 *
 *  1. The ground: a dark gradient in screen space, because it is the room the
 *     brain is in and not a thing in the room.
 *  2. The tissue (`deco.ts`), into its own cached layer. It is decoration: it is
 *     never hit tested, and it fades out as the camera comes closer.
 *  3. Three depth planes of notes and links, each into a cached layer with a
 *     blurred copy added back over it. Which plane a note is in comes from the
 *     scene; the parallax only shifts the finished layers against each other, so
 *     moving the pointer costs three `drawImage` calls and no painting at all.
 *  4. Live on top, every frame: pulses, the ring under the pointer, and text.
 *     These are the only things that change without the camera changing, and
 *     keeping them out of the cached layers is what lets a spark run across a
 *     settled brain without repainting or re-blurring anything.
 *
 * A tract is a tapered polygon filled with a gradient, not a stroke: wide where
 * it leaves the better-connected note and thinning to a thread at the other end,
 * so a link visibly grows out of a neuron instead of lying beside it. Its
 * opacity arrives as `globalAlpha`, exactly as before — the gradient only says
 * how the far end fades relative to the near one.
 *
 * Two things stay in screen space while everything else goes through the camera:
 * the background, and the device-pixel ratio, which is a property of the display
 * and is folded into the same transform so that nothing downstream ever
 * multiplies by it again.
 */

import { CachedLayer, Sprites } from './bloom';
import type { Decoration } from './deco';
import { LINE_HEIGHT, placeRegionNames } from './labels';
import { DENDRITE_ALPHA, DENDRITE_TIP_ALPHA, DENDRITE_TIP_WIDTH, DENDRITE_WIDTH, TISSUE_LEVEL } from './deco';
import type { Depth, Rgb, Scene, SceneEdge, SceneNode } from './scene';
import { FOCUSED } from './scene';

export interface BrainRenderer {
  /** CSS pixels; the backing store is sized from this and the display's ratio. */
  resize(width: number, height: number): void;
  draw(scene: Scene): void;
  dispose(): void;
}

/** Below this opacity a tract is not worth a path: nothing on screen would change. */
const INVISIBLE = 0.004;
/** How far each plane is shifted by the pointer, in CSS pixels at full deflection. */
const PARALLAX_X = 7;
const PARALLAX_Y = 5;
/** The tissue sits furthest back of all. */
const TISSUE_PLANE = -0.7;
/** The three planes' parallax factors. */
const PLANE_Z: readonly number[] = [-1, 0, 1];
/** Blur radius of a plane's bloom, in half-resolution pixels. */
const PLANE_BLUR = 11;
const TISSUE_BLUR = 9;
/** How strongly a bloom is added back over its own layer. */
const BLOOM_STRENGTH = 0.32;
const TISSUE_BLOOM = 0.4;

const rgba = (c: Rgb, a: number): string => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** Where a tract cools to at its far end, and a selected one. The prototype's colours. */
const TAIL: Rgb = [60, 200, 215];
const FOCUS_TAIL: Rgb = [120, 230, 245];
/** How far a hub's parallel fibres bow away from the ray, as a share of its length. */
const FIBRE_BOW = 0.06;
/** A note this much of a hub (see `SceneNode.hub`) gets the wide second halo. */
const HUB_HALO = 0.25;

export function createCanvasRenderer(canvas: HTMLCanvasElement): BrainRenderer {
  const ctx = canvas.getContext('2d');
  let dpr = 1;
  const sprites = new Sprites();
  const planes = [new CachedLayer(), new CachedLayer(), new CachedLayer()];
  const tissue = new CachedLayer();
  // One outline buffer, x and y interleaved, left side then right. Filled per
  // tract instead of two fresh arrays of pairs per tract per frame.
  let outline = new Float64Array(256);

  const resize = (width: number, height: number): void => {
    // Capped at 2. A phone claiming 3 or 4 asks for nine to sixteen times the
    // fill for a difference nobody sees on a glow.
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
  };

  /** Puts the canvas into world units for the camera of this scene. */
  const world = (g: CanvasRenderingContext2D, scene: Scene): void => {
    const { camera } = scene;
    g.setTransform(dpr * camera.scale, 0, 0, dpr * camera.scale, dpr * camera.x, dpr * camera.y);
  };

  /**
   * A tapered polygon along the curve, filled with a gradient.
   *
   * `bow` bends a copy of the curve sideways — zero at both ends, most in the
   * middle, as a share of the link's length — and `thin` narrows it: that is
   * how a hub's ray gets its parallel fibres without tracing the curve again.
   */
  const tract = (
    g: CanvasRenderingContext2D,
    e: SceneEdge,
    alpha: number,
    tail: number,
    bow = 0,
    thin = 1,
  ): void => {
    const n = e.n;
    if (n < 2 || alpha < INVISIBLE) return;
    if (outline.length < n * 4) outline = new Float64Array(n * 4);
    const chord = bow === 0 ? 0 : Math.hypot(e.pts[(n - 1) * 2]! - e.pts[0]!, e.pts[(n - 1) * 2 + 1]! - e.pts[1]!);

    for (let i = 0; i < n; i += 1) {
      const ahead = Math.min(n - 1, i + 1);
      const behind = Math.max(0, i - 1);
      const tx = e.pts[ahead * 2]! - e.pts[behind * 2]!;
      const ty = e.pts[ahead * 2 + 1]! - e.pts[behind * 2 + 1]!;
      const tl = Math.hypot(tx, ty) || 1;
      const t = i / (n - 1);
      const lean = bow * chord * 4 * t * (1 - t);
      const px = e.pts[i * 2]! + (-ty / tl) * lean;
      const py = e.pts[i * 2 + 1]! + (tx / tl) * lean;
      const w = (e.w0 + (e.w1 - e.w0) * t) * thin;
      const nx = (-ty / tl) * w;
      const ny = (tx / tl) * w;
      outline[i * 4] = px + nx;
      outline[i * 4 + 1] = py + ny;
      outline[i * 4 + 2] = px - nx;
      outline[i * 4 + 3] = py - ny;
    }

    // A gradient refuses a non-finite coordinate by throwing, and a throw inside
    // the frame kills the loop for good — the view would freeze rather than lose
    // one line. One malformed curve is skipped instead.
    const x0 = e.pts[0]!;
    const y0 = e.pts[1]!;
    const x1 = e.pts[(n - 1) * 2]!;
    const y1 = e.pts[(n - 1) * 2 + 1]!;
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return;

    const grad = g.createLinearGradient(x0, y0, x1, y1);
    // The opacity itself is `globalAlpha`; the gradient says how the far end
    // fades against the near one, and cools as it goes — bright where the link
    // leaves the better-connected note, a deeper teal at the leaf, as in the
    // optics prototype.
    grad.addColorStop(0, rgba(e.colour, 1));
    grad.addColorStop(1, rgba(e.colour === FOCUSED ? FOCUS_TAIL : TAIL, Math.min(1, tail / Math.max(1e-6, alpha))));
    g.fillStyle = grad;
    g.globalAlpha = Math.min(1, alpha);
    g.beginPath();
    g.moveTo(outline[0]!, outline[1]!);
    for (let i = 1; i < n; i += 1) g.lineTo(outline[i * 4]!, outline[i * 4 + 1]!);
    for (let i = n - 1; i >= 0; i -= 1) g.lineTo(outline[i * 4 + 2]!, outline[i * 4 + 3]!);
    g.closePath();
    g.fill();
  };

  /**
   * The glowing body of one note: a sprite halo, a coloured disc, a white core —
   * and for a hub one more halo, wide and faint: a star that radiates, not a sun
   * that drowns its region.
   */
  const body = (g: CanvasRenderingContext2D, n: SceneNode): void => {
    // Resting values only. This is painted into a cached layer, and the cache
    // does not know about pulses (see `SceneNode.restColour`).
    const halo = n.r * (1.7 + n.restGlow * 0.9 + n.hub * 1.4);
    const sprite = sprites.halo(n.warm >= 0.4 ? 'warm' : 'cyan', halo);
    const haloAlpha = Math.min(1, (0.2 + 0.24 * n.restGlow) * n.restAlpha);
    g.globalAlpha = haloAlpha;
    if (sprite !== null) g.drawImage(sprite, n.x - halo, n.y - halo, halo * 2, halo * 2);
    else {
      const grad = g.createRadialGradient(n.x, n.y, 0, n.x, n.y, halo);
      grad.addColorStop(0, rgba(n.restColour, 0.5));
      grad.addColorStop(1, rgba(n.restColour, 0));
      g.fillStyle = grad;
      g.beginPath();
      g.arc(n.x, n.y, halo, 0, Math.PI * 2);
      g.fill();
    }
    if (sprite !== null && n.hub >= HUB_HALO) {
      const wide = halo * 2.6;
      g.globalAlpha = haloAlpha * 0.2;
      g.drawImage(sprite, n.x - wide, n.y - wide, wide * 2, wide * 2);
    }

    g.globalAlpha = Math.min(1, n.restAlpha);
    g.fillStyle = rgba(n.restColour, 0.85);
    g.beginPath();
    g.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    g.fill();
    const core = sprites.halo('core', n.r * 1.3);
    if (core !== null) g.drawImage(core, n.x - n.r * 1.3, n.y - n.r * 1.3, n.r * 2.6, n.r * 2.6);
    // The white core: what makes a note the brightest thing in the picture.
    g.globalAlpha = 1;
    g.fillStyle = `rgba(255,255,255,${Math.min(1, 0.55 + 0.45 * n.restAlpha)})`;
    g.beginPath();
    g.arc(n.x, n.y, n.r * 0.5, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
  };

  /** One depth plane: the links whose thick end is in it, then its notes. */
  const paintPlane = (g: CanvasRenderingContext2D, scene: Scene, plane: Depth): void => {
    world(g, scene);
    g.globalCompositeOperation = 'lighter';
    for (const e of scene.edges) {
      if (e.depth !== plane) continue;
      tract(g, e, e.restAlpha, e.restTail);
      // The same link twice more, fainter, narrower and bent either side: a
      // hub's rays then read as bundles of fibres rather than single ribbons.
      // The prototype's values: 45 % and 35 % of the width, 35 % and 25 % of
      // the opacity, fading out entirely before the leaf.
      if (!e.strands) continue;
      tract(g, e, e.restAlpha * 0.35, 0, FIBRE_BOW, 0.45);
      tract(g, e, e.restAlpha * 0.25, 0, -FIBRE_BOW * 0.6, 0.35);
    }
    g.globalAlpha = 1;
    for (const i of scene.order) {
      const n = scene.nodes[i]!;
      if (n.depth !== plane) continue;
      body(g, n);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  };

  /** The tissue: fog, folds, grain, branches. All of it decoration. */
  const paintTissue = (g: CanvasRenderingContext2D, scene: Scene): void => {
    world(g, scene);
    g.globalCompositeOperation = 'lighter';
    const deco: Decoration = scene.deco;
    const dim = scene.decoAlpha;

    const r = deco.fogRadius;
    for (let i = 0; i < deco.fogCount; i += 1) {
      const x = deco.fog[i * 3]!;
      const y = deco.fog[i * 3 + 1]!;
      const a = deco.fogAlpha * dim * deco.fog[i * 3 + 2]!;
      if (a < 0.0005) continue;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(22,120,135,${a})`);
      grad.addColorStop(1, 'rgba(22,120,135,0)');
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }

    g.lineCap = 'round';
    g.lineWidth = 0.6 / scene.camera.scale;
    for (const fold of deco.folds) {
      g.strokeStyle = `rgba(60,180,195,${fold.alpha * 1.6 * dim * TISSUE_LEVEL})`;
      polyline(g, fold.pts, fold.n);
    }
    g.lineWidth = 1.1 / scene.camera.scale;
    for (const sulcus of deco.sulci) {
      g.strokeStyle = `rgba(45,140,155,${sulcus.alpha * dim * TISSUE_LEVEL})`;
      polyline(g, sulcus.pts, sulcus.n);
    }

    const grain = 1 / scene.camera.scale;
    for (let i = 0; i < deco.dustCount; i += 1) {
      const x = deco.dust[i * 5]!;
      const y = deco.dust[i * 5 + 1]!;
      const size = deco.dust[i * 5 + 2]! * grain;
      const a = deco.dust[i * 5 + 3]! * dim * TISSUE_LEVEL;
      const warm = deco.dust[i * 5 + 4]! === 1;
      g.fillStyle = warm ? `rgba(200,160,100,${a * 0.8})` : `rgba(80,195,210,${a})`;
      g.beginPath();
      g.arc(x, y, size, 0, Math.PI * 2);
      g.fill();
      // A wide, very faint halo per grain. The bloom sums these into an even
      // shimmer over the whole area, and that is what makes the outline read
      // between the clusters instead of only around them.
      g.fillStyle = `rgba(40,150,170,${a * 0.05})`;
      g.beginPath();
      g.arc(x, y, size * 7, 0, Math.PI * 2);
      g.fill();
    }

    for (let i = 0; i < deco.dendriteCount; i += 1) {
      const d = deco.dendrites[i * 6 + 4]!;
      const warm = deco.dendrites[i * 6 + 5]!;
      g.lineWidth = (DENDRITE_WIDTH + (DENDRITE_TIP_WIDTH - DENDRITE_WIDTH) * d) * grain;
      const a = (DENDRITE_ALPHA + (DENDRITE_TIP_ALPHA - DENDRITE_ALPHA) * d) * dim * TISSUE_LEVEL;
      // The branches of a note being worked on warm with it, by the same amount.
      g.strokeStyle = warm > 0
        ? `rgba(${Math.round(100 + 120 * warm)},${Math.round(215 - 30 * warm)},${Math.round(230 - 110 * warm)},${a})`
        : `rgba(100,215,230,${a})`;
      g.beginPath();
      g.moveTo(deco.dendrites[i * 6]!, deco.dendrites[i * 6 + 1]!);
      g.lineTo(deco.dendrites[i * 6 + 2]!, deco.dendrites[i * 6 + 3]!);
      g.stroke();
    }
    g.globalCompositeOperation = 'source-over';
  };

  /** Composites one cached layer with its bloom, shifted for the parallax. */
  const blit = (
    g: CanvasRenderingContext2D,
    layer: { img: HTMLCanvasElement; bloom: HTMLCanvasElement | null; ox: number; oy: number },
    scene: Scene,
    z: number,
    bloomStrength: number,
  ): void => {
    const ox = layer.ox + scene.parallaxX * PARALLAX_X * z;
    const oy = layer.oy + scene.parallaxY * PARALLAX_Y * z;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalCompositeOperation = 'lighter';
    if (layer.bloom !== null) {
      g.globalAlpha = bloomStrength;
      g.drawImage(layer.bloom, ox, oy, scene.width, scene.height);
    }
    g.globalAlpha = 1;
    g.drawImage(layer.img, 0, 0, layer.img.width, layer.img.height, ox, oy, scene.width, scene.height);
    g.globalCompositeOperation = 'source-over';
  };

  const draw = (scene: Scene): void => {
    if (ctx === null) return;
    const { width: w, height: h } = scene;

    // A canvas with no area still runs its frame: the panel can be display:none
    // — which is what the phone layout does to the neighbourhood — and then
    // every position divides by a zero width and arrives here as NaN, which
    // createRadialGradient refuses. There is nothing to draw into no space.
    if (!(w > 0) || !(h > 0)) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = ctx.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, Math.max(w, h) * 0.7);
    bg.addColorStop(0, '#08161f');
    bg.addColorStop(0.55, '#061017');
    bg.addColorStop(1, '#040b10');
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const stand = `${scene.camera.scale}:${w}x${h}:${scene.stamp}`;
    const hasTissue = scene.decoAlpha > 0.01 && scene.deco.fogCount + scene.deco.dustCount > 0;
    if (hasTissue) {
      const layer = tissue.sync(`${stand}:${scene.decoAlpha.toFixed(3)}`, scene.camera, w, h, dpr, TISSUE_BLUR, (g) =>
        paintTissue(g, scene),
      );
      if (layer !== null) blit(ctx, layer, scene, TISSUE_PLANE, TISSUE_BLOOM);
      else paintTissue(ctx, scene);
    }

    for (let plane = 0; plane < 3; plane += 1) {
      const layer = planes[plane]!.sync(`${stand}:${plane}`, scene.camera, w, h, dpr, PLANE_BLUR, (g) =>
        paintPlane(g, scene, plane as Depth),
      );
      if (layer !== null) blit(ctx, layer, scene, PLANE_Z[plane]!, BLOOM_STRENGTH);
      else paintPlane(ctx, scene, plane as Depth);
    }

    live(ctx, scene);
  };

  /**
   * Everything that changes without the camera changing.
   *
   * Pulses, the ring under the pointer and the text. None of it goes into a
   * cached layer: a spark crossing a settled brain would otherwise repaint and
   * re-blur three planes sixty times a second for a moving dot.
   */
  const live = (g: CanvasRenderingContext2D, scene: Scene): void => {
    world(g, scene);
    g.globalCompositeOperation = 'lighter';

    // What a spark adds to a link, over the resting link in the cached layer.
    // Pulses have to stay loud, including on a tract held back to a ghost —
    // and they have to leave nothing behind once they are gone, which they
    // cannot if they are ever painted into a layer that is not repainted when
    // they end.
    for (const e of scene.edges) {
      const extra = e.alpha - e.restAlpha;
      if (extra < INVISIBLE) continue;
      tract(g, e, extra, extra * 0.32);
    }
    g.globalAlpha = 1;

    // The heat of a note that is firing, over its resting body and halo.
    for (const n of scene.nodes) {
      if (n.heat <= 0.01) continue;
      const reach = n.r * (3.4 + n.heat * 3);
      const halo = g.createRadialGradient(n.x, n.y, 0, n.x, n.y, reach);
      halo.addColorStop(0, rgba(n.colour, 0.55 * n.heat));
      halo.addColorStop(0.4, rgba(n.colour, 0.18 * n.heat));
      halo.addColorStop(1, rgba(n.colour, 0));
      g.fillStyle = halo;
      g.beginPath();
      g.arc(n.x, n.y, reach, 0, Math.PI * 2);
      g.fill();
      // The body takes on the colour of what happened, as it used to in the layer.
      g.fillStyle = rgba(n.colour, Math.min(1, 0.85 * n.heat));
      g.beginPath();
      g.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      g.fill();
    }

    for (const s of scene.sparks) {
      const glow = s.ring
        ? g.createRadialGradient(s.x, s.y, s.r * 0.4, s.x, s.y, s.r)
        : g.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r);
      if (s.ring) {
        glow.addColorStop(0, rgba(s.colour, 0));
        glow.addColorStop(0.72, rgba(s.colour, 0.55 * s.alpha));
      } else {
        glow.addColorStop(0, `rgba(255,255,255,${0.9 * s.alpha})`);
        glow.addColorStop(0.3, rgba(s.colour, 0.65 * s.alpha));
      }
      glow.addColorStop(1, rgba(s.colour, 0));
      g.fillStyle = glow;
      g.beginPath();
      g.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';

    if (scene.hovered >= 0) {
      const n = scene.nodes[scene.hovered];
      if (n !== undefined) {
        g.strokeStyle = 'rgba(255,255,255,0.85)';
        g.lineWidth = 1.4 / scene.camera.scale;
        g.beginPath();
        g.arc(n.x, n.y, n.r + 5 / scene.camera.scale, 0, Math.PI * 2);
        g.stroke();
      }
    }

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    names(g, scene);
  };

  /** Region names and note titles, both in screen space so the text never scales. */
  const names = (g: CanvasRenderingContext2D, scene: Scene): void => {
    const { camera } = scene;
    const sx = (x: number): number => x * camera.scale + camera.x;
    const sy = (y: number): number => y * camera.scale + camera.y;
    const family = typeof getComputedStyle === 'function' ? getComputedStyle(document.body).fontFamily : 'sans-serif';

    if (scene.regionAlpha > 0.01 && scene.regions.length > 0) {
      g.font = `400 13px ${family}`;
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      const measure = (text: string): number =>
        typeof g.measureText === 'function' ? g.measureText(text).width : text.length * 6.5;
      // Where each name goes is decided in `labels.ts`: next to its own region,
      // on the canvas, off the tissue, clear of the controls and of each other —
      // or not at all.
      const names = placeRegionNames(
        scene.regions,
        camera,
        scene.width,
        scene.height,
        scene.blocked,
        scene.inside,
        measure,
      );
      for (const label of names) {
        g.strokeStyle = `rgba(190,228,235,${0.38 * scene.regionAlpha})`;
        g.lineWidth = 0.8;
        g.beginPath();
        g.moveTo(label.fromX, label.fromY);
        g.quadraticCurveTo(label.cx, label.cy, label.toX, label.toY);
        g.stroke();

        const { box } = label;
        g.textAlign = label.align;
        const tx = label.align === 'center' ? box.x + box.w / 2 : label.align === 'left' ? box.x : box.x + box.w;
        g.fillStyle = `rgba(212,230,234,${0.92 * scene.regionAlpha})`;
        label.lines.forEach((line, k) => g.fillText(line, tx, box.y + LINE_HEIGHT * (k + 0.5)));
      }
    }

    // Titles, most connected first; one that would overlap a title already
    // placed is dropped rather than drawn over it.
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    for (const label of scene.labels) {
      if (label.alpha <= 0.02) continue;
      const x = sx(label.x);
      const y = sy(label.y);
      if (x < -80 || x > scene.width + 80 || y < -20 || y > scene.height + 20) continue;
      g.font = `${label.strong ? 500 : 400} ${label.strong ? 12.5 : 11.5}px ${family}`;
      const width = typeof g.measureText === 'function' ? g.measureText(label.text).width : label.text.length * 6;
      const left = x + label.offset * camera.scale + 4;
      const box = { x: left - 3, y: y - 8, w: width + 6, h: 16 };
      if (placed.some((b) => box.x < b.x + b.w && b.x < box.x + box.w && box.y < b.y + b.h && b.y < box.y + box.h)) {
        continue;
      }
      placed.push(box);
      g.fillStyle = `rgba(6,16,23,${0.55 * label.alpha})`;
      g.fillRect(box.x, box.y, box.w, box.h);
      g.fillStyle = label.hot ? `rgba(255,255,255,${label.alpha})` : `rgba(225,240,242,${label.alpha})`;
      g.fillText(label.text, left, y + 0.5);
    }
  };

  return {
    resize,
    draw,
    dispose: () => {
      for (const plane of planes) plane.dispose();
      tissue.dispose();
      sprites.dispose();
    },
  };
}

/** Strokes a polyline; a NaN pair lifts the pen, which is how a fold is broken. */
function polyline(g: CanvasRenderingContext2D, pts: Float64Array, n: number): void {
  g.beginPath();
  let up = true;
  for (let i = 0; i < n; i += 1) {
    const x = pts[i * 2]!;
    const y = pts[i * 2 + 1]!;
    if (Number.isNaN(x)) {
      up = true;
      continue;
    }
    if (up) {
      g.moveTo(x, y);
      up = false;
    } else g.lineTo(x, y);
  }
  g.stroke();
}
