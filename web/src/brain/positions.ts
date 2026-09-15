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
 * a property of the screen somebody is sitting at. Positions are world
 * coordinates, independent of the window, so a phone and a desktop would in
 * principle agree — but a node dragged somewhere on one of them is a gesture on
 * that screen, not a statement about the vault.
 *
 * **Keyed by account and by format version.** The account, because two people
 * signing in on the same browser each have their own brain; the first version
 * of this store kept one entry per view, and whoever was signed in last
 * overwrote the other's arrangement. The version, because the meaning of a
 * number changed once already: the first stored positions were CSS pixels of
 * the window they settled in, and read into the world coordinates that
 * replaced them they would put every note somewhere arbitrary. A stale format
 * is thrown away rather than converted — there is no faithful conversion from
 * pixels of an unknown window, and the brain lays itself out again from the
 * path hash in the same place every time anyway.
 *
 * Each entry also carries a hash of the note's links at the time. That is how
 * the next visit knows which notes changed in between and may move, and which
 * stay exactly where they were (`BrainLayout.mobile`).
 */

import type { Place } from './layout';

/** Bumped whenever a stored number stops meaning what it meant. */
const VERSION = 2;

/** The first format: `ndbrain.brain.<store>`, CSS pixels, no account. */
const LEGACY = 'ndbrain.brain.';

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

/** Which arrangement: whose, and of which view. */
export interface PositionStore {
  /** The signed-in account's id. */
  account: string;
  /** The view within that account, e.g. `network`. */
  store: string;
}

/**
 * The storage key.
 *
 * Both parts are encoded and joined with a slash, which the encoding always
 * escapes, so no account id can name another account's store: `a/b` + `c` and
 * `a` + `b/c` must not meet. (A dot would not do: `encodeURIComponent` leaves
 * dots alone.)
 */
export function positionsKey({ account, store }: PositionStore): string {
  return `${LEGACY}v${VERSION}/${encodeURIComponent(account)}/${encodeURIComponent(store)}`;
}

/**
 * Removes entries in a format this build no longer reads.
 *
 * Only the legacy shape — `ndbrain.brain.` followed by a store name with no
 * version — so that a newer build's entries are left for that build.
 */
function discardLegacy(): void {
  const doomed: string[] = [];
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (key === null || !key.startsWith(LEGACY)) continue;
    if (/^v\d+\//.test(key.slice(LEGACY.length))) continue;
    doomed.push(key);
  }
  for (const key of doomed) window.localStorage.removeItem(key);
}

/** Reads the remembered arrangement for one store. Never throws. */
export function loadPositions(where: PositionStore): Map<string, Place> {
  const out = new Map<string, Place>();
  try {
    discardLegacy();
    const raw = window.localStorage.getItem(positionsKey(where));
    if (raw === null) return out;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return out;

    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Months-old input written by an older build. Anything not a finite pair
      // is dropped rather than fed to the simulation, where a NaN spreads to
      // every node it repels within a frame or two and the picture disappears.
      if (!Array.isArray(value) || value.length < 2 || value.length > 3) continue;
      const x = Number(value[0]);
      const y = Number(value[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const links = Number(value[2]);
      // Without a usable hash the note simply counts as changed and may move.
      out.set(key, Number.isInteger(links) && links >= 0 ? { x, y, links } : { x, y });
    }
  } catch {
    // Private browsing, or a half-written value. An empty map means "lay it out
    // from the hash", which is a working view and not an error.
  }
  return out;
}

/** Replaces the remembered arrangement. Notes that are gone go with it. */
export function savePositions(where: PositionStore, positions: ReadonlyMap<string, Place>): void {
  if (positions.size > MAX_ENTRIES) return;
  try {
    const flat: Record<string, number[]> = {};
    for (const [key, at] of positions) {
      if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
      // One decimal. The simulation's precision is far below a pixel and the
      // extra digits would be a third of the stored size.
      const x = Math.round(at.x * 10) / 10;
      const y = Math.round(at.y * 10) / 10;
      flat[key] = at.links === undefined ? [x, y] : [x, y, at.links];
    }
    window.localStorage.setItem(positionsKey(where), JSON.stringify(flat));
  } catch {
    // A full quota. A view that cannot remember where it was is still a view.
  }
}
