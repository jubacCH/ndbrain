/**
 * Offscreen layers and their bloom.
 *
 * This is the file that decides whether the view is usable on a fanless
 * machine. The look wants a lot of glow: three depth planes, each blurred and
 * added back over itself, plus a tissue layer of some ten thousand grains and
 * four thousand branches. Painted per frame that is a slideshow with the fans
 * on. Painted **once per camera stand** and then only composited, it is a few
 * drawImage calls a frame and the machine stays silent.
 *
 * So each layer keeps three things: the canvas it was painted into, a blurred
 * half-resolution copy of it, and the camera it was painted at. A frame asks for
 * a layer and gets one of three answers:
 *
 *  - **Nothing changed.** The canvases are handed back as they are.
 *  - **Only the pan changed, and not far.** The canvases are handed back with an
 *    offset; compositing them a few hundred pixels off is free, and a pan is the
 *    one gesture where a stale edge at the rim is invisible because everything
 *    is moving anyway.
 *  - **Anything else** — the zoom, the size, the selection, a note that moved —
 *    and the layer is repainted.
 *
 * The blur is half resolution on purpose. A bloom is by definition the part of
 * the picture with no detail in it; at half resolution it is a quarter of the
 * pixels to filter, and there is nothing to see in the difference.
 *
 * Everything here degrades to nothing if a 2D context cannot be had — which is
 * exactly what happens under the test runner. The renderer then paints straight
 * onto the visible canvas without the cache, and every test that asks what was
 * drawn still gets an answer.
 */

import type { Camera } from './camera';
import { WARM_HUE, oklch } from './scene';

/** How far a pan may drift from the cached stand before the layer is repainted. */
const PAN_TOLERANCE = 0.34;

export interface Painted {
  /** The layer itself, at device resolution. */
  readonly img: HTMLCanvasElement;
  /** The blurred half-resolution copy, added back on top for the glow. */
  readonly bloom: HTMLCanvasElement | null;
  /** Where to put it, in CSS pixels, to account for a pan since it was painted. */
  readonly ox: number;
  readonly oy: number;
}

/** Makes an offscreen canvas, or null where there is no 2D context to be had. */
function surface(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  return ctx === null ? null : { canvas, ctx };
}

/**
 * One cached layer: a canvas, its bloom, and the camera they belong to.
 *
 * The caller supplies a `key` that describes everything about the content
 * except the pan — the scale, the viewport, and the scene's stamp. Equal keys
 * and a small enough pan mean the paint callback is not called at all.
 */
export class CachedLayer {
  #img: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
  #bloom: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
  #key = '';
  #at: Camera = { scale: 0, x: 0, y: 0 };
  #width = 0;
  #height = 0;
  #dpr = 1;
  /** Scratch for softening the layer, made the first time a layer is softened. */
  #soft: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
  /** True while the last paint is still good. Read by the tests and the idle check. */
  #fresh = false;

  get fresh(): boolean {
    return this.#fresh;
  }

