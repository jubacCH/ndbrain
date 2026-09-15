/**
 * Where the nodes were when you last looked.
 *
 * This is the whole of "spatial memory". A force layout has no preferred
 * solution — the same vault settles into a different arrangement every run,
 * because the first few frames decide which of many equally good arrangements
 * it falls into. Seeding from a stable hash fixes that for a vault that never
 * changes; remembering the settled positions fixes it for one that does, and
 * lets a note stay where its owner left it even after ten more notes arrived.
 *
 * In the browser, not on the server, for the same reason as `prefs.ts`: this is
 * a property of the screen somebody is sitting at. The arrangement depends on
 * the size of the window it settled in, so syncing a phone's version onto a
 * desktop would replace a good picture with a squeezed one.
 *
 * Stored under the node key, owner and path together, which is what keeps two
 * vaults apart in the same browser: a self-hoster's own notes and a folder
 * shared to them never collide, and signing in as somebody else reads none of
 * the previous account's places.
 */

import type { Point } from './layout';

const PREFIX = 'ndbrain.brain.';

/**
 * A ceiling on what gets written back.
 *
 * localStorage is a synchronous store of about five megabytes shared with
 * everything else this app keeps. A vault well past the size this view is being
 * built for should lose its spatial memory rather than take the rest down with
 * it; at that point the layout still opens the same way every time, from the
 * path hash.
 */
const MAX_ENTRIES = 20_000;

/** Reads the remembered arrangement for one store. Never throws. */
export function loadPositions(store: string): Map<string, Point> {
  const out = new Map<string, Point>();
  try {
    const raw = window.localStorage.getItem(PREFIX + store);
    if (raw === null) return out;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return out;

    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Months-old input written by an older build. Anything not a finite pair
      // is dropped rather than fed to the simulation, where a NaN spreads to
      // every node it repels within a frame or two and the picture disappears.
      if (!Array.isArray(value) || value.length !== 2) continue;
      const x = Number(value[0]);
      const y = Number(value[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      out.set(key, { x, y });
    }
  } catch {
    // Private browsing, or a half-written value. An empty map means "lay it out
    // from the hash", which is a working view and not an error.
  }
  return out;
}

/** Replaces the remembered arrangement. Notes that are gone go with it. */
export function savePositions(store: string, positions: ReadonlyMap<string, Point>): void {
  if (positions.size > MAX_ENTRIES) return;
  try {
    const flat: Record<string, [number, number]> = {};
    for (const [key, at] of positions) {
      if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
      // One decimal. The simulation's precision is far below a pixel and the
      // extra digits would be a third of the stored size.
      flat[key] = [Math.round(at.x * 10) / 10, Math.round(at.y * 10) / 10];
    }
    window.localStorage.setItem(PREFIX + store, JSON.stringify(flat));
  } catch {
    // A full quota. A view that cannot remember where it was is still a view.
  }
}
