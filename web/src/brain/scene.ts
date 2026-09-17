/**
 * The render model: one frame, resolved down to shapes and colours.
 *
 * The third layer, and the seam the whole re-cut was for. Everything above this
 * point is structure and physics; everything below is painting. A renderer
 * receives a scene and never asks where it came from — which is what makes
 * swapping the canvas for WebGL a change to one file rather than a rewrite.
 *
 * The colour rules live here rather than in the renderer, because they are
 * decisions about meaning — an unlinked note is dim, a hub is bright, an access
 * is warm — and those must survive a change of drawing technology. The renderer
 * gets numbers it only has to obey. How loudly each link is drawn, and along
 * which curve, is decided in `edges.ts` and only applied here.
 *
 * **What changed with the optics work.** A link is no longer a quadratic between
 * two points: it is a sampled curve, bundled through a region's hub when it
 * leaves its own region, and drawn as a tapered polygon rather than a stroke. A
 * note is no longer only a position: it also carries the depth layer it belongs
 * to, which is what lets the renderer bloom and parallax three planes instead of
 * one flat picture. And the scene now carries the tissue (`deco.ts`) and the
 * region names, both of which are drawn but neither of which is data.
 *
 * **`stamp`** is the one concession the scene makes to how it is painted. The
 * renderer keeps the three depth layers and their bloom in offscreen canvases
 * and only rebuilds them when something in them changed; `stamp` is how it is
 * told. It counts changes to the *static* content — positions, selection, the
 * tissue — and deliberately not the pulse, which is drawn live on top so that a
 * spark never costs a blur.
 *
 * Arrays are allocated once per graph and refilled in place. At 109 notes that
 * is housekeeping; at the few thousand this is being built for, a fresh object
 * per node per frame is the garbage collector stuttering the animation.
 */

import type { Camera, Inset } from './camera';
import { fit } from './camera';
import type { EdgeGeometry, EdgePlan, RoutePlan } from './edges';
import {
  CURVE_STEPS,
  FORK_POINTS,
  MAP_DEGREE,
  RAY_FORKS,
  TWIN,
  VISIBLE,
  alongCurve,
  branchRay,
  edgeAlpha,
  glow,
  growth,
  opening,
  planEdges,
  planRoutes,
  traceEdge,
  tractBase,
  tractMid,
} from './edges';
import type { BrainGraph } from './model';
import type { Activity, PulseKind } from './activity';
import type { BrainLayout } from './layout';
import type { Decoration } from './deco';
import { NO_DECORATION, buildDecoration } from './deco';
import type { Rect } from './labels';
import type { RegionAnchor, RegionView } from './regions';
import { regionAnchors, regionView } from './regions';
import type { RayFork } from './edges';
import { unit } from './seed';

export type Rgb = readonly [number, number, number];

/** The two access colours. They say read and written. */
export const PULSE_COLOUR: Record<PulseKind, Rgb> = {
  read: [127, 233, 240],
  write: [255, 184, 107],
};

/** The tissue's cyan, and the warm accent for a note worked on recently. */
export const TISSUE: Rgb = [140, 240, 250];
/**
 * Saturated since 2026-09-17: the paler amber, lit additively and bloomed, read
 * as cream next to the cyan rather than as a colour of its own.
 */
export const ACCENT: Rgb = [250, 192, 104];
/** A link of the selected note. */
export const FOCUSED: Rgb = [230, 255, 255];
/**
 * Cell bodies: a hub, an ordinary note, a note nothing links to, as drawn in the
 * front plane.
 *
 * Since 2026-09-17 a body is coloured light, not white. The near-white cores of
 * the day before summed, in every dense cluster, into white patches with no
 * colour left in them; in the target picture only a pinpoint in the middle of a
 * core is close to white and everything around it is cyan. The note with no
 * links stays the dim one, because that is what it says.
 */
export const HUB_BODY: Rgb = [80, 230, 246];
export const NOTE_BODY: Rgb = [46, 214, 236];
export const LONELY_BODY: Rgb = [58, 96, 110];

/**
 * The same bodies further back: smaller, fainter and bluer, the way distance
 * reads in the target picture. Back plane first, front last, which is
 * `HUB_BODY` and `NOTE_BODY` again.
 */
export const HUB_PLANES: readonly [Rgb, Rgb, Rgb] = [[52, 136, 206], [52, 192, 230], HUB_BODY];
export const NOTE_PLANES: readonly [Rgb, Rgb, Rgb] = [[40, 118, 196], [34, 172, 216], NOTE_BODY];
/** A link at rest: a saturated cyan, where the tissue's own cyan is paler. */
export const RAY: Rgb = [70, 214, 236];
/** How large a body is drawn in each plane, as a share of `bodyRadius`. Never above 1: see `bodyRadius`. */
export const PLANE_SIZE: readonly [number, number, number] = [0.6, 0.8, 1];
/** How opaque a body is in each plane, as a share of the front plane's. */
export const PLANE_LIGHT: readonly [number, number, number] = [0.46, 0.74, 1];

/** Three depth planes: back, middle, front. */
export type Depth = 0 | 1 | 2;

