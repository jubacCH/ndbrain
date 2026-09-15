/**
 * How loudly each link is drawn.
 *
 * The layout arranges the notes into regions and two hemispheres; drawn with
 * every link at the same width and opacity, the links between regions ran
 * straight across the fissure and the furrows and hid both. The briefing asks
 * for a calm resting state with about 40 % fewer visible links and about 30 %
 * less glow than the target picture, and for "useful before impressive". This
 * file is where that is decided, as pure functions over numbers, so the rule
 * can be tested without a canvas and survives a change of drawing technology.
 *
 * **The rule.** In the overview a link is drawn as a line when it says
 * something about the regions:
 *
 *  - every link *inside* a cluster: fine and quiet, it is what makes a region
 *    read as a region;
 *  - for every two clusters on the same side that link to each other, the one
 *    link that binds them most strongly: quieter still, a single thread that
 *    says "these two regions talk" without filling the furrow between them.
 *
 * Every other link — the rest of the links between clusters, and every link
 * across the fissure — is drawn so faintly that it does not read as a line. It
 * is not removed: zooming in brings it back, and so does picking one of its
 * notes, and a pulse travelling along it lights it for as long as the spark
 * runs.
 *
 * On the real vault's structure this shows 163 of 270 linked pairs (60 %) in
 * the overview; on the test fixture 150 of 231 (65 %). The share is not tuned
 * towards a number: it is what the rule gives, and it happens to sit where the
 * briefing asked.
 *
 * **Hubs.** A map of content with forty links used to be forty wide tracts
 * meeting in one point. Its links now fade with the geometric mean of the
 * degrees at both ends, sublinearly and with a floor, so a hub's links stay
 * visible but do not add up to a bright star; and a tract's width at the cell
 * body is capped, so the biggest hub grows no wider tracts than a mid-sized
 * note.
 *
 * **Twins.** A link in both directions arrives as two edges with slightly
 * different curves. Drawn both, the closest pairs in the vault were painted at
 * double opacity. One of them — chosen by key, not by server order — carries
 * the pair and is drawn; the other is not, and a spark sent along it runs on
 * the carrier instead.
 *
 * Only opacity, width and glow strength change here. The colours stay the
 * ones the scene already uses: colour is for meaning, not for clusters.
 */

/** A link inside one cluster, or any link in the loose neighbourhood arrangement. */
export const WITHIN = 0;
/** The strongest link between two clusters on the same side. */
export const BRIDGE = 1;
/** Any other link between two clusters on the same side. */
export const FURROW = 2;
/** A link between clusters on opposite hemispheres. */
export const FISSURE = 3;
/** The second edge of a link that exists in both directions. */
export const TWIN = 4;

export type EdgeKind = typeof WITHIN | typeof BRIDGE | typeof FURROW | typeof FISSURE | typeof TWIN;

/**
 * Below this opacity a fine line on the dark ground is not seen as a line.
 *
 * At 0.05 the cyan tract lifts the background by about nine levels of 255 over
 * a pixel or two: faint, but a line. At the ghost opacity it is one or two
 * levels: a single held-back link disappears, and only where many of them
 * converge on a hub do they add up to a faint haze.
 */
export const VISIBLE = 0.05;

/** Opacity of a quiet link inside a cluster (the old uniform value was 0.3). */
export const TRACT = 0.16;
/** Opacity of the one thread between two regions. Above `VISIBLE`, well below `TRACT`. */
export const THREAD = 0.075;
/** Opacity of a link held back in the overview. Below `VISIBLE` on purpose. */
export const GHOST = 0.012;
/**
 * Links in the small neighbourhood beside an open note: a handful, so they keep
 * the old tract opacity. Only their width follows the new, finer tracts.
 */
export const NEIGHBOURHOOD = 0.3;
/**
 * Zoomed in, links between clusters come back at this share of a link inside
 * one — never below a thread, so every one of them is a line again.
 */
const NEAR_FURROW = 0.7;
const NEAR_FISSURE = 0.55;

/** Opacity of every link of the picked note. */
export const FOCUS = 0.6;
/** Opacity a link is raised to while a spark is at its start; fades with the spark. */
export const LIT = 0.5;

/**
 * Hub damping: links fade with `sqrt(HUB_FREE / sqrt(degA · degB))`, not below
 * `HUB_FLOOR`. A link between two notes of degree four or less is unaffected; a
 * spoke of a forty-link map to a leaf keeps two thirds; two large hubs linked
 * to each other keep half — and half of `TRACT` is still above `VISIBLE`.
 */
