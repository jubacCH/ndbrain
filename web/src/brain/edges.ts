/**
 * How loudly each link is drawn, and along which curve.
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
 *  - for every two clusters on the same side that link to each other, one
 *    link as a thread: quieter still, it says "these two regions talk" without
 *    filling the furrow between them;
 *  - for every two clusters on opposite hemispheres linked at least twice, one
 *    thread too, a little quieter again. The hemispheres follow the folders,
 *    so these are the links the owner set on purpose — a project and the
 *    service it runs on — and hiding all of them would hide exactly those.
 *
 * Every other link between clusters is drawn so faintly that it does not
 * read as a line. It is not removed: zooming in on one of its ends brings it
 * back, and so does picking one of its notes, and a pulse travelling along it
 * lights it for as long as the spark runs.
 *
 * The share of lines this gives on the real vault's structure and on the test
 * fixture is recorded in the test. It is not tuned towards a number: it is
 * what the rule gives, and it sits where the briefing asked.
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
 * the pair and is drawn; the other is not, and its spark is dropped, since the
 * carrier touches the same note and runs a spark of its own.
 *
 * Only opacity, width and glow strength change here. The colours stay the
 * ones the scene already uses: colour is for meaning, not for clusters.
 *
 * **The route.** The second half of this file is the other question about a
 * link: not how loudly, but where it runs. A link inside a region is a bowed
 * cubic, leaving its hub outwards so that a hub radiates rather than sprouting a
 * fan of parallel lines. A link into another region is **bundled**: it travels
 * to that region's hub first and only branches off just past it, bent the same
 * way for every link into the same region. That turns a hundred lines crossing
 * the middle of the brain into a handful of trunks with branch points where the
 * regions are — which is the difference between white matter and a bowl of
 * spaghetti, and it is the one structural thing the optics prototype does that
 * a straight line cannot fake.
 *
 * The control points are pulled back inside the silhouette (`keepInside`): a
 * curve is free to bow, but not out of the tissue and into the dark.
 */

import { unit } from './seed';

/** A link inside one cluster, or any link in the loose neighbourhood arrangement. */
export const WITHIN = 0;
/** The strongest link between two clusters on the same side. */
export const BRIDGE = 1;
/** Any other link between two clusters on the same side. */
export const FURROW = 2;
/** A link between notes on opposite hemispheres. */
export const FISSURE = 3;
/** The second edge of a link that exists in both directions. */
export const TWIN = 4;
/** The strongest link between two clusters across the fissure, where several links cross it. */
export const SPAN = 5;

export type EdgeKind = typeof WITHIN | typeof BRIDGE | typeof FURROW | typeof FISSURE | typeof TWIN | typeof SPAN;

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
/**
 * Opacity of a thread across the fissure: a little quieter than one on the
 * same side, so the fissure still reads as the largest gap.
 */
export const SPAN_THREAD = 0.06;
/**
 * Links two regions on opposite hemispheres need before they get a thread.
 *
 * The hemispheres follow the vault's folders, so links across the fissure are
 * the deliberate ones — a project pointing at the service it runs on, a note
 * pointing at its map. One such link can be a passing reference; two or more
 * between the same two regions are a relationship worth a line. On the real
 * vault's structure, laid out with regions anchored to their folders, that is
 * 10 of 20 linked region pairs across the fissure.
 */
export const SPAN_LINKS = 2;
/**
 * A note with this many distinct neighbours counts as a hub when choosing a
 * thread. Absolute rather than relative to the vault: a dozen links is a map
 * or a hub project in a vault of a hundred notes and in one of thousands.
 */