export interface SceneNode {
  x: number;
  y: number;
  /** Drawn radius, already leaning on depth. */
  r: number;
  colour: Rgb;
  alpha: number;
  /** 0 to 1. Widens the halo and whitens the core. */
  heat: number;
  /** 0 to 1. Strength of the halo, as a share of the full one (see `edges.ts`). */
  glow: number;
  /** Which of the three planes this note is painted into. */
  depth: Depth;
  /** How much of a hub this note is, 0 to 1: its degree against a large map's. */
  hub: number;
  /** The one hub the whole picture is organised around (see `SceneEdge.radiant`). */
  centre: boolean;
  /**
   * How warm this note is drawn, 0 to 1: 1 the day it was written, 0 a
   * fortnight later, along `accentShare`. Already folded into `colour`; the
   * renderer reads it to pick the halo sprite.
   */
  warm: number;
  /**
   * The same note with no pulse on it: what the cached depth layers paint.
   *
   * `colour`, `alpha` and `glow` above are what is on screen this frame,
   * pulse included. The cached layers must never see those, because the cache
   * does not know about the pulse: a layer repainted while a note is still
   * glowing — which selecting or letting go of a note does — would keep that
   * glow after the pulse has died and the loop has stopped. What a pulse adds
   * is drawn live, over the cached layers, every frame it lasts.
   */
  restColour: Rgb;
  restAlpha: number;
  restGlow: number;
}

export interface SceneEdge {
  /** The curve, x,y pairs in world units. Shared buffer, valid up to `n` points. */
  pts: Float64Array;
  n: number;
  /** The two cell bodies it joins: the thick end first. */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Half-width where the tract leaves the thick end, and at the leaf. */
  w0: number;
  w1: number;
  /** Opacity at each end. Zero at both means there is nothing to draw. */
  alpha: number;
  tail: number;
  colour: Rgb;
  /** Which plane it is painted into: its thick end's. */
  depth: Depth;
  /** Twice more, fainter and wider apart: a hub's link reads as a bundle of fibres. */
  strands: boolean;
  /**
   * 0 to 1: how strongly this link is drawn as a ray of the centre — more
   * fibres, and fine branches (`Scene.forks`). Zero for every link that does
   * not leave the centre, and for one of its links held back to a ghost: a ray
   * must not bring back a link the overview hides. Resting value only; it is
   * part of the cached picture.
   */
  radiant: number;
  /**
   * The same link with no spark on it: what the cached depth layers paint.
   * `alpha` above includes a passing spark; the difference is drawn live.
   */
  restAlpha: number;
  restTail: number;
}

export interface SceneSpark {
  x: number;
  y: number;
  r: number;
  colour: Rgb;
  alpha: number;
  /** A ring runs outward from a note with no tracts; otherwise a dot travels one. */
  ring: boolean;
}

/**
 * A fine branch off one of the centre's rays. Decoration, like the tissue: it
 * is never hit tested, fades out with the tissue as the camera comes closer, and
 * is thinner and fainter than the ray it grows from.
 */
export interface SceneFork {
  /** x,y pairs in world units, valid up to `n` points. */
  pts: Float64Array;
  n: number;
  /** Half-width at the ray and at the tip, world units. */
  w0: number;
  w1: number;
  alpha: number;
  colour: Rgb;
  depth: Depth;
}

export interface SceneLabel {
  x: number;
  y: number;
  text: string;
  hot: boolean;
  /** 0 to 1. Semantic zoom fades a title in rather than switching it on. */
  alpha: number;
  /** How far the text is pushed off the cell body. */
  offset: number;
  /** Bigger and heavier for a hub. */
  strong: boolean;
}

export interface Scene {
  nodes: SceneNode[];
  /** Node indices, furthest back first. Drawing order, not iteration order. */
  order: number[];
  edges: SceneEdge[];
  /** The branches of the centre's rays, resting values only. Empty without a centre. */
  forks: SceneFork[];
  sparks: SceneSpark[];
  /** Note titles, most connected first. The renderer measures and drops collisions. */
  labels: SceneLabel[];
  /** Region names outside the outline, with their leader curves. */
  regions: RegionAnchor[];
  /**
   * Screen areas no region name may cover: the controls laid over the canvas,
   * canvas-relative CSS pixels. The caller measures them from the DOM.
   */
  blocked: readonly Rect[];
  /** Whether a world point is on the tissue. Names are kept off it. */
  inside: (x: number, y: number) => boolean;
  /** How far a world point lies inside the silhouette, world units. Names may reach a band in. */
  depthInside: (x: number, y: number) => number;
  /** The brain's width in world units, which a name's leader and tissue band are measured against. */
  brainWidth: number;
  /** 0 to 1: how strongly the region names are drawn. */
  regionAlpha: number;
  /** The tissue. Never hit tested, never data. */
  deco: Decoration;
  /** 0 to 1: how strongly the tissue is drawn. Zero once zoomed in. */
  decoAlpha: number;
  camera: Camera;
  /** The camera's scale as a multiple of the fitted overview. */
  zoom: number;
  /** Viewport in CSS pixels. */
  width: number;
  height: number;
  /** Pointer position, -1 to 1 across the canvas. Only the parallax reads it. */
  parallaxX: number;
  parallaxY: number;
  /** The note under the pointer, or -1. Drawn live, so hovering costs no repaint. */
  hovered: number;
  /** Changes when the cached depth layers have to be repainted. */
  stamp: number;
}

/**
 * How large a cell body is drawn: its layout radius, leaning on depth.
 *
 * Exported because the hit test has to use the same outline. It once used the
 * layout radius instead, which is up to a tenth smaller for the nodes drawn
 * furthest forward — invisible at the starting zoom, and a ring around every
 * magnified node where a press panned the camera instead of grabbing the node.
 */
export function bodyRadius(layoutRadius: number, depth: number): number {
  const grow = Math.min(BODY_MAX, Math.max(BODY_MIN, BODY * Math.pow(layoutRadius / BODY_REFERENCE, BODY_CURVE)));
  return layoutRadius * grow * (0.8 + depth * 0.3);
}