const HUB_FREE = 4;
const HUB_FLOOR = 0.5;

/**
 * Tract half-width at the cell body, in world units at the design scale.
 *
 * It follows the cell body's radius (itself already a square root of the
 * degree), and stops at `TRACT_BASE_MAX`. The old tracts were 0.42 radius wide
 * without a cap — nearly twenty units across at the largest hub.
 */
const TRACT_BASE = 0.11;
const TRACT_BASE_MIN = 0.8;
export const TRACT_BASE_MAX = 2.2;
/** A focused link grows this much wider at the body. */
const FOCUS_WIDEN = 1.3;
/** Half-width in the middle of a tract, in screen pixels: a 1px line at rest. */
const TRACT_MID_PX = 0.5;

/**
 * Zoom, as a multiple of the fitted overview, at which held-back links start
 * coming back, and at which they are all back.
 */
const OPEN_FROM = 1.3;
const OPEN_AT = 2.6;

/**
 * Halo strength at rest, as a share of the old halo. A firing note ramps back
 * to the full halo, so a pulse stands out as much as it did before.
 */
export const GLOW_REST = 0.7;

export interface EdgeInput {
  edges: ReadonlyArray<{ a: number; b: number }>;
  /** Node keys by index. Only used to break ties, so no decision follows server order. */
  keys: readonly string[];
  /** Cluster per node, or null for an arrangement without regions (the neighbourhood). */
  clusterOf: ArrayLike<number> | null;
  /** Hemisphere per cluster (-1 or 1), or null. */
  sideOf: ArrayLike<number> | null;
}

export interface EdgePlan {
  kind: Uint8Array;
  /** Opacity in the overview. */
  rest: Float64Array;
  /** Opacity once zoomed in (`opening` = 1). */
  near: Float64Array;
  /** The edge that draws this link: itself, or for a twin the edge it doubles. */
  primary: Int32Array;
}

/**
 * Classifies every edge and settles its two resting opacities.
 *
 * Runs once per graph and layout, not per frame: it is a walk over the edges
 * and a set of neighbours per note.
 */
export function planEdges({ edges, keys, clusterOf, sideOf }: EdgeInput): EdgePlan {
  const n = keys.length;
  const m = edges.length;
  const kind = new Uint8Array(m);
  const rest = new Float64Array(m);
  const near = new Float64Array(m);
  const primary = new Int32Array(m);

  // Distinct neighbours: a twin is one relation, and must not make a note look
  // twice as connected as it is.
  const neighbours: Array<Set<number>> = Array.from({ length: n }, () => new Set<number>());
  for (const e of edges) {
    neighbours[e.a]!.add(e.b);
    neighbours[e.b]!.add(e.a);
  }

  // Which edge carries each pair: the one running from the smaller key, so a
  // reversed server reply picks the same curve.
  const carrier = new Map<string, number>();
  const pairOf = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
  for (let i = 0; i < m; i += 1) {
    const e = edges[i]!;
    const pair = pairOf(e.a, e.b);
    const held = carrier.get(pair);
    if (held === undefined) {
      carrier.set(pair, i);
      continue;
    }
    const h = edges[held]!;
    const mine = keys[e.a]! < keys[e.b]!;
    const theirs = keys[h.a]! < keys[h.b]!;
    if (mine && !theirs) carrier.set(pair, i);
  }

  const hub = (a: number, b: number): number => {
    const spread = Math.sqrt(Math.max(1, neighbours[a]!.size * neighbours[b]!.size));
    return Math.min(1, Math.max(HUB_FLOOR, Math.sqrt(HUB_FREE / spread)));
  };

  // The strongest link between each two clusters on the same side. Bond as the
  // clustering measures it, without folders and tags: shared neighbours over
  // the degrees at both ends, so a map of content linking everything is never
  // the thread between two regions.
  const thread = new Map<string, { edge: number; bond: number; tie: string }>();
  if (clusterOf !== null && sideOf !== null) {
    for (const [, i] of carrier) {
      const e = edges[i]!;
      const ca = clusterOf[e.a]!;
      const cb = clusterOf[e.b]!;
      if (ca === cb || sideOf[ca] !== sideOf[cb]) continue;
      let shared = 0;
      const [small, large] =
        neighbours[e.a]!.size < neighbours[e.b]!.size
          ? [neighbours[e.a]!, neighbours[e.b]!]
          : [neighbours[e.b]!, neighbours[e.a]!];
      for (const x of small) if (large.has(x)) shared += 1;
      const bond = (1 + shared) / Math.sqrt(Math.max(1, neighbours[e.a]!.size * neighbours[e.b]!.size));
      const tie = keys[e.a]! < keys[e.b]! ? `${keys[e.a]} ${keys[e.b]}` : `${keys[e.b]} ${keys[e.a]}`;
      const regions = ca < cb ? `${ca}:${cb}` : `${cb}:${ca}`;
      const best = thread.get(regions);
      if (
        best === undefined ||
        bond > best.bond + 1e-9 ||
        (Math.abs(bond - best.bond) <= 1e-9 && tie < best.tie)
      ) {
        thread.set(regions, { edge: i, bond, tie });
      }
    }
  }
  const threads = new Set<number>();
  for (const t of thread.values()) threads.add(t.edge);

  for (let i = 0; i < m; i += 1) {
    const e = edges[i]!;
    const carry = carrier.get(pairOf(e.a, e.b))!;
    primary[i] = carry;
    if (carry !== i) {
      kind[i] = TWIN;
      continue;
    }
    const damp = hub(e.a, e.b);

    if (clusterOf === null || sideOf === null) {
      kind[i] = WITHIN;
      rest[i] = near[i] = NEIGHBOURHOOD * damp;
      continue;
    }

    const ca = clusterOf[e.a]!;
    const cb = clusterOf[e.b]!;
    if (ca === cb) {
      kind[i] = WITHIN;
      rest[i] = near[i] = TRACT * damp;
    } else if (sideOf[ca] !== sideOf[cb]) {
      kind[i] = FISSURE;
      rest[i] = GHOST;
      near[i] = Math.max(THREAD, TRACT * NEAR_FISSURE * damp);
    } else if (threads.has(i)) {
      kind[i] = BRIDGE;
      rest[i] = THREAD;
      near[i] = Math.max(THREAD, TRACT * NEAR_FURROW * damp);
    } else {
      kind[i] = FURROW;
      rest[i] = GHOST;
      near[i] = Math.max(THREAD, TRACT * NEAR_FURROW * damp);
    }
  }

  return { kind, rest, near, primary };
}

