/**
 * Where the camera goes when a note is focused.
 *
 * The note and its direct neighbours should all be in view, with room left for
 * whatever the caller lays over the canvas beside them — the inspector on the
 * right, or the sheet along the bottom on a phone. So this is `fit` over a
 * smaller box, with two limits of its own:
 *
 *  - **Never closer than `FOCUS_MAX_ZOOM` times the overview.** A note with a
 *    single neighbour next to it would otherwise fill the screen, and the
 *    surroundings that make a focus readable would be gone.
 *  - **Never further out than the zoom limits allow.** A hub linked to half the
 *    brain gets the brain, shifted aside for the inspector, and no less.
 *
 * Pure: positions in, camera out. The component decides when to glide there.
 */

import type { Box, Camera, Inset } from './camera';
import { fit, limitsFor } from './camera';

/** How far in a focus may bring the camera, as a multiple of the overview's scale. */
export const FOCUS_MAX_ZOOM = 2.6;

/**
 * The smallest box a focus frames, as a share of the brain's size.
 *
 * With it, a note and one close neighbour are shown with their surroundings,
 * not as two dots a screen apart.
 */
const MIN_SHARE = 0.22;

export interface FocusInput {
  /** Node positions and radii, indexed like the graph. */
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  r: ArrayLike<number>;
  /** The note, and the notes it is linked to. */
  members: readonly number[];
  /** The whole brain, for the overview's scale and the minimum box. */
  bounds: Box;
  width: number;
  height: number;
  /** Room to keep clear: the caller's controls plus anything that reserves space. */
  inset: Inset;
  /**
   * Screen pixels kept free right of the rightmost note, for its name: titles
   * are written beside a cell body, and a frame that fits only the bodies cuts
   * the names on that side off at the edge or under the inspector.
   */
  labelRoom?: number;
}

export function focusCamera(input: FocusInput): Camera {
  const { x, y, r, members, bounds, width, height, inset } = input;
  const labels = Math.max(0, input.labelRoom ?? 0);
  const home = fit(bounds, width, height, inset);
  if (members.length === 0) return home;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const i of members) {
    const px = x[i]!;
    const py = y[i]!;
    // Room for the cell body and the name written under it.
    const pad = (r[i] ?? 0) * 1.5 + 18;
    minX = Math.min(minX, px - pad);
    maxX = Math.max(maxX, px + pad);
    minY = Math.min(minY, py - pad);
    maxY = Math.max(maxY, py + pad);
  }

  const minW = (bounds.maxX - bounds.minX) * MIN_SHARE;
  const minH = (bounds.maxY - bounds.minY) * MIN_SHARE;
  if (maxX - minX < minW) {
    const mid = (minX + maxX) / 2;
    minX = mid - minW / 2;
    maxX = mid + minW / 2;
  }
  if (maxY - minY < minH) {
    const mid = (minY + maxY) / 2;
    minY = mid - minH / 2;
    maxY = mid + minH / 2;
  }

  const w = maxX - minX;
  const h = maxY - minY;
  const roomW = Math.max(1, width - inset.left - inset.right - labels);
  const roomH = Math.max(1, height - inset.top - inset.bottom);
  // `fit` stops at one world unit per pixel, which is right for a resting view
  // and too timid for a focus; the scale is chosen here and the offset follows.
  const limits = limitsFor(home);
  const scale = Math.max(limits.min, Math.min(roomW / w, roomH / h, home.scale * FOCUS_MAX_ZOOM, limits.max));
  return {
    scale,
    x: inset.left + roomW / 2 - (minX + w / 2) * scale,
    y: inset.top + roomH / 2 - (minY + h / 2) * scale,
  };
}
