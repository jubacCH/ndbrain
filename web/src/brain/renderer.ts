/**
 * The canvas renderer.
 *
 * Takes a scene and paints it. It does not know that a simulation exists, what a
 * note is, or why one cell body is brighter than another — every one of those
 * decisions arrived already made, as a number on a `SceneNode`. What is left
 * here is the part that a WebGL implementation would have to redo and nothing
 * else, which is the point: `BrainRenderer` is the whole contract.
 *
 * Two things stay in screen space while everything else goes through the camera.
 * The background gradient, because it is the room the brain is in, not a thing
 * in the room — it must not slide off when you pan. And the device-pixel ratio,
 * which is a property of the display and is folded into the same transform so
 * that nothing downstream ever multiplies by it again.
 */

import type { Scene } from './scene';

export interface BrainRenderer {
  /** CSS pixels; the backing store is sized from this and the display's ratio. */
  resize(width: number, height: number): void;
  draw(scene: Scene): void;
  dispose(): void;
}

/** Segments per tract. Fourteen is where the taper stops looking faceted. */
const SEG = 14;

export function createCanvasRenderer(canvas: HTMLCanvasElement): BrainRenderer {
  const ctx = canvas.getContext('2d');
  let dpr = 1;

  const resize = (width: number, height: number): void => {
    // Capped at 2. A phone claiming 3 or 4 asks for nine to sixteen times the
    // fill for a difference nobody sees on a glow.
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
  };

  const draw = (scene: Scene): void => {
    if (ctx === null) return;
    const { width: w, height: h, camera } = scene;

    // A canvas with no area still runs its frame: the panel can be display:none
    // — which is what the phone layout does to the neighbourhood — and then
    // every position divides by a zero width and arrives here as NaN, which
    // createRadialGradient refuses. There is nothing to draw into no space.
    if (!(w > 0) || !(h > 0)) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = ctx.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, Math.max(w, h) * 0.7);
    bg.addColorStop(0, '#0d1c26');
    bg.addColorStop(1, '#05090d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // From here on the canvas is in world units. Line widths, glow radii and
    // label sizes all scale with the zoom, which is what "moving closer" means;
    // deciding what to *show* at each distance is semantic zoom, and later.
    ctx.setTransform(dpr * camera.scale, 0, 0, dpr * camera.scale, dpr * camera.x, dpr * camera.y);

    // Tracts: wide at the cell body, narrow in the middle, so the link visibly
    // grows out of the neuron instead of lying beside it as a stroke.
    ctx.fillStyle = 'rgba(96,206,222,0.3)';
    for (const e of scene.edges) {
      const left: Array<[number, number]> = [];
      const right: Array<[number, number]> = [];

      for (let i = 0; i <= SEG; i += 1) {
        const t = i / SEG;
        const it = 1 - t;
        const px = it * it * e.ax + 2 * it * t * e.cx + t * t * e.bx;
        const py = it * it * e.ay + 2 * it * t * e.cy + t * t * e.by;
        const tx = 2 * it * (e.cx - e.ax) + 2 * t * (e.bx - e.cx);
        const ty = 2 * it * (e.cy - e.ay) + 2 * t * (e.by - e.cy);
        const tl = Math.sqrt(tx * tx + ty * ty) || 1;
        const taper = 1 - 4 * t * (1 - t);
        const wid = 0.55 + (e.aw * it + e.bw * t) * taper * 0.9;
        left.push([px + (-ty / tl) * wid, py + (tx / tl) * wid]);
        right.push([px - (-ty / tl) * wid, py - (tx / tl) * wid]);
      }

      ctx.beginPath();
      ctx.moveTo(left[0]![0], left[0]![1]);
      for (let i = 1; i < left.length; i += 1) ctx.lineTo(left[i]![0], left[i]![1]);
      for (let i = right.length - 1; i >= 0; i -= 1) ctx.lineTo(right[i]![0], right[i]![1]);
      ctx.closePath();
      ctx.fill();
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const i of scene.order) {
      const n = scene.nodes[i]!;
      const [cr, cg, cb] = n.colour;
      const a = n.alpha;
      const reach = n.r * (3.4 + n.heat * 3);

      const halo = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, reach);
      halo.addColorStop(0, `rgba(${cr},${cg},${cb},${0.5 * a})`);
      halo.addColorStop(0.4, `rgba(${cr},${cg},${cb},${0.14 * a})`);
      halo.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(n.x, n.y, reach, 0, Math.PI * 2);
      ctx.fill();

      const body = ctx.createRadialGradient(n.x - n.r * 0.35, n.y - n.r * 0.4, n.r * 0.1, n.x, n.y, n.r);
      body.addColorStop(0, `rgba(255,255,255,${0.85 * a + n.heat * 0.15})`);
      body.addColorStop(0.5, `rgba(${cr},${cg},${cb},${0.95 * a})`);
      body.addColorStop(
        1,
        `rgba(${Math.round(cr * 0.35)},${Math.round(cg * 0.4)},${Math.round(cb * 0.5)},${0.9 * a})`,
      );
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const s of scene.sparks) {
      const [cr, cg, cb] = s.colour;
      const glow = s.ring
        ? ctx.createRadialGradient(s.x, s.y, s.r * 0.4, s.x, s.y, s.r)
        : ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r);
      if (s.ring) {
        glow.addColorStop(0, `rgba(${cr},${cg},${cb},0)`);
        glow.addColorStop(0.72, `rgba(${cr},${cg},${cb},${0.55 * s.alpha})`);
      } else {
        glow.addColorStop(0, `rgba(255,255,255,${0.9 * s.alpha})`);
        glow.addColorStop(0.3, `rgba(${cr},${cg},${cb},${0.65 * s.alpha})`);
      }
      glow.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    ctx.font = `600 11px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    for (const label of scene.labels) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(4,10,14,0.8)';
      ctx.strokeText(label.text, label.x, label.y);
      ctx.fillStyle = label.hot ? '#ffffff' : 'rgba(190,225,235,0.92)';
      ctx.fillText(label.text, label.x, label.y);
    }
  };

  return {
    resize,
    draw,
    dispose: () => {
      // Nothing to release for a 2D context — the canvas goes with the element.
      // It exists because a WebGL renderer has buffers and a context to lose,
      // and the component must already be calling this when that day comes.
    },
  };
}