/** 0 in the overview, 1 once zoomed in far enough that every link is back. Smooth between. */
export function opening(zoom: number): number {
  const t = Math.min(1, Math.max(0, (zoom - OPEN_FROM) / (OPEN_AT - OPEN_FROM)));
  return t * t * (3 - 2 * t);
}

/**
 * The opacity one edge is drawn with this frame.
 *
 * `lit` is the strength of a spark on it, 0 to 1. A twin is drawn only if a
 * spark is put on it directly; the scene puts sparks on the carrier.
 */
export function edgeAlpha(plan: EdgePlan, i: number, open: number, focused: boolean, lit: number): number {
  const spark = lit * LIT;
  if (plan.kind[i] === TWIN) return spark;
  const resting = plan.rest[i]! + (plan.near[i]! - plan.rest[i]!) * open;
  return Math.max(resting, focused ? FOCUS : 0, spark);
}

/**
 * Half-width of a tract where it leaves a cell body, in world units.
 *
 * Divided by the square root of the zoom: on screen a tract still grows as you
 * come closer, but by the square root, so a magnified cluster does not turn
 * into a bundle of ribbons.
 */
export function tractBase(radius: number, zoom: number, focused: boolean): number {
  const base = Math.min(TRACT_BASE_MAX, Math.max(TRACT_BASE_MIN, radius * TRACT_BASE));
  return (base * (focused ? FOCUS_WIDEN : 1)) / Math.sqrt(Math.max(1, zoom));
}

/** Half-width in the middle of a tract, in world units: half a screen pixel, growing with √zoom. */
export function tractMid(zoom: number, scale: number): number {
  return (TRACT_MID_PX * Math.sqrt(Math.max(1, zoom))) / Math.max(1e-6, scale);
}

/** Halo strength of a note, 0 to 1: `GLOW_REST` at rest, the full halo while it fires. */
export function glow(heat: number): number {
  return Math.min(1, GLOW_REST + (1 - GLOW_REST) * heat);
}

/** Share of linked pairs drawn at or above `VISIBLE`. Twins are the same pair and not counted. */
export function visibleShare(plan: EdgePlan, open = 0): number {
  let pairs = 0;
  let shown = 0;
  for (let i = 0; i < plan.kind.length; i += 1) {
    if (plan.kind[i] === TWIN) continue;
    pairs += 1;
    if (edgeAlpha(plan, i, open, false, 0) >= VISIBLE) shown += 1;
  }
  return pairs === 0 ? 1 : shown / pairs;
}
