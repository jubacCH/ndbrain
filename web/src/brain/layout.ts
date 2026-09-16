/**
 * The layout: where the nodes are, and the forces that move them.
 *
 * The second of three layers. It owns positions and velocities and nothing else
 * — no canvas, no pointer, no React, not even a notion of a pixel.
 *
 * **Its own world.** Coordinates are world units in a space centred on the
 * origin whose size depends on the vault, never on the window. The first
 * version of this layer used the viewport as its world and bounded the
 * simulation by it, down to pixel allowances for the legend and the footer;
 * resizing the window then reshaped the brain, and the positions it remembered
 * were pixels of whichever window they had settled in. Now the camera maps the
 * world onto whatever canvas there is, and a narrower window is the same brain
 * seen smaller.
 *
 * **Two arrangements.** The full network grows into the shape of a brain; the
 * neighbourhood beside an open note is a handful of notes and stays a loose,
 * round cluster — pressing six notes into two hemispheres would be a joke.
 *
 * **The silhouette is the container, not a wall.** Until phase 4 this file laid
 * the regions out freely and pressed them into shape with a soft force; the
 * outline held only where the forces balanced, and what the eye saw was a cloud
 * that happened to be brain-ish. Since phase 4 it is the other way round, which
 * is the whole of the optics prototype's lesson: **first cells inside the shape,
 * then places inside the cell, then notes onto places.**
 *
 *  1. *Cells.* The inside of the outline (`shape.ts`) is sampled on a grid, the
 *     samples are divided between the regions by a weighted Lloyd relaxation,
 *     and every region ends up with a cell that reaches from the middle of its
 *     hemisphere out to the rim. Regions are dealt to the two halves by size, so
 *     the halves carry a similar number of notes; the region that is mostly
 *     connective tissue — the one whose notes link outwards more than any
 *     other's — is pinned at the fissure, because that is what it is.
 *  2. *Places.* Each cell is filled with a Poisson-disk sample of its own
 *     points, at the largest spacing that still yields about a third more places
 *     than the region has notes. The places therefore cover the **whole** cell,
 *     out to the rim, rather than a disc around a centre.
 *  3. *Notes.* The region's hub takes the place nearest the cell's centre;
 *     about one note in four and a half with two or more links inside the region
 *     becomes a secondary core and takes the free place furthest from the cores
 *     already set; every other note takes the free place nearest the core or
 *     neighbour it is most strongly linked to. That is what makes the dense
 *     knots that read as star clusters.
 *
 * The simulation is then a **fine correction**, not the placement: it loosens
 * overlaps, lets the springs between regions pull, and keeps a note inside its
 * cell, its hemisphere and out of the fissure. Two forces remain:
 *
 *  - *cohesion*: a note that strays past most of its cell's radius is drawn back
 *    towards the cell's middle. Inside that nothing pulls.
 *  - *containment*: a note past its hemisphere's outline is nudged back, harder
 *    the further it is out; a note inside the fissure is pushed out of it; and a
 *    note that has wandered into another region's cell is pushed home.
 *
 * **Where a region is, and why that survives a change to the vault.** A region's
 * cell comes from the Lloyd relaxation, which depends on the regions of its own
 * hemisphere and on nothing else — not on a rank, a slot number or the order the
 * server listed anything in. A capture that does not change the regions does not
 * move a cell by more than the half percent the whole brain grows. Once the
 * notes have been laid out and remembered, positions come from memory anyway and
 * the cell is only the fence they are held inside.
 *
 * **It comes to rest, and stays.** Forces are scaled by a temperature that
 * decays towards zero; below a floor the simulation stops and `step` does
 * nothing. A remembered brain moves only what changed (`mobile`); dragging a
 * note frees only its neighbours. A brain that keeps drifting cannot be learned.
 *
 * **Ready for Barnes-Hut and a worker, not doing either.** At 109 notes the
 * all-pairs repulsion is about six thousand pairs a step (decided 2026-09-15:
 * not needed yet). It is one function, `repel`, over flat typed arrays; a
 * Barnes-Hut version replaces that function, and a worker can own every array
 * here, since none of them hold an object.
 */

import type { RegionGroup } from './clusters';
import { groupRegions } from './clusters';
import type { BrainGraph } from './model';
import { hash32, unit } from './seed';
import type { Side } from './shape';
import { FISSURE, OUTLINE, centre, outlineDepth, rim, sideOf, withinOutline } from './shape';

export interface Point {
  x: number;
  y: number;
}

/**
 * One region of the brain: a group of notes that share a cell of the silhouette.
 *
 * The contract between this layer and the renderer: everything the picture needs
 * to draw a region — where its cell is, which half it is in, which note is its
 * hub (the waypoint bundled edges run through) and what it is called.
 */
export interface Region {
  readonly id: number;
  /** Display name, e.g. "Homelab". Already user-facing. */
  readonly name: string;
  /** -1 = left hemisphere, +1 = right. */
  readonly side: Side;
  /** Centre of the region's cell, world coordinates. */
  readonly cx: number;
  readonly cy: number;
  /** Index of the region's hub node — the waypoint for bundled edges. */
  readonly hub: number;
  /** Members, node indices, in hash order. */
  readonly members: readonly number[];
}

/**
 * A remembered position, and what the note was linked to when it was taken.
 *
 * `links` is a hash of the note's neighbours. It is how a layout that starts
 * from memory tells the notes that changed since then from the ones that did
 * not, which decides who is allowed to move (see `mobile`).
 */