/**
 * How much of its world size a cell body keeps as the camera comes closer.
 *
 * A radius is a world length, so at eight times the overview a hub was drawn
 * eight times as wide — a white sun filling a third of the screen, with the
 * whole point of coming closer (reading the titles, seeing which link goes
 * where) hidden behind it. On screen a body now grows like `0.8 + 0.2 · zoom`,
 * the same sublinear rule the tracts already follow, which at the overview is
 * exactly 1 and changes nothing about the resting picture.
 *
 * The hit test keeps the unscaled radius, so a magnified note stays at least as
 * easy to hit as it looks — never harder.
 */
export function bodyScale(zoom: number): number {
  return zoom <= 1 ? 1 : (0.8 + 0.2 * zoom) / zoom;
}

/**
 * How much of its layout radius a cell body is actually drawn at.
 *
 * The layout's radius is a spacing decision — how much room a note needs before
 * the next one — and using it unchanged as the drawn radius made the notes far
 * larger than the target picture's. Measured against the target, the filled
 * discs were eleven percent of the brain's area where the optics prototype was
 * at three; that one number was most of why the whole view read as too bright.
 * The spacing is right and stays; what is painted inside it does not have to
 * fill it.
 */
const BODY = 0.7;
/**
 * Since 2026-09-16 the share grows with the radius itself: a hub's core is
 * drawn at up to nine tenths of its room, a leaf at about two thirds. In the
 * prototype the hubs are what radiates, and a flat share made them look like
 * slightly larger leaves. The layout radius already grows with the degree, so
 * this needs nothing but the radius — and the hit test, which uses this same
 * function, keeps matching what is drawn.
 */
const BODY_REFERENCE = 11;
const BODY_CURVE = 0.3;
const BODY_MIN = 0.62;
const BODY_MAX = 0.95;

/** The overview the zoom is measured against: the fit, without the caller's inset. */
const NO_INSET: Inset = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * How many always-on names may be on the canvas at once.
 *
 * The hub, whatever is firing, whatever is selected. More text crowds exactly
 * where the notes are densest anyway — and a burst of writes would otherwise
 * bury the picture. The names the zoom brings are not counted here: those are
 * placed and dropped by the renderer, which can measure them.
 */
const MAX_LABELS = 4;
/** Below this a flash is too faint to be worth a name beside it. */
const LABEL_FIRE = 0.35;
/** Zoom at which the hubs' titles appear, and at which every title has. */
const TITLES_HUBS = 1.45;
const TITLES_ALL = 2.2;
/** A note with this many links counts as a hub for the semantic zoom. */
const TITLE_HUB_DEGREE = 8;
/** Zoom over which the tissue and the region names fade out. */
const TISSUE_FROM = 1.3;
const TISSUE_TO = 2.4;
/** A note with this many links is drawn as fully a hub: the widest halo. */
const HUB_FULL = 40;
/**
 * How loud the branches of the centre's rays are at the ray, as a share of the
 * ray's own resting opacity, with a floor so a quiet spoke still branches. A
 * twig off a branch is quieter again.
 */
const FORK_SHARE = 0.7;
const FORK_FLOOR = 0.13;
const TWIG_SHARE = 0.6;
/** How much of its fibres a ray of the centre keeps once zoomed in past the tissue. */
const RADIANT_NEAR = 0.35;
/** A note worked on within this many days carries the warm accent. */
export const RECENT_DAYS = 14;
/**
 * How the accent follows the warmth: a logistic step, soft over about a day and
 * a half, centred where the warmth is `WARM_MID` (three and a half days).
 *
 * The accent used to be a straight mix, cyan to amber by the warmth. Two things
 * made that wrong. A straight mix of cyan and amber passes through a pale mint,
 * which is neither colour and reads as white once the bloom adds to it. And a
 * vault is edited in waves: on the real one, 117 of 118 notes were within six
 * days on 2026-09-17, so every note was somewhere in the mint. Now the notes of
 * the last few days are amber, the rest of the fortnight is cyan with a trace,
 * and the mint is the short way between. Still continuous and monotonic: no
 * note changes colour overnight.
 */