  /**
   * Brings the layer up to date and hands it back, or null where offscreen
   * canvases are not available and the caller has to paint directly.
   *
   * `soften`, in device pixels, blurs the painted layer itself slightly before
   * its bloom is taken: a plane out of focus rather than one that is only
   * darker. It is part of the paint, so it too happens once per stand.
   */
  sync(
    key: string,
    camera: Camera,
    width: number,
    height: number,
    dpr: number,
    blur: number,
    paint: (ctx: CanvasRenderingContext2D) => void,
    soften = 0,
  ): Painted | null {
    if (!(width > 0) || !(height > 0)) return null;
    const pixelW = Math.round(width * dpr);
    const pixelH = Math.round(height * dpr);

    const resized = this.#img === null || this.#width !== width || this.#height !== height || this.#dpr !== dpr;
    if (resized) {
      const made = surface(pixelW, pixelH);
      if (made === null) return null;
      this.#img = made;
      this.#bloom = surface(Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2)));
      this.#soft = null;
      this.#width = width;
      this.#height = height;
      this.#dpr = dpr;
      this.#key = '';
    }
    const img = this.#img;
    if (img === null) return null;

    // A pan the layer can absorb: offset it and keep the pixels.
    const panned = camera.x - this.#at.x;
    const panner = camera.y - this.#at.y;
    const sameStand =
      this.#key === key &&
      camera.scale === this.#at.scale &&
      Math.abs(panned) < width * PAN_TOLERANCE &&
      Math.abs(panner) < height * PAN_TOLERANCE;

    if (!sameStand) {
      img.ctx.setTransform(1, 0, 0, 1, 0, 0);
      img.ctx.clearRect(0, 0, pixelW, pixelH);
      img.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint(img.ctx);
      img.ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (soften > 0) {
        this.#soft ??= surface(pixelW, pixelH);
        const soft = this.#soft;
        if (soft !== null) {
          soft.ctx.setTransform(1, 0, 0, 1, 0, 0);
          soft.ctx.clearRect(0, 0, pixelW, pixelH);
          soft.ctx.drawImage(img.canvas, 0, 0);
          img.ctx.clearRect(0, 0, pixelW, pixelH);
          img.ctx.filter = `blur(${soften}px)`;
          img.ctx.drawImage(soft.canvas, 0, 0);
          img.ctx.filter = 'none';
        }
      }
      const bloom = this.#bloom;
      if (bloom !== null) {
        bloom.ctx.setTransform(1, 0, 0, 1, 0, 0);
        bloom.ctx.clearRect(0, 0, bloom.canvas.width, bloom.canvas.height);
        bloom.ctx.filter = `blur(${blur}px)`;
        bloom.ctx.drawImage(img.canvas, 0, 0, bloom.canvas.width, bloom.canvas.height);
        bloom.ctx.filter = 'none';
      }
      this.#key = key;
      this.#at = { ...camera };
      this.#fresh = true;
      return { img: img.canvas, bloom: this.#bloom?.canvas ?? null, ox: 0, oy: 0 };
    }

    this.#fresh = true;
    return { img: img.canvas, bloom: this.#bloom?.canvas ?? null, ox: panned, oy: panner };
  }

  /** Throws the pixels away. The canvases go with the renderer. */
  dispose(): void {
    this.#img = null;
    this.#bloom = null;
    this.#soft = null;
    this.#key = '';
    this.#fresh = false;
  }
}

/**
 * Halo sprites, pre-rendered once per colour and size class.
 *
 * A radial gradient per note per frame is the single most expensive thing a
 * canvas renderer can be asked to do — the gradient is rebuilt and rasterised
 * every time. Drawn once into a small canvas and blitted, the same halo costs a
 * texture copy. Sizes are rounded to a multiple of eight so that a slow zoom
 * does not mint a new sprite per frame.
 */
export class Sprites {
  #cache = new Map<string, HTMLCanvasElement | null>();

  /** A halo of `kind` at least `px` across the radius, or null without a context. */
  halo(kind: 'cyan' | 'warm' | 'core', px: number): HTMLCanvasElement | null {
    const size = Math.max(8, Math.ceil(px / 8) * 8);
    const key = `${kind}:${size}`;
    const held = this.#cache.get(key);
    if (held !== undefined) return held;

    const made = surface(size * 2, size * 2);
    if (made === null) {
      this.#cache.set(key, null);
      return null;
    }
    const g = made.ctx;
    const grad = g.createRadialGradient(size, size, 0, size, size, size);
    if (kind === 'cyan') {
      grad.addColorStop(0, 'rgba(120,235,245,0.55)');
      grad.addColorStop(0.25, 'rgba(57,220,235,0.22)');
      grad.addColorStop(0.6, 'rgba(32,191,181,0.06)');
      grad.addColorStop(1, 'rgba(32,191,181,0)');
    } else if (kind === 'warm') {
      // The accent's one hue (see `WARM_HUE`), brighter towards the middle.
      const [r0, g0, b0] = oklch(0.88, 0.1, WARM_HUE);
      const [r1, g1, b1] = oklch(0.74, 0.13, WARM_HUE);
      grad.addColorStop(0, `rgba(${r0},${g0},${b0},0.55)`);
      grad.addColorStop(0.25, `rgba(${r1},${g1},${b1},0.22)`);
      grad.addColorStop(0.6, `rgba(${r1},${g1},${b1},0.05)`);
      grad.addColorStop(1, `rgba(${r1},${g1},${b1},0)`);
    } else {
      grad.addColorStop(0, 'rgba(255,255,255,0.9)');
      grad.addColorStop(0.4, 'rgba(180,245,255,0.35)');
      grad.addColorStop(1, 'rgba(120,230,245,0)');
    }
    g.fillStyle = grad;
    g.fillRect(0, 0, size * 2, size * 2);
    this.#cache.set(key, made.canvas);
    return made.canvas;
  }

  dispose(): void {
    this.#cache.clear();
  }
}
