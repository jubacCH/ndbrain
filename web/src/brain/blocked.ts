/**
 * The areas of the canvas that controls are laid over.
 *
 * Region names must not be written under the legend, the footer, the reset
 * control or the note about the decoration. Those are placed by whoever uses the
 * component — the legend and footer live in `App.tsx` — so their size is not
 * something the renderer can know, and guessing it in pixels would be wrong the
 * first time the legend gained a line or the window got narrower.
 *
 * So they are measured: every element laid over the canvas in the same
 * positioned container, by its real `getBoundingClientRect`, relative to the
 * canvas. No selector names a particular control. A zoom button added next year
 * is a blocked area the day it appears.
 *
 * Two things are left out on purpose: the card under the pointer, which follows
 * the pointer and would chase the names around; and anything with no area or
 * nowhere over the canvas, such as a panel heading above it.
 */

import type { Rect } from './labels';

/** Elements that are over the canvas but must not push names away. */
const TRANSIENT = 'braincard';

export function blockedAround(canvas: HTMLElement): Rect[] {
  const host = canvas.parentElement;
  if (host === null) return [];
  const frame = canvas.getBoundingClientRect();
  const out: Rect[] = [];
  for (const el of Array.from(host.children)) {
    if (el === canvas || !(el instanceof HTMLElement)) continue;
    if (el.classList.contains(TRANSIENT)) continue;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0) || !(r.height > 0)) continue;
    const x = r.left - frame.left;
    const y = r.top - frame.top;
    // Not over the canvas at all: a heading above it, a panel beside it.
    if (x >= frame.width || y >= frame.height || x + r.width <= 0 || y + r.height <= 0) continue;
    out.push({ x, y, w: r.width, h: r.height });
  }
  return out;
}

/** True when two lists describe the same areas, to the half pixel. */
export function sameAreas(a: readonly Rect[], b: readonly Rect[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const p = a[i]!;
    const q = b[i]!;
    if (Math.abs(p.x - q.x) > 0.5 || Math.abs(p.y - q.y) > 0.5 || Math.abs(p.w - q.w) > 0.5 || Math.abs(p.h - q.h) > 0.5) {
      return false;
    }
  }
  return true;
}