export const HUB_DEGREE = 12;
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
  /**
   * Hemisphere per node (-1 or 1), or null. Per node, not per cluster: a
   * remembered note can stay on its side after a changed link moved it into a
   * cluster on the other one, and its link to that cluster still crosses the
   * fissure on screen.
   */
  nodeSide: ArrayLike<number> | null;
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
 * `THREAD_ORDER`: which of the links between two regions carries their thread.
 *
 * First, a link between two ordinary notes beats one that touches a hub: a map
 * of content links into every region, so its link says little about how two
 * particular regions belong together. A hub's link is the thread only when
 * every link between the two regions touches a hub — then it is honestly the
 * only connection there is. Then more shared neighbours win: a link that closes
 * triangles is a relation, not a passing reference. Last, the pair of keys.
 *
 * No degree beyond the hub threshold enters it. The first version ranked by
 * shared neighbours over the degrees at both ends, and a single new leaf on
 * one note shifted a thread elsewhere in six of 87 captures.
 */
function strongerThread(
  hubby: number,
  shared: number,
  tie: string,
  best: { hubby: number; shared: number; tie: string },
): boolean {
  if (hubby !== best.hubby) return hubby < best.hubby;
  if (shared !== best.shared) return shared > best.shared;
  return tie < best.tie;
}

/**
 * Classifies every edge and settles its two resting opacities.
 *
 * Runs once per graph and layout, not per frame: it is a walk over the edges
 * and a set of neighbours per note.
 */