export interface Place extends Point {
  links?: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type Arrangement = 'brain' | 'loose';

export interface LayoutOptions {
  arrangement: Arrangement;
  /** Positions from last time, by node key. They win over anything computed. */
  remembered?: ReadonlyMap<string, Place> | undefined;
}

/**
 * World area per note, in square units.
 *
 * Sets the density and with it the size of the brain. Cell bodies are 5 to 25
 * units across and springs rest at 70; at this spacing a cluster reads as a
 * cluster and a furrow as a furrow, and the real vault's 109 notes make a brain
 * about 900 units wide — the width of the canvas in a typical window at the
 * design scale of one unit per pixel.
 */
const AREA_PER_NOTE = 4200;
/** Below this many notes the brain stops shrinking; three notes are not a brain. */
const MIN_NOTES = 24;
/**
 * The loose arrangement packs tighter. A neighbourhood is mostly a star around
 * one note, and a star's leaves sit a spring's length from the middle whatever
 * the area; sized like the brain, its outline would be twice as wide as the
 * star, and the panel would fit the empty outline instead of the notes.
 */
const LOOSE_AREA_PER_NOTE = 2400;
const LOOSE_MIN_NOTES = 8;

/**
 * The grid the inside of the outline is sampled on, in normalised units, and
 * how far short of the rim it stops.
 *
 * Fine enough that a cell of a dozen notes still has a few hundred points to
 * choose places from, coarse enough that the Lloyd relaxation stays a few
 * hundred thousand operations for a vault of a hundred notes.
 */
const SAMPLE_STEP = 0.03;
const SAMPLE_MARGIN = 0.98;
/** Lloyd: how many rounds, and how far a centre moves towards its cell each round. */
const LLOYD_STEPS = 40;
const LLOYD_RATE = 0.7;
/** Where the connective region sits, measured out from the fissure. */
const FISSURE_CELL = 0.22;
/** How many more places than notes a cell is filled with. */
const SITE_SURPLUS = 1.35;
/** The search for the Poisson spacing, and how finely it is resolved. */
const SPACING_MIN = 0.02;
const SPACING_MAX = 0.6;
const SPACING_STEPS = 14;
/** The step the spacing is rounded down to: about one note's worth of it. */
const SPACING_QUANT = 0.004;
/**
 * A region whose notes hardly link each other gathers round its core instead of
 * spreading over the whole cell; the dendrites and the fog fill the rest.
 */
const SPARSE_LINKS = 0.7;
const SPARSE_CELL = 0.66;
/** About one core per this many notes, each with at least this many links inside the region. */
const NOTES_PER_CORE = 4.5;
const CORE_MIN_LINKS = 2;

/**
 * Repulsion between two notes at distance d is REPULSION / d², out to CUTOFF.
 *
 * **Much weaker and much shorter-ranged in the brain than it used to be.** While
 * the simulation did the placing, the repulsion was what spread the notes over
 * the picture, and it had to reach across a region to do it. Since the places do
 * that, its only remaining job is that nothing overlaps — a cell body is 9 to 50
 * units across — and at the old strength it undid the placement: the notes a
 * galaxy had gathered around its core were pushed back out again, the closest
 * pairs from 23 units to 34, and the dense knots that make the picture read as
 * star clusters flattened into an even scatter.
 *
 * The loose arrangement keeps the old numbers: there is no placement there, and
 * the repulsion is still what opens the star out.
 */
const REPULSION = 1600;
const CUTOFF = 230;
const BRAIN_REPULSION = 500;
const BRAIN_CUTOFF = 90;
/**
 * Notes of different clusters push a little harder, which opens a furrow
 * between regions. Only a little: much harder, and linked regions end up far
 * apart with long tracts spanned across the brain between them.
 */
const APART = 2;

const SPRING = 0.012;
const REST = 70;
/**
 * A link inside a region rests at this share of a step between the places of
 * its cell, rather than at the fixed `REST`. Under one: linked notes sit a
 * little closer than two unrelated ones, which is what makes a galaxy.
 */
const WITHIN_REGION_REST = 0.75;
/**
 * A link between clusters pulls less than one inside a cluster, and one across
 * the fissure much less. It is still drawn at full strength; but at full pull a
 * handful of links across the middle would close the fissure.
 */
const ACROSS_CLUSTERS = 0.4;
const ACROSS_FISSURE = 0.05;

/** Cell radius, as a share, within which cohesion does nothing. */
const COHESION_FREE = 0.8;
const COHESION = 0.02;
/**
 * Beyond this many cell radii from its region, a remembered note is not drawn
 * back. A note that far out got there by being reassigned, not by straying.
 */
const LET_GO = 2;
/** Past the rim, the push back in, per unit of overshoot. */
const CONTAINMENT = 0.25;
/** And the wall itself: how far out a step is allowed to leave a note. */
const WALL = 0.99;
/** Out of the fissure, per unit of intrusion, and how far clear a note is held. */
const FISSURE_PUSH = 0.25;
const FISSURE_KEEP = 1.25;
/**
 * The push home on a note that has wandered into another region's cell.
 *
 * Gentle: it is a fence, not a magnet. A note pulled over the line by its links
 * leans across it, which is what makes neighbouring regions touch rather than
 * sit in numbered boxes.
 */
const CELL_HOME = 0.04;
/**
 * How clearly a remembered note has to be out of place before it is moved.
 *
 * A quarter past the rim. The simulation's own wall keeps everything it moves
 * inside the outline, and the store is versioned, so nothing this build wrote
 * can be out here at all: this catches a number from somewhere else, and is
 * loose enough never to move a note that was deliberately dragged clear of the
 * brain to be looked at.
 */
const CLAMP_MARGIN = 1.25;
/** The loose arrangement's gentle pull towards the middle. */
const GRAVITY = 0.004;

/** The most a note may move in one step, in world units. */
const MAX_SPEED = 30;
/** Velocity kept per step. Lower is calmer; this is still lively enough to see settle. */
const INERTIA = 0.72;
/** How fast the temperature falls towards its target, per step. */
const COOLING = 0.016;
/** Below this the layout counts as settled and stops. */
const FROZEN = 0.004;
/**
 * The temperature a fresh brain starts at once every note is on its place, and
 * the velocity kept per step while it cools.
 *
 * Low, and heavily damped: this is the fine correction. It loosens overlaps and
 * lets the springs pull, and it must not rearrange what the places already
 * decided. It was 1 while the simulation still did the placing; at that
 * temperature the notes drifted off their places within a few dozen steps and
 * the cells stopped reading as cells.
 */
const JOIN = 0.4;
const JOIN_INERTIA = 0.45;
/**
 * The pull back towards its remembered place on a remembered note that may move
 * because its links changed — the note a capture links to. It should make a
 * little room for the newcomer, not be pushed away by it.
 */
const TETHER = 0.4;
/** A remembered arrangement starts cool: it only has to absorb what changed. */
const WARM = 0.2;
/** Dragging a note keeps its neighbours this warm, so they make room and follow. */
const HELD = 0.12;
/** New notes start this far from the neighbours they link to: about where a spring holds them. */
const NUDGE = 40;

export class BrainLayout {
  readonly graph: BrainGraph;
  readonly arrangement: Arrangement;
  /** Positions and velocities, by node index. */
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  /** Cell-body radius, from the degree. Fixed, but a world length, so it lives here. */
  readonly r: Float64Array;

  /** World length of one normalised brain unit (see `shape.ts`). */
  readonly unitLength: number;
  /** The world rectangle the arrangement is built to fill. The camera fits this. */
  readonly bounds: Bounds;

  /**
   * The regions, one cell of the silhouette each. Empty in the loose
   * arrangement, which has no hemispheres and no cells.
   */
  readonly regions: readonly Region[];
  /** Region index per node index. Zero throughout in the loose arrangement. */
  readonly regionOf: Int32Array;
  /**
   * Hemisphere per node, -1 or 1: its cluster's, or for a remembered note the
   * one it is in. Settled when the layout is built and fixed after that. Zero
   * throughout in the loose arrangement, which has no hemispheres.
   *
   * Public because a note can sit on the other side from its cluster — it was
   * remembered there before a link changed its cluster — and whatever is
   * drawn across the fissure has to go by where the notes are.
   */
  readonly nodeSide: Int8Array;

  /** The node being dragged, or -1. It follows the pointer; only its neighbours simulate. */
  pinned = -1;
  /** The temperature forces are scaled by. */
  alpha: number;
  /** What the temperature decays towards: zero, unless something is held. */
  alphaTarget = 0;
  /** True once the temperature has fallen below the floor. `step` then does nothing. */
  settled = false;
  /** Share of nodes that started from a remembered position. */
  readonly rememberedShare: number;
  /**
   * Which nodes the simulation may move, by node index.
   *
   * All of them in a fresh layout, until it has settled. In one that starts
   * from memory, only what changed: a note that is new and the notes it links
   * to, and a note whose links are not the ones it had when its position was
   * remembered. Not the neighbours of that last kind: a hub that gains a link
   * from a captured note would otherwise set its forty neighbours moving.
   * Everything else stays exactly where it was — it still pushes and pulls on
   * the notes that move, but is not moved itself.
   *
   * This is the answer to briefing point 47 that does not depend on luck. A
   * warm restart of the whole brain drifts every note by a few units even when
   * nothing changed at all, because a simulation stopped by cooling is never
   * exactly at rest; and a note whose cluster changed would be hauled across to
   * its new cluster. Neither is a reason to move a note that nothing happened to.
   * Picking a note up (`hold`) frees that note's neighbours and nothing else,
   * and once the layout has come to rest nothing is free any more — a later
   * warm-up can only ever move what it is explicitly given.
   */
  readonly mobile: Uint8Array;
  /** Which nodes started from a remembered position. */
  readonly #remembered: Uint8Array;
  /** Remembered notes that may move because their links changed: held near where they were. */
  readonly #tether: Uint8Array;
  readonly #homeX: Float64Array;
  readonly #homeY: Float64Array;
  #inertia = INERTIA;
  /** Hash of each node's neighbours, for `Place.links`. */
  readonly #links: Uint32Array;