const WARM_MID = 0.75;
const WARM_STEEP = 16;
const logistic = (w: number): number => 1 / (1 + Math.exp(-WARM_STEEP * (w - WARM_MID)));
const WARM_FLOOR = logistic(0);
const WARM_SPAN = logistic(1) - WARM_FLOOR;
/** The accent's share for a warmth of 0 to 1: exactly 0 at 0, exactly 1 at 1. */
export function accentShare(warmth: number): number {
  if (!(warmth > 0)) return 0;
  if (warmth >= 1) return 1;
  return (logistic(warmth) - WARM_FLOOR) / WARM_SPAN;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A colour part way between two, for the warm accent fading with a note's age. */
function mix(from: Rgb, to: Rgb, t: number): Rgb {
  const k = clamp01(t);
  return [
    Math.round(from[0] + (to[0] - from[0]) * k),
    Math.round(from[1] + (to[1] - from[1]) * k),
    Math.round(from[2] + (to[2] - from[2]) * k),
  ];
}

/**
 * Which plane a note sits in.
 *
 * Degree plus a stable draw from the key: hubs lean forward, everything else is
 * spread through the volume. Fixed per note, so the parallax is a property of
 * the vault and not of the frame.
 */
export function planeOf(degree: number, key: string): Depth {
  const z = 0.25 * Math.log1p(degree) - 0.35 + (unit(key, 'plane') - 0.5) * 1.1;
  return z < -0.33 ? 0 : z < 0.33 ? 1 : 2;
}

/**
 * Stamps are counted across every builder, not per builder.
 *
 * A refetch makes a new builder while the renderer keeps its cached layers, and
 * a layer is reused when its key, the stamp among it, matches. Two builders
 * each counting from zero reach the same small stamp for different pictures, and
 * the second one's first frames were then the first one's pixels: a note edited
 * elsewhere kept its old colour until something else changed.
 */
let stamps = 0;
const nextStamp = (): number => {
  stamps += 1;
  return stamps;
};

/**
 * What a grown product was grown from: the layout's geometry and regions as one
 * string, and the positions as they were.
 */
interface Grown<T> {
  value: T;
  shape: string;
  x: Float64Array;
  y: Float64Array;
}

/** A tissue, and the warmth it was grown with. */
type WarmGrown = Grown<Decoration> & { warm: Float64Array };

/** How far a note's warmth may drift before its branches are grown again: an invisible shade. */
const WARM_DRIFT = 0.01;

/**
 * Everything the tissue and the region anchors read off a layout besides the
 * positions, as one comparable string: the arrangement and its size, which note
 * is which, and every region with its members.
 */
function shapeOf(layout: BrainLayout, graph: BrainGraph): string {
  const b = layout.bounds;
  const parts = [
    layout.arrangement,
    String(layout.unitLength),
    `${b.minX},${b.minY},${b.maxX},${b.maxY}`,
    graph.nodes.map((n) => n.key).join('\u0000'),
    Array.from(layout.regionOf).join(','),
    Array.from(layout.nodeSide).join(','),
  ];
  for (const r of layout.regions) {
    parts.push(`${r.id}|${r.name}|${r.side}|${r.cx}|${r.cy}|${r.hub}|${r.members.join(',')}`);
  }
  return parts.join('\n');
}

/** True when every position is exactly what it was. */
function samePlaces(grown: { x: Float64Array; y: Float64Array }, x: ArrayLike<number>, y: ArrayLike<number>): boolean {
  if (grown.x.length !== x.length || grown.y.length !== y.length) return false;
  for (let i = 0; i < x.length; i += 1) {
    if (grown.x[i] !== x[i] || grown.y[i] !== y[i]) return false;
  }
  return true;
}

export class SceneBuilder {
  #graph: BrainGraph;
  #scene: Scene;
  /** How loudly each edge is drawn, settled once per layout (see `edges.ts`). */
  #plan: EdgePlan | null = null;
  #routes: RoutePlan | null = null;
  #view: RegionView | null = null;
  #geometry: EdgeGeometry | null = null;
  #planned: BrainLayout | null = null;
  /** Spark strength per edge this frame, refilled in place. */
  #lit: Float64Array;
  /** One curve buffer per edge, written when the notes move and not per frame. */
  #curves: Float64Array[];
  #curveLength: Int32Array;
  #curvesStale = true;
  /**
   * The region names' anchors, found when the notes last moved. Finding the
   * nearest edge walks rays from every note; that is a question about positions,
   * so it is asked when they change, not every frame.
   */
  #anchors: RegionAnchor[] | null = null;
  #anchorsStale = true;
  /** Which plane each note is in. Fixed per graph. */
  #plane: Uint8Array;
  /** The note the picture is organised around, or -1 (see `#centreOf`). */
  #centre = -1;
  /**
   * The branches of each of the centre's rays, grown with the curves: world
   * geometry, so they change when the notes move and not per frame. Empty for
   * every other link.
   */
  #forks: SceneFork[][];
  /** How far along its ray each fork leaves, and whether it is a twig off another fork. */
  #forkAt: RayFork[][];
  /** How warm each note is drawn, 0 to 1. Set by the caller from the data. */
  #recent: Float64Array;
  #deco: Decoration = NO_DECORATION;
  /** What the current tissue and anchors were grown from, for `inherit`. */
  #decoGrown: WarmGrown | null = null;
  #anchorsGrown: Grown<RegionAnchor[]> | null = null;
  /** A previous builder's products, offered to this one until its layout decides. */
  #offered: { deco: WarmGrown | null; anchors: Grown<RegionAnchor[]> | null } | null = null;
  /** `shapeOf` the planned layout, computed once per layout and only when needed. */
  #shape: string | null = null;
  #decoFor: BrainLayout | null = null;
  #decoMoving = true;
  #stamp = nextStamp();
  /** What the last frame's cached layers were built from, to notice a change. */
  #lastPicked = -1;
  #lastZoom = -1;

  constructor(graph: BrainGraph) {
    this.#graph = graph;
    this.#plane = new Uint8Array(graph.nodes.length);
    for (let i = 0; i < graph.nodes.length; i += 1) {
      this.#plane[i] = planeOf(graph.nodes[i]!.degree, graph.nodes[i]!.key);
    }
    this.#recent = new Float64Array(graph.nodes.length);
    this.#curves = graph.edges.map(() => new Float64Array((CURVE_STEPS + 1) * 2));
    this.#curveLength = new Int32Array(graph.edges.length);
    this.#forks = graph.edges.map(() => []);
    this.#forkAt = graph.edges.map(() => []);
    this.#scene = {
      nodes: graph.nodes.map((_, i) => ({
        x: 0,
        y: 0,
        r: 0,
        colour: TISSUE,
        alpha: 0,
        heat: 0,
        glow: 0,
        depth: this.#plane[i] as Depth,
        hub: 0,
        centre: false,
        warm: 0,
        restColour: TISSUE,
        restAlpha: 0,
        restGlow: 0,
      })),
      order: graph.order,
      edges: graph.edges.map((_, i) => ({
        pts: this.#curves[i]!,
        n: 0,
        ax: 0,
        ay: 0,
        bx: 0,
        by: 0,
        w0: 0,
        w1: 0,
        alpha: 0,
        tail: 0,
        colour: TISSUE,
        depth: 1,
        strands: false,
        radiant: 0,
        restAlpha: 0,
        restTail: 0,
      })),
      forks: [],
      sparks: [],
      labels: [],
      regions: [],
      blocked: [],
      inside: () => false,
      depthInside: () => -1,
      brainWidth: 1,
      regionAlpha: 0,
      deco: NO_DECORATION,
      decoAlpha: 0,
      camera: { scale: 1, x: 0, y: 0 },
      zoom: 1,
      width: 0,
      height: 0,
      parallaxX: 0,
      parallaxY: 0,
      hovered: -1,
      stamp: 0,
    };
    this.#lit = new Float64Array(graph.edges.length);
  }

  /**
   * How warm each note is drawn, by node index: 1 the day it was written, 0 a
   * fortnight later.
   *
   * The warm accent in the target picture is "what is being worked on", and the
   * caller decides that from the graph reply's timestamps. A continuous value
   * rather than a flag, so that a note does not change colour overnight on a
   * boundary nobody watching can see.
   */
  recent(heat: Float64Array): void {
    if (heat.length !== this.#recent.length) return;
    this.#recent = heat.map(accentShare);
    this.#curvesStale = true;
    this.#stamp = nextStamp();
  }

  /**
   * Takes over the tissue and the region anchors of the builder this one
   * replaces, for as long as they still fit.
   *
   * A refetch of the same view builds a new builder, and most refetches change
   * nothing the tissue is grown from: an edit to a note's text, an agent's
   * read. Growing it again is tens of milliseconds on the real vault and far
   * more on a few thousand notes, a visible stutter for an identical picture.
   * So the old products are offered, and each is taken only if its layout's
   * shape and every position are exactly what it was grown from (and, for the
   * tissue, every note's warmth within an invisible shade). Anything else grows
   * them again, as before.
   */
  inherit(previous: SceneBuilder): void {
    this.#offered = { deco: previous.#decoGrown, anchors: previous.#anchorsGrown };
  }

  /** The notes have moved: the curves and the cached layers are out of date. */
  moved(): void {
    this.#curvesStale = true;
    this.#stamp = nextStamp();
  }

  /** The tissue, once it exists. Exposed so a test can assert it is never empty by accident. */
  get decoration(): Decoration {
    return this.#deco;
  }

  /**
   * The edge plan, the routes and the region view for this layout.
   *
   * Per layout rather than per graph because the hemisphere of each note, and
   * which region it is in, are the layout's decisions. A new layout is a new
   * engine in practice; the check is identity, so it costs nothing per frame.
   */
  #planFor(layout: BrainLayout): { plan: EdgePlan; routes: RoutePlan; view: RegionView } {
    if (this.#plan !== null && this.#routes !== null && this.#view !== null && this.#planned === layout) {
      return { plan: this.#plan, routes: this.#routes, view: this.#view };
    }
    const { nodes, edges, clusters } = this.#graph;
    const regions = layout.arrangement === 'brain';
    const view = regionView(layout);
    const keys = nodes.map((n) => n.key);
    this.#view = view;
    this.#geometry = regions
      ? { inside: view.inside, depthInside: view.depthInside, regionOf: view.regionOf, regions: view.regions }
      : null;
    this.#plan = planEdges({
      edges,
      keys,
      clusterOf: regions ? clusters.of : null,
      nodeSide: regions ? layout.nodeSide : null,
    });
    // The centre only exists where there is a brain to organise, and only for a
    // map: a vault whose best-connected note has a handful of links has no
    // centre, and pretending otherwise would crown an arbitrary note.
    const hub = this.#graph.hub;
    this.#centre = regions && view.shaped && hub >= 0 && nodes[hub]!.degree >= MAP_DEGREE ? hub : -1;
    this.#routes = planRoutes({
      edges,
      keys,
      degree: nodes.map((n) => n.degree),
      geometry: this.#geometry,
      centre: this.#centre,
    });
    this.#planned = layout;
    this.#shape = null;
    this.#anchors = null;
    this.#anchorsGrown = null;
    this.#decoGrown = null;
    this.#curvesStale = true;
    this.#deco = NO_DECORATION;
    this.#decoFor = null;
    this.#decoMoving = true;
    this.#stamp = nextStamp();
    return { plan: this.#plan, routes: this.#routes, view };
  }

  /**
   * Grows the tissue, once the notes have stopped moving.
   *
   * Not while the layout is still settling: the dendrites grow towards where the
   * notes are, and growing them twenty times during a settle would cost twenty
   * times as much for a picture nobody sees. After a note is dragged and the
   * brain comes to rest again, it is grown once more, so the branches follow.
   */
  #tissue(layout: BrainLayout, view: RegionView): void {
    if (!view.shaped) {
      this.#deco = NO_DECORATION;
      return;
    }
    if (!layout.settled) {
      this.#decoMoving = true;
      return;
    }
    if (this.#decoFor === layout && !this.#decoMoving) return;
    this.#decoMoving = false;
    this.#decoFor = layout;
    const offered = this.#offered?.deco ?? null;
    if (offered !== null && this.#fits(offered, layout) && this.#warmthFits(offered.warm)) {
      this.#deco = offered.value;
      this.#decoGrown = offered;
    } else {
      this.#deco = buildDecoration({ view, x: layout.x, y: layout.y, warm: this.#recent });
      this.#decoGrown = { value: this.#deco, ...this.#grownFrom(layout), warm: this.#recent };
    }
    // Offered once: from here on the tissue follows this builder's own layout.
    if (this.#offered !== null) this.#offered.deco = null;
    this.#stamp = nextStamp();
  }

  /** The shape and positions a product grown now is grown from. */
  #grownFrom(layout: BrainLayout): { shape: string; x: Float64Array; y: Float64Array } {
    return { shape: this.#shapeFor(layout), x: Float64Array.from(layout.x), y: Float64Array.from(layout.y) };
  }

  #shapeFor(layout: BrainLayout): string {
    this.#shape ??= shapeOf(layout, this.#graph);
    return this.#shape;
  }

  /** True when a product was grown from exactly this layout's shape and positions. */
  #fits(grown: Grown<unknown>, layout: BrainLayout): boolean {
    return samePlaces(grown, layout.x, layout.y) && grown.shape === this.#shapeFor(layout);
  }

  /** True when no note's warmth has drifted further than `WARM_DRIFT` since the tissue was grown. */
  #warmthFits(warm: Float64Array): boolean {
    if (warm.length !== this.#recent.length) return false;
    for (let i = 0; i < warm.length; i += 1) {
      if (Math.abs(warm[i]! - this.#recent[i]!) > WARM_DRIFT) return false;
    }
    return true;
  }

  build(
    layout: BrainLayout,
    activity: Activity,
    camera: Camera,
    picked: number,
    width: number,
    height: number,
    pointer: { x: number; y: number; over: number } = { x: 0, y: 0, over: -1 },
    blocked: readonly Rect[] = [],
  ): Scene {
    const scene = this.#scene;
    const { nodes, edges } = this.#graph;
    scene.camera = camera;
    scene.width = width;
    scene.height = height;
    scene.parallaxX = pointer.x;
    scene.parallaxY = pointer.y;
    scene.hovered = pointer.over;
    scene.blocked = blocked;

    const { plan, routes, view } = this.#planFor(layout);
    this.#tissue(layout, view);
    scene.deco = this.#deco;

    // How far in the camera is, as a multiple of the fitted overview. Measured
    // against a fit without the caller's inset, which the scene cannot see; the
    // inset makes the real resting view a few percent smaller, still well below
    // where held-back links start to return.
    const overview = fit(layout.bounds, width, height, NO_INSET).scale;
    const zoom = overview > 0 && Number.isFinite(overview) ? camera.scale / overview : 1;
    const shrink = bodyScale(zoom);

    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]!;
      const depth = node.depth;
      const heat = Math.max(activity.fire[i]!, activity.warm[i]! * 0.42);
      const warm = this.#recent[i]!;
      // The plane decides size, opacity and hue together: a note further back is
      // smaller, fainter and bluer at once, which is what reads as depth. Before
      // 2026-09-17 size and opacity followed the model's own depth draw, which
      // is unrelated to the plane a note is painted into — the three planes
      // then moved apart under the pointer but looked alike.
      const plane = this.#plane[i] as Depth;
      const cool: Rgb = node.degree === 0 ? LONELY_BODY : node.degree >= 8 ? HUB_PLANES[plane] : NOTE_PLANES[plane];
      const base = warm > 0 ? mix(cool, ACCENT, warm) : cool;

      const out = scene.nodes[i]!;
      out.x = layout.x[i]!;
      out.y = layout.y[i]!;
      // Never larger than `bodyRadius`, which the hit test uses: a note may be
      // easier to hit than it looks, never harder.
      out.r = bodyRadius(layout.r[i]!, depth) * shrink * PLANE_SIZE[plane];
      const restAlpha = (node.degree === 0 ? 0.3 : 0.84) * PLANE_LIGHT[plane];
      out.colour = heat > 0 ? PULSE_COLOUR[activity.kind[i]!] : base;
      out.alpha = restAlpha + heat * 0.5;
      out.heat = heat;
      out.glow = glow(heat);
      out.restColour = base;
      out.restAlpha = restAlpha;
      out.restGlow = glow(0);
      out.depth = this.#plane[i] as Depth;
      out.hub = Math.min(1, node.degree / HUB_FULL);
      out.centre = i === this.#centre;
      out.warm = warm;
    }

    scene.zoom = zoom;
    const open = opening(zoom);
    const grow = growth(zoom);
    const mid = tractMid(grow, camera.scale);

    // Semantic zoom: coming closer dissolves the brain into its notes. The
    // tissue and the region names go as the titles arrive.
    const fade = 1 - clamp01((zoom - TISSUE_FROM) / (TISSUE_TO - TISSUE_FROM));
    scene.decoAlpha = view.shaped ? fade * (picked >= 0 ? 0.45 : 1) : 0;
    scene.regionAlpha = view.shaped ? fade * (picked >= 0 ? 0.5 : 1) : 0;

    // The visible world rectangle. Held-back links open with the zoom only when
    // one of their ends is in it: a long link from somewhere off screen to
    // somewhere else off screen says nothing about what is being looked at.
    const scale = Math.max(1e-6, camera.scale);
    const left = -camera.x / scale;
    const top = -camera.y / scale;
    const right = (width - camera.x) / scale;
    const bottom = (height - camera.y) / scale;

    // Spark strength per edge. A twin's spark is skipped: the carrier touches
    // the same note and has a spark of its own.
    const lit = this.#lit;
    lit.fill(0);
    for (const spark of activity.sparks) {
      if (spark.edge < 0 || spark.t < 0 || plan.kind[spark.edge] === TWIN) continue;
      lit[spark.edge] = Math.max(lit[spark.edge]!, 1 - spark.t);
    }

    // The curves are world geometry: they change when the notes move, not when
    // the camera does. Retracing five hundred bundled routes every frame while
    // panning was the first thing that made a fanless machine audible.
    if (this.#curvesStale) {
      for (let i = 0; i < edges.length; i += 1) {
        this.#curveLength[i] = traceEdge(this.#curves[i]!, routes, i, layout.x, layout.y, this.#geometry);
        this.#growForks(i, routes.hubEnd[i] === this.#centre ? routes.leafEnd[i]! : -1);
      }
      this.#curvesStale = false;
      this.#anchorsStale = true;
    }

    let restChanged = false;
    for (let i = 0; i < edges.length; i += 1) {
      const out = scene.edges[i]!;
      const thick = routes.hubEnd[i]!;
      const leaf = routes.leafEnd[i]!;
      out.pts = this.#curves[i]!;
      out.n = this.#curveLength[i]!;
      const focused = picked >= 0 && (edges[i]!.a === picked || edges[i]!.b === picked);
      out.w0 = tractBase(layout.r[thick]!, grow, focused);
      out.w1 = Math.max(mid, out.w0 * 0.22);
      const ax = layout.x[thick]!;
      const ay = layout.y[thick]!;
      const bx = layout.x[leaf]!;
      const by = layout.y[leaf]!;
      out.ax = ax;
      out.ay = ay;
      out.bx = bx;
      out.by = by;
      const seen =
        (ax >= left && ax <= right && ay >= top && ay <= bottom) ||
        (bx >= left && bx <= right && by >= top && by <= bottom);
      const alpha = edgeAlpha(plan, i, seen ? open : 0, focused, lit[i]!);
      const resting = edgeAlpha(plan, i, seen ? open : 0, focused, 0);
      out.alpha = alpha;
      // A link's resting opacity is part of the cached picture. It changes with
      // the selection and the zoom, which bump the stamp themselves — and with
      // a pan while zoomed in, which the layer cache would otherwise absorb by
      // offsetting stale pixels. Whatever the cause, a change here repaints.
      if (resting !== out.restAlpha) restChanged = true;
      out.restAlpha = resting;
      out.restTail = resting * 0.32;
      // The far end of a tract fades out: that is what makes a link grow out of
      // a note rather than lie between two of them.
      out.tail = alpha * 0.32;
      const heat = this.#recent[thick]!;
      out.colour = focused ? FOCUSED : heat > 0 ? mix(RAY, ACCENT, heat) : RAY;
      out.depth = this.#plane[thick] as Depth;
      out.strands = nodes[thick]!.degree >= 8 && resting > 0.1;
      // A ray of the centre, unless the overview holds it back. Quieter while
      // another note is selected, so the selection keeps the stage.
      // Closer in, the rays open up anyway and their fibres would only add to
      // the knot at the centre, so the fibres give way with the tissue.
      out.radiant =
        thick === this.#centre && resting >= VISIBLE
          ? (picked >= 0 && picked !== thick ? 0.5 : 1) * (RADIANT_NEAR + (1 - RADIANT_NEAR) * fade)
          : 0;
    }

    // The branches: as loud as their ray allows, and faded with the tissue,
    // since they are decoration of the same kind.
    scene.forks = [];
    if (this.#centre >= 0 && scene.decoAlpha > 0.01) {
      for (let i = 0; i < edges.length; i += 1) {
        const e = scene.edges[i]!;
        if (e.radiant <= 0) continue;
        const forks = this.#forks[i]!;
        const at = this.#forkAt[i]!;
        const loud = Math.max(FORK_FLOOR, e.restAlpha * FORK_SHARE) * e.radiant * scene.decoAlpha;
        for (let k = 0; k < forks.length; k += 1) {
          const fork = forks[k]!;
          const where = at[k]!;
          if (fork.n < 2) continue;
          const width = e.w0 + (e.w1 - e.w0) * where.at;
          fork.w0 = Math.max(e.w1, width * (where.twig ? 0.4 : 0.6));
          fork.w1 = e.w1 * 0.5;
          fork.alpha = loud * (where.twig ? TWIG_SHARE : 1);
          fork.colour = e.colour;
          fork.depth = e.depth;
          scene.forks.push(fork);
        }
      }
    }

    scene.sparks = [];
    const along = { x: 0, y: 0 };
    for (const spark of activity.sparks) {
      if (spark.t < 0) continue;
      const colour = PULSE_COLOUR[spark.kind];

      if (spark.edge === -1) {
        const r = layout.r[spark.from]! * (2 + spark.t * 7);
        scene.sparks.push({
          x: layout.x[spark.from]!,
          y: layout.y[spark.from]!,
          r,
          colour,
          alpha: 1 - spark.t,
          ring: true,
        });
        continue;
      }

      // A link in both directions sends one spark, along the edge that is
      // drawn; the twin's would run beside the line and double the pulse.
      if (plan.kind[spark.edge] === TWIN) continue;
      const e = scene.edges[spark.edge]!;
      // Along the curve that is actually drawn, and from the end the pulse
      // started at — a bundled link runs through another region's hub, and a
      // spark on the straight line would visibly leave its own tract.
      const fromThick = routes.hubEnd[spark.edge] === spark.from;
      alongCurve(e.pts, e.n, fromThick ? spark.t : 1 - spark.t, along);
      scene.sparks.push({
        x: along.x,
        y: along.y,
        r: 3.4 * (1 - spark.t * 0.4) * 4,
        colour,
        alpha: 1 - spark.t,
        ring: false,
      });
    }

    this.#names(layout, activity, picked, zoom);
    if (view.shaped && scene.regionAlpha > 0.01) {
      // Recomputed once the notes come to rest, not while they move: during a
      // drag or a settle the names keep the anchors they had, which is invisible
      // for the moment it lasts and saves a ray search per frame.
      if (this.#anchors === null || (this.#anchorsStale && layout.settled)) {
        const offered = this.#offered?.anchors ?? null;
        if (offered !== null && this.#fits(offered, layout)) {
          this.#anchors = offered.value;
          this.#anchorsGrown = offered;
        } else {
          this.#anchors = regionAnchors(view, layout.x, layout.y);
          this.#anchorsGrown = { value: this.#anchors, ...this.#grownFrom(layout) };
        }
        if (this.#offered !== null) this.#offered.anchors = null;
        this.#anchorsStale = false;
      }
      scene.regions = this.#anchors;
    } else {
      scene.regions = [];
    }
    scene.inside = view.inside;
    scene.depthInside = view.depthInside;
    scene.brainWidth = view.bounds.maxX - view.bounds.minX;

    if (restChanged || picked !== this.#lastPicked || Math.abs(zoom - this.#lastZoom) > 0.004) {
      this.#lastPicked = picked;
      this.#lastZoom = zoom;
      this.#stamp = nextStamp();
    }
    scene.stamp = this.#stamp;

    return scene;
  }

  /**
   * Grows the branches of one ray, or clears them when the link is not a ray of
   * the centre (`leaf` -1). Seeded by the pair of keys, so a ray branches the
   * same way on every visit.
   */
  #growForks(edge: number, leaf: number): void {
    const forks = this.#forks[edge]!;
    const at = this.#forkAt[edge]!;
    if (leaf < 0) {
      forks.length = 0;
      at.length = 0;
      return;
    }
    if (at.length === 0) {
      for (let k = 0; k < RAY_FORKS; k += 1) {
        const pts = new Float64Array(FORK_POINTS * 2);
        at.push({ pts, n: 0, at: 0, twig: false });
        forks.push({ pts, n: 0, w0: 0, w1: 0, alpha: 0, colour: TISSUE, depth: 1 });
      }
    }
    const seed = `${this.#graph.nodes[this.#centre]!.key}|${this.#graph.nodes[leaf]!.key}`;
    const inside = this.#geometry?.inside ?? null;
    const count = branchRay(this.#curves[edge]!, this.#curveLength[edge]!, seed, inside, at);
    for (let k = 0; k < RAY_FORKS; k += 1) forks[k]!.n = k < count ? at[k]!.n : 0;
  }

  /**
   * Which titles are offered this frame.
   *
   * Two groups, and the difference matters. The **always-on** ones — the vault's
   * hub, whatever is firing, whatever is selected and what it links to — are
   * shown at any distance, and stay capped at `MAX_LABELS`, because a burst of
   * twenty writes must not bury the picture in text. The **semantic** ones
   * arrive with the zoom: the hubs first, then everything, as the brain
   * dissolves into notes. Those are not capped here; the renderer measures them
   * and drops whatever would overlap, which is a decision only the layer that
   * can measure text is able to make.
   */
  #names(layout: BrainLayout, activity: Activity, picked: number, zoom: number): void {
    const scene = this.#scene;
    const { nodes } = this.#graph;
    scene.labels = [];
    const hubs = clamp01((zoom - TITLES_HUBS) / 0.7);
    const all = clamp01((zoom - TITLES_ALL) / 0.9);

    const seen = new Set<number>();
    const add = (i: number, alpha: number, capped: boolean): void => {
      if (i < 0 || alpha <= 0.02 || seen.has(i)) return;
      if (capped && seen.size >= MAX_LABELS) return;
      seen.add(i);
      const node = nodes[i]!;
      const at = scene.nodes[i]!;
      scene.labels.push({
        x: at.x,
        y: at.y,
        text: node.title.length > 26 ? `${node.title.slice(0, 25)}…` : node.title,
        hot: activity.fire[i]! > LABEL_FIRE,
        alpha,
        offset: layout.r[i]! * 1.2 + 6,
        strong: node.degree >= TITLE_HUB_DEGREE,
      });
    };

    add(this.#graph.hub, 1, true);
    for (let i = 0; i < nodes.length; i += 1) if (activity.fire[i]! > LABEL_FIRE) add(i, 1, true);
    add(picked, 1, true);
    if (picked >= 0) {
      // The neighbourhood of an open note has to stay readable: its names are
      // part of the answer to "what is this connected to".
      for (const e of this.#graph.touching[picked]!) {
        const edge = this.#graph.edges[e]!;
        add(edge.a === picked ? edge.b : edge.a, 0.95, false);
      }
    }
    if (hubs > 0 || all > 0) {
      const order = [...nodes.keys()].sort((i, j) => nodes[j]!.degree - nodes[i]!.degree);
      for (const i of order) {
        const degree = nodes[i]!.degree;
        add(i, degree >= TITLE_HUB_DEGREE ? hubs : degree >= 3 ? all : all * 0.8, false);
      }
    }
  }
}