export function planEdges({ edges, keys, clusterOf, nodeSide }: EdgeInput): EdgePlan {
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

  // One thread per pair of linked regions: on the same side for any link
  // between them, across the fissure only where at least `SPAN_LINKS` links
  // connect them. Same side and across are told apart by the notes at both
  // ends, so a region with a member left on the far side gets its thread
  // there counted separately. Which link carries the thread is decided without the
  // degree of either end (see `THREAD_ORDER`), so a note gaining a leaf
  // somewhere does not move a thread.
  const thread = new Map<
    string,
    { edge: number; hubby: number; shared: number; tie: string; links: number; across: boolean }
  >();
  if (clusterOf !== null && nodeSide !== null) {
    for (const [, i] of carrier) {
      const e = edges[i]!;
      const ca = clusterOf[e.a]!;
      const cb = clusterOf[e.b]!;
      if (ca === cb) continue;
      const across = nodeSide[e.a] !== nodeSide[e.b];
      const na = neighbours[e.a]!;
      const nb = neighbours[e.b]!;
      let shared = 0;
      const [small, large] = na.size < nb.size ? [na, nb] : [nb, na];
      for (const x of small) if (large.has(x)) shared += 1;
      const hubby = na.size >= HUB_DEGREE || nb.size >= HUB_DEGREE ? 1 : 0;
      const tie = keys[e.a]! < keys[e.b]! ? `${keys[e.a]}\u0000${keys[e.b]}` : `${keys[e.b]}\u0000${keys[e.a]}`;
      const regions = `${ca < cb ? `${ca}:${cb}` : `${cb}:${ca}`}:${across ? 'across' : 'beside'}`;
      const best = thread.get(regions);
      if (best === undefined) {
        thread.set(regions, { edge: i, hubby, shared, tie, links: 1, across });
        continue;
      }
      best.links += 1;
      if (strongerThread(hubby, shared, tie, best)) {
        best.edge = i;
        best.hubby = hubby;
        best.shared = shared;
        best.tie = tie;
      }
    }
  }
  const threads = new Set<number>();
  for (const t of thread.values()) {
    if (!t.across || t.links >= SPAN_LINKS) threads.add(t.edge);
  }

  for (let i = 0; i < m; i += 1) {
    const e = edges[i]!;
    const carry = carrier.get(pairOf(e.a, e.b))!;
    primary[i] = carry;
    if (carry !== i) {
      kind[i] = TWIN;
      continue;
    }
    const damp = hub(e.a, e.b);

    if (clusterOf === null || nodeSide === null) {
      kind[i] = WITHIN;
      rest[i] = near[i] = NEIGHBOURHOOD * damp;
      continue;
    }

    const ca = clusterOf[e.a]!;
    const cb = clusterOf[e.b]!;
    const across = nodeSide[e.a] !== nodeSide[e.b];
    if (across && threads.has(i)) {
      kind[i] = SPAN;
      rest[i] = SPAN_THREAD;
      near[i] = Math.max(THREAD, TRACT * NEAR_FISSURE * damp);
    } else if (across) {
      // Also a link inside one cluster whose note was left on the other side:
      // drawn as a tract it would be a bright line straight over the fissure.
      kind[i] = FISSURE;
      rest[i] = GHOST;
      near[i] = Math.max(THREAD, TRACT * NEAR_FISSURE * damp);
    } else if (ca === cb) {
      kind[i] = WITHIN;
      rest[i] = near[i] = TRACT * damp;
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

/**
 * 0 in the overview, 1 once zoomed in far enough that held-back links are back.
 * Smooth between. The scene applies it only to links with an end in view.
 */
export function opening(zoom: number): number {
  const t = Math.min(1, Math.max(0, (zoom - OPEN_FROM) / (OPEN_AT - OPEN_FROM)));
  return t * t * (3 - 2 * t);
}

/**
 * The opacity one edge is drawn with this frame.
 *
 * `lit` is the strength of a spark on it, 0 to 1. A twin is drawn only if a
 * spark is put on it directly; the scene skips sparks on twins.
 */
export function edgeAlpha(plan: EdgePlan, i: number, open: number, focused: boolean, lit: number): number {
  const spark = lit * LIT;
  if (plan.kind[i] === TWIN) return spark;
  const resting = plan.rest[i]! + (plan.near[i]! - plan.rest[i]!) * open;
  return Math.max(resting, focused ? FOCUS : 0, spark);
}

/**
 * How much a tract grows on screen at this zoom: the square root of it, never
 * below 1. Computed once per frame and handed to `tractBase` and `tractMid`.
 */
export function growth(zoom: number): number {
  return Math.sqrt(Math.max(1, zoom));
}

/**
 * Half-width of a tract where it leaves a cell body, in world units.
 *
 * Divided by `growth`: on screen a tract still grows as you come closer, but by
 * the square root of the zoom, so a magnified cluster does not turn into a
 * bundle of ribbons.
 */
export function tractBase(radius: number, grow: number, focused: boolean): number {
  const base = Math.min(TRACT_BASE_MAX, Math.max(TRACT_BASE_MIN, radius * TRACT_BASE));
  return (base * (focused ? FOCUS_WIDEN : 1)) / grow;
}

/** Half-width in the middle of a tract, in world units: half a screen pixel, times `growth`. */
export function tractMid(grow: number, scale: number): number {
  return (TRACT_MID_PX * grow) / Math.max(1e-6, scale);
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

/* ===================== where a link runs ===================== */

/** Points sampled along a tract. Twenty-four is where a bundled curve stops looking faceted. */
export const CURVE_STEPS = 24;

/**
 * How far back inside the rim a control point is pulled, as a share of the way
 * from the region's centre to the last point that was still inside.
 *
 * The prototype found 0.82: high enough that a curve still bows generously, low
 * enough that a bow near the edge does not leave the tissue and draw a line into
 * the dark.
 */
const KEEP_INSIDE = 0.82;
/** Bisection steps when pulling a control point back in. Four is a sixteenth of the way. */
const KEEP_STEPS = 4;

/** Where along the corridor to the target hub a bundle bends. */
const TRUNK_AT = 0.45;
/** How far a bundle's trunk is bowed, per region, as a share of its length. */
const TRUNK_BOW = 0.28;
/** How far each fibre wanders off its bundle's trunk. Fibres, not a pipe. */
const TRUNK_JITTER = 0.09;
/** Where the branch to the leaf leaves the hub. */
const BRANCH_AT = 0.35;
/**
 * How far a bundled route may be longer than the direct line before it is not
 * worth bundling.
 *
 * Bundling only reads as white matter while the detour is small: the corridor
 * is shared by many links and the branch is short. Two notes that happen to sit
 * side by side across a region boundary would otherwise have their link thrown
 * right across the brain and back for the sake of a corridor neither of them
 * needs. Checked with the positions, in `traceEdge`, so the route itself stays a
 * decision about structure and not about where anything currently is.
 */
const DETOUR_MAX = 2.2;

/** How far a link inside one region bows, and one into another that is not bundled. */
const BEND_WITHIN = 0.8;
const BEND_ACROSS = 1.4;

/** The geometry a route needs from the layout. Everything else is the layout's business. */
export interface EdgeGeometry {
  inside(x: number, y: number): boolean;
  depthInside(x: number, y: number): number;
  /** Region id per node, -1 for none. */
  readonly regionOf: ArrayLike<number>;
  /** Hub node index and centre per region id. */
  readonly regions: ReadonlyArray<{ readonly hub: number; readonly cx: number; readonly cy: number }>;
}

export interface RoutePlan {
  /** The end a tract leaves thick: the better-connected one. */
  readonly hubEnd: Int32Array;
  readonly leafEnd: Int32Array;
  /** The region hub a bundled link travels through, or -1 for a plain curve. */
  readonly via: Int32Array;
  /** Signed bow of this link, -0.5 to 0.5. */
  readonly bend: Float64Array;
  /** This fibre's wander off its bundle's trunk, -0.5 to 0.5. */
  readonly jitter: Float64Array;
  /** The bow shared by every link into the same region, by region id. */
  readonly trunk: Float64Array;
}

export interface RouteInput {
  edges: ReadonlyArray<{ a: number; b: number }>;
  /** Node keys by index, so a bow belongs to the pair and not to the reply order. */
  keys: readonly string[];
  degree: ArrayLike<number>;
  geometry: EdgeGeometry | null;
}

/**
 * Settles the route of every link: which end is the thick one, and whether it is
 * bundled through another region's hub.
 *
 * Once per graph and layout, like `planEdges`. Positions are not read here, only
 * which region a note is in — so a note moving does not re-decide a route, it
 * only moves the curve that was decided.
 */
export function planRoutes({ edges, keys, degree, geometry }: RouteInput): RoutePlan {
  const m = edges.length;
  const hubEnd = new Int32Array(m);
  const leafEnd = new Int32Array(m);
  const via = new Int32Array(m).fill(-1);
  const bend = new Float64Array(m);
  const jitter = new Float64Array(m);
  const trunk = new Float64Array(geometry === null ? 0 : geometry.regions.length);

  for (let r = 0; r < trunk.length; r += 1) trunk[r] = (unit(`region:${r}`, 'trunk') - 0.5) * 2;

  for (let i = 0; i < m; i += 1) {
    const e = edges[i]!;
    // The thick end is the better-connected note; ties go to the smaller key, so
    // a reversed reply draws the same tract the same way round.
    const first = degree[e.a]! > degree[e.b]! || (degree[e.a] === degree[e.b] && keys[e.a]! <= keys[e.b]!);
    const hub = first ? e.a : e.b;
    const leaf = first ? e.b : e.a;
    hubEnd[i] = hub;
    leafEnd[i] = leaf;

    const pair = keys[hub]! < keys[leaf]! ? `${keys[hub]}|${keys[leaf]}` : `${keys[leaf]}|${keys[hub]}`;
    bend[i] = unit(pair, 'bend') - 0.5;
    jitter[i] = unit(pair, 'fibre') - 0.5;

    if (geometry === null) continue;
    const ra = geometry.regionOf[hub]!;
    const rb = geometry.regionOf[leaf]!;
    if (ra < 0 || rb < 0 || ra === rb) continue;
    const target = geometry.regions[rb];
    // Bundled — unless the far end already *is* that region's hub, in which case
    // the corridor and the link are the same line.
    if (target !== undefined && target.hub !== leaf) via[i] = target.hub;
  }

  return { hubEnd, leafEnd, via, bend, jitter, trunk };
}

/**
 * Pulls a control point back inside the silhouette.
 *
 * Bisection between the point and an anchor known to be inside — the region's
 * centre — using only `inside`. Written against the contract rather than against
 * the outline, so the day the outline changes this keeps working and nothing
 * here has to know what a hemisphere is.
 *
 * Writes into `out`: this runs a few thousand times per rebuild and a fresh pair
 * of numbers each time is the garbage collector stuttering the rebuild.
 */
export function keepInside(
  geometry: EdgeGeometry,
  px: number,
  py: number,
  anchorX: number,
  anchorY: number,
  out: { x: number; y: number },
): void {
  out.x = px;
  out.y = py;
  if (geometry.inside(px, py)) return;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < KEEP_STEPS; k += 1) {
    const mid = (lo + hi) / 2;
    if (geometry.inside(anchorX + (px - anchorX) * mid, anchorY + (py - anchorY) * mid)) lo = mid;
    else hi = mid;
  }
  const t = lo * KEEP_INSIDE;
  out.x = anchorX + (px - anchorX) * t;
  out.y = anchorY + (py - anchorY) * t;
}

const scratch = { x: 0, y: 0 };

/**
 * Samples one link's curve into `out`, as x,y pairs in world units.
 *
 * Returns the number of points written. `out` must hold `(CURVE_STEPS + 1) * 2`
 * numbers; the caller allocates it once and reuses it.
 */
export function traceEdge(
  out: Float64Array,
  plan: RoutePlan,
  i: number,
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  geometry: EdgeGeometry | null,
): number {
  const hub = plan.hubEnd[i]!;
  const leaf = plan.leafEnd[i]!;
  const x0 = x[hub]!;
  const y0 = y[hub]!;
  const x3 = x[leaf]!;
  const y3 = y[leaf]!;
  const dx = x3 - x0;
  const dy = y3 - y0;
  const len = Math.hypot(dx, dy) || 1;

  const waypoint = plan.via[i]!;
  const detour =
    waypoint < 0
      ? Infinity
      : (Math.hypot(x[waypoint]! - x0, y[waypoint]! - y0) + Math.hypot(x3 - x[waypoint]!, y3 - y[waypoint]!)) / len;
  if (geometry !== null && waypoint >= 0 && detour <= DETOUR_MAX) {
    const hx = x[waypoint]!;
    const hy = y[waypoint]!;
    const target = geometry.regionOf[leaf]!;
    const region = geometry.regions[target];
    const anchorX = region?.cx ?? hx;
    const anchorY = region?.cy ?? hy;

    // The corridor from the far end to the region's hub, bowed once per region
    // plus a little per fibre.
    const tx = hx - x0;
    const ty = hy - y0;
    const tl = Math.hypot(tx, ty) || 1;
    const bow = (plan.trunk[target] ?? 0) * TRUNK_BOW * tl + plan.jitter[i]! * TRUNK_JITTER * tl;
    keepInside(geometry, x0 + tx * TRUNK_AT - (ty / tl) * bow, y0 + ty * TRUNK_AT + (tx / tl) * bow, anchorX, anchorY, scratch);
    const c1x = scratch.x;
    const c1y = scratch.y;

    // And the branch, just past the hub, to the note itself.
    const bx = x3 - hx;
    const by = y3 - hy;
    const bl = Math.hypot(bx, by) || 1;
    const swing = plan.bend[i]! * bl * 0.5;
    keepInside(geometry, hx + bx * BRANCH_AT - (by / bl) * swing, hy + by * BRANCH_AT + (bx / bl) * swing, anchorX, anchorY, scratch);
    return catmull(out, x0, y0, c1x, c1y, scratch.x, scratch.y, x3, y3);
  }

  // A plain bowed cubic. The hub end leaves outwards from its region's centre,
  // so the links of a hub radiate instead of lying on top of one another.
  const sameRegion = geometry !== null && geometry.regionOf[hub] === geometry.regionOf[leaf];
  const bow = plan.bend[i]! * len * (sameRegion ? BEND_WITHIN : BEND_ACROSS);
  const nx = -dy / len;
  const ny = dx / len;
  let outX = 0;
  let outY = 0;
  const home = geometry === null ? undefined : geometry.regions[geometry.regionOf[hub]!];
  if (home !== undefined && home.hub !== hub) {
    const rx = x0 - home.cx;
    const ry = y0 - home.cy;
    const rl = Math.hypot(rx, ry) || 1;
    const away = Math.min(len * 0.25, 30);
    outX = (rx / rl) * away;
    outY = (ry / rl) * away;
  }

  let c1x = x0 + dx * 0.28 + nx * bow * 0.7 + outX;
  let c1y = y0 + dy * 0.28 + ny * bow * 0.7 + outY;
  let c2x = x0 + dx * 0.68 + nx * bow;
  let c2y = y0 + dy * 0.68 + ny * bow;
  if (geometry !== null) {
    const anchorX = home?.cx ?? x0;
    const anchorY = home?.cy ?? y0;
    keepInside(geometry, c1x, c1y, anchorX, anchorY, scratch);
    c1x = scratch.x;
    c1y = scratch.y;
    keepInside(geometry, c2x, c2y, anchorX, anchorY, scratch);
    c2x = scratch.x;
    c2y = scratch.y;
  }

  for (let k = 0; k <= CURVE_STEPS; k += 1) {
    const t = k / CURVE_STEPS;
    const it = 1 - t;
    out[k * 2] = it * it * it * x0 + 3 * it * it * t * c1x + 3 * it * t * t * c2x + t * t * t * x3;
    out[k * 2 + 1] = it * it * it * y0 + 3 * it * it * t * c1y + 3 * it * t * t * c2y + t * t * t * y3;
  }
  return CURVE_STEPS + 1;
}

/** Catmull-Rom through four points, sampled evenly: the bundled route's shape. */
function catmull(
  out: Float64Array,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
): number {
  // Both ends doubled, so the curve starts and ends exactly on the notes. Six
  // control points give three spans: 1→2, 2→3, 3→4. Four would read px[6].
  const px = [x0, x0, x1, x2, x3, x3];
  const py = [y0, y0, y1, y2, y3, y3];
  const spans = 3;
  const per = Math.max(2, Math.round(CURVE_STEPS / spans));
  let n = 0;
  for (let s = 0; s < spans; s += 1) {
    const a0 = px[s]!;
    const a1 = px[s + 1]!;
    const a2 = px[s + 2]!;
    const a3 = px[s + 3]!;
    const b0 = py[s]!;
    const b1 = py[s + 1]!;
    const b2 = py[s + 2]!;
    const b3 = py[s + 3]!;
    const last = s === spans - 1 ? per : per - 1;
    for (let k = 0; k <= last; k += 1) {
      const t = k / per;
      const t2 = t * t;
      const t3 = t2 * t;
      out[n * 2] =
        0.5 * (2 * a1 + (-a0 + a2) * t + (2 * a0 - 5 * a1 + 4 * a2 - a3) * t2 + (-a0 + 3 * a1 - 3 * a2 + a3) * t3);
      out[n * 2 + 1] =
        0.5 * (2 * b1 + (-b0 + b2) * t + (2 * b0 - 5 * b1 + 4 * b2 - b3) * t2 + (-b0 + 3 * b1 - 3 * b2 + b3) * t3);
      n += 1;
    }
  }
  return n;
}

/**
 * A point at `t` along a sampled curve, written into `out`.
 *
 * Sparks travel the line that is drawn. They used to travel a quadratic the
 * renderer happened to draw as well; now that a link into another region runs
 * through that region's hub, a spark on the old straight line would visibly
 * leave its own tract.
 */
export function alongCurve(pts: Float64Array, n: number, t: number, out: { x: number; y: number }): void {
  if (n <= 0) {
    out.x = 0;
    out.y = 0;
    return;
  }
  const at = Math.min(n - 1, Math.max(0, t * (n - 1)));
  const i = Math.max(0, Math.min(n - 2, Math.floor(at)));
  const f = at - i;
  const ax = pts[i * 2]!;
  const ay = pts[i * 2 + 1]!;
  const bx = pts[(i + 1) * 2] ?? ax;
  const by = pts[(i + 1) * 2 + 1] ?? ay;
  out.x = ax + (bx - ax) * f;
  out.y = ay + (by - ay) * f;
}