  /**
   * Node indices in key order.
   *
   * Every loop that adds forces runs in this order, not in the server's. Two
   * replies listing the same vault differently then produce the same sums in
   * the same order — bit for bit the same layout — instead of a picture that
   * drifts apart by rounding and, a few hundred chaotic steps later, visibly.
   */
  readonly #seq: Int32Array;
  /** Edges in key order: endpoints and the strength of their spring. */
  readonly #springA: Int32Array;
  readonly #springB: Int32Array;
  readonly #springK: Float64Array;
  readonly #springRest: Float64Array;
  /**
   * Per region: the centre of its cell in world units, the weight the cell test
   * divides by, and the radius of a circle of the cell's area.
   */
  #cellX: Float64Array;
  #cellY: Float64Array;
  #cellW: Float64Array;
  #cellR: Float64Array;
  /** Per region: the hash of its identity, for the Poisson sample's order. */
  #regionSeed = new Uint32Array(0);
  /** Per region: the distance between neighbouring places in its cell, world units. */
  #spacing = new Float64Array(0);
  /**
   * The grid points inside the outline, normalised, and the region each fell to.
   *
   * Kept because they are the places: a note that has to be put back into its
   * cell is put on the nearest of these, and a fresh layout picks every note's
   * place from them.
   */
  #sampleX = new Float64Array(0);
  #sampleY = new Float64Array(0);
  #sampleOf = new Int32Array(0);
  /** Force accumulators, reused: a fresh array per frame is garbage per frame. */
  readonly #ax: Float64Array;
  readonly #ay: Float64Array;
  /** Scratch lists of the moving and the still nodes, in key order. */
  readonly #moving: Int32Array;
  readonly #still: Int32Array;

  constructor(graph: BrainGraph, options: LayoutOptions) {
    const n = graph.nodes.length;
    this.graph = graph;
    this.arrangement = options.arrangement;
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    this.r = new Float64Array(n);
    for (let i = 0; i < n; i += 1) this.r[i] = 4.5 + Math.sqrt(graph.nodes[i]!.degree) * 3.2;

    this.#seq = Int32Array.from(
      graph.nodes.map((_, i) => i).sort((a, b) => (graph.nodes[a]!.key < graph.nodes[b]!.key ? -1 : 1)),
    );

    // Regions only where there are hemispheres to divide: the neighbourhood is
    // six notes round one, and a cell of the silhouette means nothing to it.
    const grouping =
      this.arrangement === 'brain' ? groupRegions(graph, graph.clusters) : { of: new Int32Array(n), regions: [] };
    this.regionOf = grouping.of;
    const k = grouping.regions.length;
    this.#cellX = new Float64Array(k);
    this.#cellY = new Float64Array(k);
    this.#cellW = new Float64Array(k);
    this.#cellR = new Float64Array(k);
    this.#spacing = new Float64Array(k);
    this.nodeSide = new Int8Array(n);
    this.#ax = new Float64Array(n);
    this.#ay = new Float64Array(n);
    this.#moving = new Int32Array(n);
    this.#still = new Int32Array(n);

    const notes = Math.max(n, MIN_NOTES);
    if (this.arrangement === 'brain') {
      this.unitLength = Math.sqrt((notes * AREA_PER_NOTE) / OUTLINE.area);
      // Room for the cell bodies and glow of the notes pressing against the rim.
      const pad = 30;
      this.bounds = {
        minX: OUTLINE.minX * this.unitLength - pad,
        minY: OUTLINE.minY * this.unitLength - pad,
        maxX: OUTLINE.maxX * this.unitLength + pad,
        maxY: OUTLINE.maxY * this.unitLength + pad,
      };
    } else {
      this.unitLength = Math.sqrt((Math.max(n, LOOSE_MIN_NOTES) * LOOSE_AREA_PER_NOTE) / Math.PI);
      const half = this.unitLength * 1.15;
      this.bounds = { minX: -half, minY: -half, maxX: half, maxY: half };
    }

    this.#links = new Uint32Array(n);
    for (let i = 0; i < n; i += 1) {
      const neighbours = graph.touching[i]!.map((e) => {
        const edge = graph.edges[e]!;
        return graph.nodes[edge.a === i ? edge.b : edge.a]!.key;
      });
      this.#links[i] = hash32([...new Set(neighbours)].sort().join('\n'));
    }

    const remembered = new Uint8Array(n);
    this.#remembered = remembered;
    const changed = new Uint8Array(n);
    let count = 0;
    for (let i = 0; i < n; i += 1) {
      const at = options.remembered?.get(graph.nodes[i]!.key);
      if (at === undefined || !Number.isFinite(at.x) || !Number.isFinite(at.y)) {
        changed[i] = 1;
        continue;
      }
      // A stored number can be finite and still absurd (1e308 is finite). Kept
      // within twice the arrangement's extent around its middle, and counted as
      // changed when it had to be pulled in, so the simulation may place it.
      const { minX, minY, maxX, maxY } = this.bounds;
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const rx = maxX - minX;
      const ry = maxY - minY;
      this.x[i] = Math.min(cx + rx, Math.max(cx - rx, at.x));
      this.y[i] = Math.min(cy + ry, Math.max(cy - ry, at.y));
      remembered[i] = 1;
      if (at.links !== this.#links[i] || this.x[i] !== at.x || this.y[i] !== at.y) changed[i] = 1;
      count += 1;
    }
    this.rememberedShare = n === 0 ? 1 : count / n;

    // The cells, and then the fence: a remembered note that is outside the
    // silhouette or well inside another region's cell is put back on the nearest
    // place of its own, and counts as changed so the simulation may tidy after
    // it. Otherwise a region that changed under a note would walk out of the
    // shape and stay there for ever, since a remembered note never moves.
    this.regions = this.arrangement === 'brain' ? this.#buildCells(grouping.regions, remembered) : [];
    if (this.arrangement === 'brain') this.#clampToCells(remembered, changed);

    this.mobile = new Uint8Array(n);
    this.#tether = new Uint8Array(n);
    this.#homeX = Float64Array.from(this.x);
    this.#homeY = Float64Array.from(this.y);
    if (this.rememberedShare < 0.5) {
      this.mobile.fill(1);
    } else {
      for (let i = 0; i < n; i += 1) {
        if (changed[i] !== 1) continue;
        this.mobile[i] = 1;
        if (remembered[i] === 1) {
          this.#tether[i] = 1;
          continue;
        }
        for (const e of graph.touching[i]!) {
          this.mobile[graph.edges[e]!.a] = 1;
          this.mobile[graph.edges[e]!.b] = 1;
        }
      }
    }

    // Springs in key order, with their strength decided once.
    const edges = graph.edges
      .map((e, index) => ({ e, index, ka: graph.nodes[e.a]!.key, kb: graph.nodes[e.b]!.key }))
      .sort((p, q) => (p.ka < q.ka ? -1 : p.ka > q.ka ? 1 : p.kb < q.kb ? -1 : p.kb > q.kb ? 1 : p.index - q.index));
    this.#springA = Int32Array.from(edges.map((s) => s.e.a));
    this.#springB = Int32Array.from(edges.map((s) => s.e.b));
    this.#springK = Float64Array.from(edges.map(({ e }) => {
      if (this.arrangement !== 'brain') return SPRING;
      const of = this.regionOf;
      if (this.nodeSide[e.a] !== this.nodeSide[e.b]) return SPRING * ACROSS_FISSURE;
      return of[e.a] === of[e.b] ? SPRING : SPRING * ACROSS_CLUSTERS;
    }));
    // Where a link comes to rest. Inside a region that is a step across its own
    // cell, not a fixed length: the places are what decide how dense a region
    // is, and a spring that wanted seventy units between two notes standing
    // forty apart pushed every galaxy back open as fast as it formed.
    this.#springRest = Float64Array.from(edges.map(({ e }) => {
      if (this.arrangement !== 'brain') return REST;
      const of = this.regionOf;
      if (of[e.a] !== of[e.b] || this.nodeSide[e.a] !== this.nodeSide[e.b]) return REST;
      return Math.min(REST, this.#spacing[of[e.a]!]! * WITHIN_REGION_REST);
    }));

    this.#seed(remembered);

    const fresh = this.rememberedShare < 0.5;
    if (fresh && this.arrangement === 'brain') this.#galaxies();
    this.alpha = !fresh ? WARM : this.arrangement === 'brain' ? JOIN : 1;
    if (fresh && this.arrangement === 'brain') this.#inertia = JOIN_INERTIA;
    // Nothing that may move, nothing to simulate: a refetch that changed no link.
    if (!this.mobile.includes(1)) this.settled = true;
  }

  /** True when a world point lies inside the silhouette. Decoration clips against this. */
  inside(x: number, y: number): boolean {
    const u = this.unitLength;
    if (this.arrangement !== 'brain') return Math.hypot(x, y) < u;
    return withinOutline(x / u, y / u);
  }

  /** Distance from a world point to the silhouette's edge, world units, negative outside. */
  depthInside(x: number, y: number): number {
    const u = this.unitLength;
    if (this.arrangement !== 'brain') return u - Math.hypot(x, y);
    return outlineDepth(x / u, y / u) * u;
  }

  /**
   * Divides the inside of the outline into one cell per region.
   *
   * Hemispheres first: a region most of whose notes are already somewhere keeps
   * the half they are in — that is what makes "Homelab bottom left" survive a
   * change to the clustering — and the rest are dealt out largest first to
   * whichever half carries fewer notes. The region that is mostly connective
   * tissue, the one whose notes link outwards more than any other's, is pinned
   * at the fissure: in a PARA vault that is the maps of content, and they are
   * what holds the two halves together.
   *
   * Then a weighted Lloyd relaxation over the grid points of each half: every
   * region ends up with a cell of about the area its note count asks for, and
   * the cells together cover the hemisphere out to the rim. That is why the
   * notes reach the outline — not because a force pushes them there.
   */
  #buildCells(groups: readonly RegionGroup[], remembered: Uint8Array): Region[] {
    const { nodes, edges, touching } = this.graph;
    const u = this.unitLength;
    const k = groups.length;
    if (k === 0) return [];

    const hubs: number[] = [];
    const outward = new Float64Array(k);
    groups.forEach((group, r) => {
      let hub = group.members[0]!;
      for (const i of group.members) if (nodes[i]!.degree > nodes[hub]!.degree) hub = i;
      hubs.push(hub);
      let out = 0;
      for (const i of group.members) {
        for (const e of touching[i]!) {
          const other = edges[e]!.a === i ? edges[e]!.b : edges[e]!.a;
          if (this.regionOf[other] !== r) out += 1;
        }
      }
      outward[r] = out / group.members.length;
    });
    // The connective region: the one whose notes link outwards most, among the
    // regions no larger than the average. The size bar matters — without it the
    // biggest region wins on some vaults simply by having the vault's busiest
    // note in it, and a region of twenty pinned at the fissure fills the middle
    // of the brain, which is the one place that has to stay clear.
    //
    // Counted in quarter-links per note, with the region's own identity as the
    // tie-break. One captured note changes an outward ratio by a twentieth, and
    // read exactly that was enough to hand the fissure to a different region —
    // which moves two cells to opposite ends of the brain for one new note.
    const average = groups.reduce((sum, group) => sum + group.members.length, 0) / k;
    let connective = -1;
    let lead = -1;
    for (let r = 0; r < k; r += 1) {
      // A whole folder group, never half of one. The two halves of a cut group
      // are dealt to opposite hemispheres as a pair; pinning one of them at the
      // fissure takes it out of that pair, leaves its sibling to the load deal,
      // and a capture that moved the pin swapped both halves across the brain.
      // It is also what the thing is: connective tissue is a part of the vault,
      // not one side of a part.
      if (groups[r]!.half >= 0) continue;
      if (groups[r]!.members.length > average) continue;
      const score = Math.round(outward[r]! * 4) / 4;
      const better =
        connective === -1 ||
        score > lead ||
        (score === lead && unit(groups[r]!.id, 'fissure') > unit(groups[connective]!.id, 'fissure'));
      if (better) {
        connective = r;
        lead = score;
      }
    }
    if (connective === -1) connective = 0;

    // The weight a cell's size and a hemisphere's load are counted in: one
    // share, plus one for every doubling of the notes in the region. Not the
    // note count itself and not its square root, for the reason the folder arcs
    // used the same rule — a weight that moved with every capture would redraw
    // every cell of the hemisphere, and tip the deal below, for one new note.
    for (let r = 0; r < k; r += 1) this.#cellW[r] = 1 + Math.floor(Math.log2(Math.max(1, groups[r]!.members.length)));

    const side = new Int8Array(k);
    const decided = new Uint8Array(k);
    const load: Record<number, number> = { [-1]: 0, [1]: 0 };
    groups.forEach((group, r) => {
      let known = 0;
      let left = 0;
      let sum = 0;
      for (const i of group.members) {
        if (remembered[i] !== 1) continue;
        known += 1;
        sum += this.x[i]!;
        if (this.x[i]! < 0) left += 1;
      }
      if (known === 0 || known * 2 < group.members.length) return;
      side[r] = left * 2 > known ? -1 : left * 2 < known ? 1 : sum < 0 ? -1 : 1;
      decided[r] = 1;
      load[side[r]!] = load[side[r]!]! + this.#cellW[r]!;
    });
    if (decided[connective] !== 1) {
      side[connective] = 1;
      decided[connective] = 1;
      // It counts for less on its side: sitting at the fissure it serves both.
      load[1] = load[1]! + this.#cellW[connective]! * 0.6;
    }
    // The two halves of a cut folder group go to opposite hemispheres. That
    // balances the halves by construction and, more to the point, it is stable:
    // a folder group is the same thing before and after a capture, while the
    // deal below depends on every region's weight and would re-deal the whole
    // brain when one of them crossed a doubling.
    const cut = new Map<string, number[]>();
    for (const r of groups.keys()) {
      if (decided[r] === 1 || groups[r]!.half < 0) continue;
      const list = cut.get(groups[r]!.group);
      if (list === undefined) cut.set(groups[r]!.group, [r]);
      else list.push(r);
    }
    for (const [, pair] of [...cut].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (pair.length !== 2) continue;
      const [a, b] = [...pair].sort((p, q) => groups[p]!.half - groups[q]!.half);
      // The first half left, the second right, and no hash anywhere near the
      // decision. Drawing lots from the region's identity looked neater until a
      // capture changed which cluster a region is named after and the two halves
      // swapped hemispheres for one new note.
      side[a!] = -1;
      side[b!] = 1;
      decided[a!] = 1;
      decided[b!] = 1;
      load[side[a!]!] = load[side[a!]!]! + this.#cellW[a!]!;
      load[side[b!]!] = load[side[b!]!]! + this.#cellW[b!]!;
    }
    [...groups.keys()]
      .filter((r) => decided[r] !== 1)
      .sort((a, b) => this.#cellW[b]! - this.#cellW[a]! || (groups[a]!.id < groups[b]!.id ? -1 : 1))
      .forEach((r) => {
        const to = load[-1]! <= load[1]! ? -1 : 1;
        side[r] = to;
        load[to] = load[to]! + this.#cellW[r]!;
      });

    // A remembered note keeps the hemisphere it is in, even when its region is
    // on the other side now: the fissure is not something a note should be
    // pushed across because a link somewhere else changed its cluster.
    groups.forEach((group, r) => {
      for (const i of group.members) this.nodeSide[i] = remembered[i] === 1 ? (this.x[i]! < 0 ? -1 : 1) : side[r]!;
    });

    // The grid of the interior, normalised.
    const cols = Math.round((OUTLINE.maxX - OUTLINE.minX) / SAMPLE_STEP);
    const rows = Math.round((OUTLINE.maxY - OUTLINE.minY) / SAMPLE_STEP);
    const sx: number[] = [];
    const sy: number[] = [];
    for (let a = 0; a <= cols; a += 1) {
      const px = OUTLINE.minX + a * SAMPLE_STEP;
      for (let b = 0; b <= rows; b += 1) {
        const py = OUTLINE.minY + b * SAMPLE_STEP;
        if (withinOutline(px, py, SAMPLE_MARGIN)) {
          sx.push(px);
          sy.push(py);
        }
      }
    }
    this.#sampleX = Float64Array.from(sx);
    this.#sampleY = Float64Array.from(sy);
    this.#sampleOf = new Int32Array(sx.length).fill(-1);

    const cellX = new Float64Array(k);
    const cellY = new Float64Array(k);
    for (const s of [-1, 1] as const) {
      // Ordered by the folder group and the half of it, never by an index and
      // never by a hash of the region's identity: the ring below places them by
      // their rank, and a rank that moved would swap two cells for one new note.
      // The folder group is the one thing here that a capture cannot change —
      // the region's identity can, as soon as another cluster becomes its
      // largest, and hashing that swapped cells across the brain.
      const mine = [...groups.keys()]
        .filter((r) => side[r] === s)
        .sort((a, b) => (groups[a]!.group < groups[b]!.group ? -1 : groups[a]!.group > groups[b]!.group ? 1 : groups[a]!.half - groups[b]!.half));
      if (mine.length === 0) continue;
      const h = centre(s);
      mine.forEach((r, rank) => {
        const phi = (rank / mine.length) * Math.PI * 2 + 0.7;
        cellX[r] = h.x + s * Math.cos(phi) * 0.3;
        cellY[r] = h.y + Math.sin(phi) * 0.45;
      });
      const pinned = side[connective] === s ? connective : -1;
      if (pinned !== -1) {
        cellX[pinned] = s * (FISSURE + FISSURE_CELL);
        cellY[pinned] = 0.02;
      }
      const points: number[] = [];
      for (let p = 0; p < sx.length; p += 1) if (sideOf(sx[p]!) === s) points.push(p);
      const accX = new Float64Array(mine.length);
      const accY = new Float64Array(mine.length);
      const accN = new Int32Array(mine.length);
      for (let it = 0; it < LLOYD_STEPS; it += 1) {
        accX.fill(0);
        accY.fill(0);
        accN.fill(0);
        for (const p of points) {
          let best = 0;
          let bd = Infinity;
          mine.forEach((r, slot) => {
            const dx = sx[p]! - cellX[r]!;
            const dy = sy[p]! - cellY[r]!;
            const d = (dx * dx + dy * dy) / this.#cellW[r]!;
            if (d < bd) {
              bd = d;
              best = slot;
            }
          });
          accX[best] = accX[best]! + sx[p]!;
          accY[best] = accY[best]! + sy[p]!;
          accN[best] = accN[best]! + 1;
        }
        mine.forEach((r, slot) => {
          if (r === pinned || accN[slot] === 0) return;
          cellX[r] = cellX[r]! + (accX[slot]! / accN[slot]! - cellX[r]!) * LLOYD_RATE;
          cellY[r] = cellY[r]! + (accY[slot]! / accN[slot]! - cellY[r]!) * LLOYD_RATE;
        });
      }
    }

    for (let r = 0; r < k; r += 1) {
      this.#cellX[r] = cellX[r]! * u;
      this.#cellY[r] = cellY[r]! * u;
    }
    const regions: Region[] = groups.map((group, r) => ({
      id: r,
      name: group.name,
      side: side[r] as Side,
      cx: this.#cellX[r]!,
      cy: this.#cellY[r]!,
      hub: hubs[r]!,
      members: group.members,
    }));

    // Which cell every sample fell to, and from that each cell's area.
    const area = new Int32Array(k);
    for (let p = 0; p < sx.length; p += 1) {
      const r = nearestCell(regions, this.#cellW, sx[p]! * u, sy[p]! * u, sideOf(sx[p]!));
      this.#sampleOf[p] = r;
      if (r !== -1) area[r] = area[r]! + 1;
    }
    for (let r = 0; r < k; r += 1) {
      const covered = Math.max(area[r]!, 1) * SAMPLE_STEP * SAMPLE_STEP;
      this.#cellR[r] = Math.sqrt(covered / Math.PI) * u;
      // How far apart the places in this cell will be: its area shared between
      // the notes and the surplus of free places. Worked out rather than taken
      // from the Poisson search, because a remembered brain never runs that
      // search and the springs still have to know what a step across the cell is.
      const places = Math.max(1, groups[r]!.members.length) * SITE_SURPLUS;
      this.#spacing[r] = Math.sqrt((covered * u * u) / places);
    }
    // Seeded from the folder group, for the same reason the ring is ordered by
    // it: a region re-draws every place in its cell when its seed changes.
    this.#regionSeed = Uint32Array.from(groups, (group) => hash32(`${group.group}#${group.half}`));
    return regions;
  }

  /**
   * Puts remembered notes back inside the shape.
   *
   * A stored position can be outside the shape the brain has now — it is, for
   * every position stored before this phase changed the outline — and a note
   * outside the shape would stay there for ever, because a remembered note is
   * never moved by the simulation. So a note past the rim is put back on the
   * nearest place of its own cell, and counts as changed so the simulation may
   * tidy up after it.
   *
   * **Only past the rim, deliberately.** An earlier version also pulled home a
   * note that had ended up in a neighbour's cell after its region changed under
   * it. That put the silhouette first and spatial memory second: an unrelated
   * capture that tipped one note's strongest tie moved notes on the far side of
   * the brain by fifty units, and a note that moves for no reason its owner can
   * see is the whole thing this layer exists to prevent. A note in the wrong
   * cell is still inside the brain and still where it was left; the cell force
   * nudges it home if and when it is allowed to move at all.
   */
  #clampToCells(remembered: Uint8Array, changed: Uint8Array): void {
    const u = this.unitLength;
    if (this.regions.length === 0) return;
    for (let i = 0; i < this.x.length; i += 1) {
      if (remembered[i] !== 1) continue;
      const r = this.regionOf[i]!;
      const region = this.regions[r];
      if (region === undefined) continue;
      const nx = this.x[i]! / u;
      const ny = this.y[i]! / u;
      if (withinOutline(nx, ny, CLAMP_MARGIN)) continue;
      const home = region.side === this.nodeSide[i] ? this.#nearestPlaceIn(r, this.x[i]!, this.y[i]!) : null;
      if (home !== null) {
        this.x[i] = home.x;
        this.y[i] = home.y;
      } else {
        // Its region is in the other half; only the outline is put right, and
        // the note stays in the half its owner last saw it in.
        const s = this.nodeSide[i] as Side;
        const h = centre(s);
        const px = nx - h.x;
        const py = ny - h.y;
        const edge = rim(s, Math.atan2(py, px * s));
        const dist = Math.hypot(px, py) || 1e-6;
        const f = Math.min(1, (edge * SAMPLE_MARGIN) / dist);
        let cx = (h.x + px * f) * u;
        const cy = (h.y + py * f) * u;
        const keep = FISSURE * FISSURE_KEEP * u;
        if (s * cx < keep) cx = s * keep;
        this.x[i] = cx;
        this.y[i] = cy;
      }
      changed[i] = 1;
    }
  }

  /** The place of region `r` nearest a world point, or null when it has no cell. */
  #nearestPlaceIn(r: number, x: number, y: number): Point | null {
    const u = this.unitLength;
    let best = -1;
    let bd = Infinity;
    for (let p = 0; p < this.#sampleOf.length; p += 1) {
      if (this.#sampleOf[p] !== r) continue;
      const dx = this.#sampleX[p]! * u - x;
      const dy = this.#sampleY[p]! * u - y;
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best === -1 ? null : { x: this.#sampleX[best]! * u, y: this.#sampleY[best]! * u };
  }

  /**
   * Fills every cell with places and puts its notes on them.
   *
   * The prototype's galaxies, and the step that replaced "lay each cluster out
   * on its own and let the shape emerge". A Poisson-disk sample of the cell's
   * own points at the largest spacing that still gives about a third more places
   * than notes; the hub takes the place nearest the cell's middle; every core
   * takes the free place furthest from the cores already set, which is what
   * spreads the knots over the cell instead of stacking them; and every leaf
   * takes the free place nearest the core it hangs off.
   *
   * Only for a brain nobody has seen. A remembered one has its positions, and
   * whatever is new is dropped beside what it links to (`#seed`).
   */
  #galaxies(): void {
    const { nodes, edges, touching } = this.graph;
    const u = this.unitLength;
    for (const region of this.regions) {
      const members = region.members;
      const m = members.length;
      if (m === 0) continue;
      const r = region.id;
      const seed = this.#regionSeed[r]!;
      const inRegion = new Set(members);
      // Members arrive in hash order; their position in that list is the only
      // tie-break used below, so nothing depends on the server's order.
      const place = new Map(members.map((i, p) => [i, p]));

      const weightTo = new Map<number, Map<number, number>>();
      const inDegree = new Map<number, number>();
      for (const i of members) {
        const to = new Map<number, number>();
        for (const e of touching[i]!) {
          const other = edges[e]!.a === i ? edges[e]!.b : edges[e]!.a;
          if (!inRegion.has(other) || other === i) continue;
          to.set(other, (to.get(other) ?? 0) + 1);
        }
        weightTo.set(i, to);
        inDegree.set(i, to.size);
      }

      const hub = region.hub;
      const coreCount = Math.max(1, Math.round(m / NOTES_PER_CORE));
      const cores = members
        .filter((i) => i !== hub && inDegree.get(i)! >= CORE_MIN_LINKS)
        .sort(
          (a, b) =>
            inDegree.get(b)! - inDegree.get(a)! || nodes[b]!.degree - nodes[a]!.degree || place.get(a)! - place.get(b)!,
        )
        .slice(0, coreCount - 1);
      const isCore = new Set([hub, ...cores]);

      // Every note hangs off the core it links to most — a secondary core
      // before the hub, so the secondary galaxies get their members — else off
      // the best-connected neighbour it has inside the region, else the hub.
      const parent = new Map<number, number>();
      for (const i of members) {
        if (i === hub) continue;
        if (isCore.has(i)) {
          parent.set(i, hub);
          continue;
        }
        let best = -1;
        let bestScore = -1;
        for (const [other, w] of weightTo.get(i)!) {
          if (!isCore.has(other)) continue;
          const score = w + (other === hub ? 0 : 0.5);
          if (score > bestScore || (score === bestScore && place.get(other)! < place.get(best)!)) {
            best = other;
            bestScore = score;
          }
        }
        if (best === -1) {
          for (const [other] of weightTo.get(i)!) {
            if (best === -1 || inDegree.get(other)! > inDegree.get(best)! || (inDegree.get(other)! === inDegree.get(best)! && place.get(other)! < place.get(best)!)) {
              best = other;
            }
          }
        }
        parent.set(i, best === -1 ? hub : best);
      }

      // Hub, then cores, then whoever's parent is already down.
      const order = [hub, ...cores];
      const down = new Set(order);
      let rest = members
        .filter((i) => !down.has(i))
        .sort((a, b) => nodes[b]!.degree - nodes[a]!.degree || place.get(a)! - place.get(b)!);
      while (rest.length > 0) {
        const ready = rest.filter((i) => down.has(parent.get(i)!));
        if (ready.length === 0) {
          for (const i of rest) parent.set(i, hub);
          continue;
        }
        for (const i of ready) {
          order.push(i);
          down.add(i);
        }
        rest = rest.filter((i) => !down.has(i));
      }

      let cell: number[] = [];
      for (let p = 0; p < this.#sampleOf.length; p += 1) if (this.#sampleOf[p] === r) cell.push(p);
      if (cell.length === 0) {
        // No cell at all — a region alone in a half too small to sample. A ring
        // around its centre is honest and never a divide by zero.
        order.forEach((i, p) => {
          const phi = (p / m) * Math.PI * 2 + 0.6;
          this.x[i] = region.cx + Math.cos(phi) * this.#cellR[r]! * 0.6;
          this.y[i] = region.cy + Math.sin(phi) * this.#cellR[r]! * 0.6;
        });
        continue;
      }

      // A region whose notes hardly link each other gathers round its core.
      let internal = 0;
      for (const i of members) internal += inDegree.get(i)!;
      if (internal / 2 < SPARSE_LINKS * m) {
        let far = 0;
        for (const p of cell) far = Math.max(far, Math.hypot(this.#sampleX[p]! * u - region.cx, this.#sampleY[p]! * u - region.cy));
        const inner = cell.filter(
          (p) => Math.hypot(this.#sampleX[p]! * u - region.cx, this.#sampleY[p]! * u - region.cy) < SPARSE_CELL * far,
        );
        if (inner.length >= m) cell = inner;
      }

      let lo = SPACING_MIN;
      let hi = SPACING_MAX;
      for (let step = 0; step < SPACING_STEPS; step += 1) {
        const mid = (lo + hi) / 2;
        if (poissonPick(this.#sampleX, this.#sampleY, cell, mid, seed).length >= m * SITE_SURPLUS) lo = mid;
        else hi = mid;
      }
      // Rounded down to a step, so a capture usually leaves the spacing — and
      // with it every place in the cell — exactly where it was. The search
      // resolves far finer than one note's worth of spacing, and without this
      // one more note in a region re-drew every place in it.
      lo = Math.max(SPACING_MIN, Math.floor(lo / SPACING_QUANT) * SPACING_QUANT);
      let sites = poissonPick(this.#sampleX, this.#sampleY, cell, lo, seed);
      if (sites.length < m) sites = cell;

      const freeX = sites.map((p) => this.#sampleX[p]! * u);
      const freeY = sites.map((p) => this.#sampleY[p]! * u);
      const coreX: number[] = [];
      const coreY: number[] = [];
      for (const i of order) {
        if (freeX.length === 0) {
          // More notes than places: stack the rest just off their parent, where
          // the repulsion will open them out.
          const from = parent.get(i) ?? hub;
          const phi = unit(nodes[i]!.key, 'spill') * Math.PI * 2;
          this.x[i] = this.x[from]! + Math.cos(phi) * NUDGE * 0.4;
          this.y[i] = this.y[from]! + Math.sin(phi) * NUDGE * 0.4;
          continue;
        }
        let pick = 0;
        let best = -Infinity;
        if (i === hub) {
          for (let s = 0; s < freeX.length; s += 1) {
            const v = -((freeX[s]! - region.cx) ** 2 + (freeY[s]! - region.cy) ** 2);
            if (v > best) {
              best = v;
              pick = s;
            }
          }
        } else if (isCore.has(i) && coreX.length > 0 && freeX.length > 1) {
          for (let s = 0; s < freeX.length; s += 1) {
            let nearest = Infinity;
            for (let c = 0; c < coreX.length; c += 1) {
              const d = (freeX[s]! - coreX[c]!) ** 2 + (freeY[s]! - coreY[c]!) ** 2;
              if (d < nearest) nearest = d;
            }
            if (nearest > best) {
              best = nearest;
              pick = s;
            }
          }
        } else {
          const from = parent.get(i) ?? hub;
          for (let s = 0; s < freeX.length; s += 1) {
            const v = -((freeX[s]! - this.x[from]!) ** 2 + (freeY[s]! - this.y[from]!) ** 2);
            if (v > best) {
              best = v;
              pick = s;
            }
          }
        }
        this.x[i] = freeX[pick]!;
        this.y[i] = freeY[pick]!;
        if (isCore.has(i)) {
          coreX.push(freeX[pick]!);
          coreY.push(freeY[pick]!);
        }
        freeX.splice(pick, 1);
        freeY.splice(pick, 1);
      }
    }
  }

  /**
   * Gives every node that was not remembered a starting point.
   *
   *  1. **Beside its neighbours**, for a note that is new since the last visit.
   *     Dropping it anywhere else would make the springs haul it across the
   *     picture and drag everything it passes out of place — one new note would
   *     rearrange the brain, which is exactly what must not happen.
   *  2. **In its cell**, for the rest: a point in the cell's disc, from the path
   *     hash. In a brain nobody has seen this is only a starting point —
   *     `#galaxies` then puts every note on a place of its cell.
   */
  #seed(remembered: Uint8Array): void {
    const { nodes, touching, edges } = this.graph;
    for (const i of this.#seq) {
      if (remembered[i] === 1) continue;
      const key = nodes[i]!.key;

      let sx = 0;
      let sy = 0;
      let count = 0;
      for (const e of touching[i]!) {
        const other = edges[e]!.a === i ? edges[e]!.b : edges[e]!.a;
        if (remembered[other] !== 1) continue;
        sx += this.x[other]!;
        sy += this.y[other]!;
        count += 1;
      }

      if (count > 0) {
        // Not exactly on top of them — two notes created together would then
        // start at the same point, and the repulsion would fling them apart in
        // a direction decided by floating-point noise.
        const angle = unit(key, 'nudge') * Math.PI * 2;
        this.x[i] = sx / count + Math.cos(angle) * NUDGE;
        this.y[i] = sy / count + Math.sin(angle) * NUDGE;
      } else if (this.arrangement === 'brain' && this.regions.length > 0) {
        const r = this.regionOf[i]!;
        const angle = unit(key, 'angle') * Math.PI * 2;
        const distance = Math.sqrt(unit(key, 'ring')) * this.#cellR[r]! * 0.8;
        this.x[i] = this.#cellX[r]! + Math.cos(angle) * distance;
        this.y[i] = this.#cellY[r]! + Math.sin(angle) * distance;
      } else {
        const angle = unit(key, 'angle') * Math.PI * 2;
        const distance = 40 + Math.floor(unit(key, 'ring') * 6) * 24;
        this.x[i] = Math.cos(angle) * distance;
        this.y[i] = Math.sin(angle) * distance;
      }
    }
  }

  /** Moves a node under the pointer. World coordinates, already converted. */
  place(i: number, wx: number, wy: number): void {
    // Not a wall, a leash: a note flung far outside would otherwise take the
    // camera's idea of the whole brain with it.
    const { minX, minY, maxX, maxY } = this.bounds;
    const slackX = (maxX - minX) * 0.25;
    const slackY = (maxY - minY) * 0.25;
    this.x[i] = Math.min(maxX + slackX, Math.max(minX - slackX, wx));
    this.y[i] = Math.min(maxY + slackY, Math.max(minY - slackY, wy));
    this.vx[i] = 0;
    this.vy[i] = 0;
  }

  /**
   * A node is picked up. It follows the pointer (`place`), and its direct
   * neighbours are freed to follow it; nothing else moves.
   *
   * Only the neighbours: an earlier version freed the whole brain, and because a
   * simulation stopped by cooling is never exactly at rest, every press moved
   * every note a little — stored, and added up with the next press.
   */
  hold(i: number): void {
    this.pinned = i;
    this.mobile.fill(0);
    this.#tether.fill(0);
    this.#inertia = INERTIA;
    for (const e of this.graph.touching[i]!) {
      this.mobile[this.graph.edges[e]!.a] = 1;
      this.mobile[this.graph.edges[e]!.b] = 1;
    }
    this.mobile[i] = 0;
    this.alphaTarget = HELD;
    this.alpha = Math.max(this.alpha, HELD);
    this.settled = false;
  }

  /**
   * The node is let go. It stays where it was dropped — it is not freed, so it
   * does not spring back towards where the forces would rather have it — and
   * its neighbours settle around it.
   */
  release(): void {
    if (this.pinned >= 0) this.mobile[this.pinned] = 0;
    this.pinned = -1;
    this.alphaTarget = 0;
  }

  /** Runs until settled, or for at most `limit` steps. Returns the steps taken. */
  settle(limit = 2000): number {
    let steps = 0;
    while (!this.settled && steps < limit) {
      this.step();
      steps += 1;
    }
    return steps;
  }

  /** Mean squared speed per node: how much is still moving. */
  energy(): number {
    let sum = 0;
    for (let i = 0; i < this.vx.length; i += 1) sum += this.vx[i]! ** 2 + this.vy[i]! ** 2;
    return this.vx.length === 0 ? 0 : sum / this.vx.length;
  }

  /** One step. Returns false once the layout has come to rest. */
  step(): boolean {
    if (this.settled) return false;
    const alpha = this.alpha;
    const { x, y, vx, vy } = this;
    // Forces go into the velocities scaled by the temperature; the velocities
    // then lose part of themselves and move the nodes.
    const ax = this.#ax.fill(0);
    const ay = this.#ay.fill(0);

    // Only what may move needs a force. In key order, split into the moving and
    // the still, so the sums stay independent of the server's order.
    let m = 0;
    let st = 0;
    for (const i of this.#seq) {
      if (this.mobile[i] === 1 && i !== this.pinned) this.#moving[m++] = i;
      else this.#still[st++] = i;
    }
    const brain = this.arrangement === 'brain';
    repel(
      x, y, ax, ay,
      this.#moving.subarray(0, m), this.#still.subarray(0, st),
      brain ? this.regionOf : null,
      brain ? BRAIN_REPULSION : REPULSION,
      brain ? BRAIN_CUTOFF : CUTOFF,
    );
    this.#springs(ax, ay);
    if (this.arrangement === 'brain') this.#shape(ax, ay);
    else this.#gather(ax, ay);
    for (const i of this.#seq) {
      if (this.#tether[i] !== 1) continue;
      ax[i] = ax[i]! - (x[i]! - this.#homeX[i]!) * TETHER;
      ay[i] = ay[i]! - (y[i]! - this.#homeY[i]!) * TETHER;
    }

    for (const i of this.#seq) {
      if (i === this.pinned || this.mobile[i] !== 1) {
        vx[i] = 0;
        vy[i] = 0;
        continue;
      }
      const [nx, ny] = capped((vx[i]! + ax[i]! * alpha) * this.#inertia, (vy[i]! + ay[i]! * alpha) * this.#inertia);
      vx[i] = nx;
      vy[i] = ny;
      x[i] = x[i]! + nx;
      y[i] = y[i]! + ny;
      if (this.arrangement === 'brain') this.#wall(i);
    }

    this.alpha += (this.alphaTarget - this.alpha) * COOLING;
    if (this.alpha < FROZEN && this.alphaTarget === 0) {
      this.settled = true;
      vx.fill(0);
      vy.fill(0);
      this.mobile.fill(0);
      this.#tether.fill(0);
      this.#inertia = INERTIA;
    }
    return !this.settled;
  }

  /**
   * The wall: a note that a step moved out of the shape is put back on it.
   *
   * The containment force alone cannot hold the outline, and it took a phase to
   * see why. Forces are scaled by a temperature that falls to zero, so a note
   * that a spring pulled past the rim early is not pushed back before the
   * simulation freezes — it simply stops a few percent outside, and the rim the
   * whole picture is built on is ragged. A projection costs nothing and is
   * exactly the promise: the silhouette contains the notes.
   *
   * Only for a note the simulation moved. A note under the pointer is on a
   * leash and not a wall (`place`), because dragging a note out of the brain to
   * look at it is a thing somebody may want to do.
   */
  #wall(i: number): void {
    const u = this.unitLength;
    const side = this.nodeSide[i] as Side;
    const h = centre(side);
    const px = this.x[i]! / u - h.x;
    const py = this.y[i]! / u - h.y;
    const dist = Math.hypot(px, py);
    const edge = rim(side, Math.atan2(py, px * side)) * WALL;
    if (dist > edge) {
      this.x[i] = (h.x + (px * edge) / dist) * u;
      this.y[i] = (h.y + (py * edge) / dist) * u;
    }
    const keep = FISSURE * FISSURE_KEEP * u;
    if (side * this.x[i]! < keep) this.x[i] = side * keep;
  }

  #springs(ax: Float64Array, ay: Float64Array): void {
    const { x, y } = this;
    for (let s = 0; s < this.#springA.length; s += 1) {
      const a = this.#springA[s]!;
      const b = this.#springB[s]!;
      const dx = x[b]! - x[a]!;
      const dy = y[b]! - y[a]!;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d - this.#springRest[s]!) * this.#springK[s]!;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      ax[a] = ax[a]! + fx;
      ay[a] = ay[a]! + fy;
      ax[b] = ax[b]! - fx;
      ay[b] = ay[b]! - fy;
    }
  }

  /**
   * The fine correction: cohesion to the cell, and containment in the cell, the
   * hemisphere and out of the fissure.
   *
   * There is no *placement* force any more. A cluster used to drift as a whole
   * towards a place, because the place was all that said where a region was;
   * now the cell says it, the notes are already on it, and a force pulling
   * whole regions about would only undo that.
   */
  #shape(ax: Float64Array, ay: Float64Array): void {
    const { x, y } = this;
    const u = this.unitLength;
    for (const i of this.#seq) {
      const r = this.regionOf[i]!;
      const region = this.regions[r];
      let fx = 0;
      let fy = 0;

      if (region !== undefined) {
        // Cohesion towards the cell's middle, and nothing inside most of it. A
        // remembered note far outside its cell did not stray: its region changed
        // under it, because a link elsewhere tipped its strongest tie. It stays
        // where it is remembered rather than crossing the brain to join.
        const dx = region.cx - x[i]!;
        const dy = region.cy - y[i]!;
        const d = Math.hypot(dx, dy);
        const free = this.#cellR[r]! * COHESION_FREE;
        if (d > free && !(this.#remembered[i] === 1 && d > this.#cellR[r]! * LET_GO)) {
          const f = ((d - free) * COHESION) / d;
          fx += dx * f;
          fy += dy * f;
        }
        // Home: a note that has drifted into a neighbour's cell is pushed back.
        if (region.side === this.nodeSide[i]) {
          const near = nearestCell(this.regions, this.#cellW, x[i]!, y[i]!, this.nodeSide[i]!);
          if (near !== -1 && near !== r) {
            fx += dx * CELL_HOME;
            fy += dy * CELL_HOME;
          }
        }
      }

      // Containment, measured in normalised units against the node's hemisphere.
      const side = this.nodeSide[i] as Side;
      const h = centre(side);
      const px = x[i]! / u - h.x;
      const py = y[i]! / u - h.y;
      const dist = Math.hypot(px, py);
      const edge = rim(side, Math.atan2(py, px * side));
      if (dist > edge) {
        const f = ((dist - edge) * u * CONTAINMENT) / (dist || 1);
        fx -= px * f;
        fy -= py * f;
      }
      // Out of the fissure: the gap between the halves has to stay a gap.
      const keep = FISSURE * FISSURE_KEEP * u;
      if (side * x[i]! < keep) fx += side * (keep - side * x[i]!) * FISSURE_PUSH;

      ax[i] = ax[i]! + fx;
      ay[i] = ay[i]! + fy;
    }
  }

  /** The loose arrangement: a soft pull to the middle, and a soft round edge. */
  #gather(ax: Float64Array, ay: Float64Array): void {
    const { x, y } = this;
    const edge = this.unitLength;
    for (const i of this.#seq) {
      const d = Math.hypot(x[i]!, y[i]!);
      let f = GRAVITY;
      if (d > edge) f += ((d - edge) * CONTAINMENT) / d;
      ax[i] = ax[i]! - x[i]! * f;
      ay[i] = ay[i]! - y[i]! * f;
    }
  }

  /** What to remember for next time, keyed by `nodeKey`. */
  positions(): Map<string, Place> {
    const out = new Map<string, Place>();
    for (let i = 0; i < this.graph.nodes.length; i += 1) {
      out.set(this.graph.nodes[i]!.key, { x: this.x[i]!, y: this.y[i]!, links: this.#links[i]! });
    }
    return out;
  }
}

/**
 * A velocity, limited to `MAX_SPEED` units a step.
 *
 * Repulsion grows with the inverse square of the distance, so two notes that
 * happen to start almost on top of each other get a push large enough to throw
 * one of them out of the brain in a single step. Nothing a note legitimately
 * does in a step comes near the limit.
 */
function capped(vx: number, vy: number): [number, number] {
  const speed = Math.hypot(vx, vy);
  return speed <= MAX_SPEED ? [vx, vy] : [(vx / speed) * MAX_SPEED, (vy / speed) * MAX_SPEED];
}

/** Weighted squared distance from a world point to a region's cell centre. */
function weightedDistance(region: Region, weight: number, x: number, y: number): number {
  return ((x - region.cx) ** 2 + (y - region.cy) ** 2) / weight;
}

/**
 * Which region's cell a world point falls in: the nearest weighted centre on
 * its own side, or -1 when that half has no region at all.
 *
 * Weighted by the square root of the note count, which is what makes a region
 * of twenty notes claim a wider cell than one of six without claiming the
 * hemisphere.
 */
function nearestCell(regions: readonly Region[], weight: Float64Array, x: number, y: number, side: number): number {
  let best = -1;
  let bd = Infinity;
  for (const region of regions) {
    if (region.side !== side) continue;
    const d = weightedDistance(region, weight[region.id]!, x, y);
    if (d < bd) {
      bd = d;
      best = region.id;
    }
  }
  return best;
}

/**
 * A Poisson-disk sample of a cell: the points of it that are at least `spacing`
 * apart, taken in an order that depends only on the region's identity.
 *
 * The naive version compared each candidate against every point accepted so far
 * and cost a few million comparisons per layout; this buckets the accepted
 * points by `spacing`, so a candidate only looks at the nine buckets around it.
 * The two give the same answer for the same order.
 */
function poissonPick(
  px: Float64Array,
  py: Float64Array,
  points: readonly number[],
  spacing: number,
  seed: number,
): number[] {
  const order = points.slice();
  let state = seed >>> 0 || 1;
  for (let i = order.length - 1; i > 0; i -= 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    const j = state % (i + 1);
    const swap = order[i]!;
    order[i] = order[j]!;
    order[j] = swap;
  }
  const inv = 1 / spacing;
  const buckets = new Map<number, number[]>();
  // The grid runs over normalised coordinates, well inside ±2, so a bucket
  // index fits in a few bits either way; the offset keeps it non-negative.
  const key = (gx: number, gy: number): number => (gx + 4096) * 8192 + (gy + 4096);
  const out: number[] = [];
  for (const p of order) {
    const gx = Math.floor(px[p]! * inv);
    const gy = Math.floor(py[p]! * inv);
    let ok = true;
    for (let a = -1; a <= 1 && ok; a += 1) {
      for (let b = -1; b <= 1 && ok; b += 1) {
        const bucket = buckets.get(key(gx + a, gy + b));
        if (bucket === undefined) continue;
        for (const q of bucket) {
          const dx = px[p]! - px[q]!;
          const dy = py[p]! - py[q]!;
          if (dx * dx + dy * dy < spacing * spacing) {
            ok = false;
            break;
          }
        }
      }
    }
    if (!ok) continue;
    out.push(p);
    const bucket = buckets.get(key(gx, gy));
    if (bucket === undefined) buckets.set(key(gx, gy), [p]);
    else bucket.push(p);
  }
  return out;
}

/**
 * Repulsion on every node that may move, from every node closer than the cutoff.
 *
 * The one O(n²) loop, and deliberately a function of flat arrays and nothing
 * else: Barnes-Hut replaces exactly this, and a worker can run it on arrays it
 * owns. Pairs of which neither note may move are skipped — nothing would come
 * of them — so a remembered brain that only has to place a captured note costs
 * a single row instead of the full triangle. `region` makes notes of different
 * regions push harder, which is what opens a furrow between them; null for the
 * loose arrangement, which has none.
 */
function repel(
  x: Float64Array,
  y: Float64Array,
  ax: Float64Array,
  ay: Float64Array,
  moving: Int32Array,
  still: Int32Array,
  region: Int32Array | null,
  strength: number,
  cutoff: number,
): void {
  // Written out twice rather than through a helper returning a pair: a tuple
  // per pair per frame is thousands of short-lived arrays for the collector.
  for (let p = 0; p < moving.length; p += 1) {
    const i = moving[p]!;
    const xi = x[i]!;
    const yi = y[i]!;
    let fxi = ax[i]!;
    let fyi = ay[i]!;
    for (let q = p + 1; q < moving.length; q += 1) {
      const j = moving[q]!;
      const dx = x[j]! - xi;
      const dy = y[j]! - yi;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      if (d > cutoff) continue;
      let f = strength / (d * d);
      if (region !== null && region[i] !== region[j]) f *= APART;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      fxi -= fx;
      fyi -= fy;
      ax[j] = ax[j]! + fx;
      ay[j] = ay[j]! + fy;
    }
    for (let q = 0; q < still.length; q += 1) {
      const j = still[q]!;
      const dx = x[j]! - xi;
      const dy = y[j]! - yi;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      if (d > cutoff) continue;
      let f = strength / (d * d);
      if (region !== null && region[i] !== region[j]) f *= APART;
      fxi -= (dx / d) * f;
      fyi -= (dy / d) * f;
    }
    ax[i] = fxi;
    ay[i] = fyi;
  }
}
