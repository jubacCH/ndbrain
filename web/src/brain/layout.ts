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
 * **How the brain takes shape, without a mask.** Every cluster gets a region: a
 * hemisphere, a place in it, and a size that grows with its members. In a brain
 * nobody has seen yet, each region is first laid out on its own — its notes,
 * their repulsion, the springs of the links among them — and only then does
 * the whole brain run together, cool, so that neighbouring regions make room
 * and the links between them pull. Three gentle forces add the brain:
 *
 *  - *cohesion*: a note that strays too far from the middle of its cluster —
 *    most of its region's radius — is drawn back. Inside that nothing pulls,
 *    so a cluster takes whatever organic form its links give it.
 *  - *placement*: a cluster as a whole drifts towards its place, but only once
 *    it is further than a dead zone away. That dead zone is what lets a
 *    remembered arrangement stay put when the place itself shifts a little.
 *  - *containment*: a note past its hemisphere's outline (`shape.ts`) is nudged
 *    back, harder the further it is out; a note deep in the middle of its
 *    hemisphere is nudged gently outwards, towards the cortex. In between,
 *    nothing.
 *
 * Nothing places a note inside the silhouette. The outline is filled because the
 * regions are spread round both hemispheres near the rim and their notes push
 * out against it.
 *
 * **Where a region is, and why that survives a change to the vault.** A
 * cluster's *anchor* lies in the arc of the folder most of its members are in
 * (`folderArcs`), at a point along the arc and a depth that come from the
 * hash of its core — the part of a cluster that captures rarely change. No
 * rank, no slot number, no relaxation against other regions: a capture moves
 * no other cluster's anchor unless it doubles a folder's note count or opens a
 * new folder. (The first version numbered the notes along a loop in path
 * order, so one capture shifted every anchor after it, and then let regions
 * push each other apart, so one region's size moved all the others.)
 * That only decides a region that nobody has seen yet. Once the notes
 * have been laid out and remembered, a cluster's place is simply where most of
 * its members already are. Clusters can change when links change — a note
 * torn between two ties may switch (`clusters.ts`) — but a region's place is
 * never a number the clustering hands out: renumbering moves nothing, and a
 * merged or split cluster finds its members where they already were.
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

import type { BrainGraph } from './model';
import { hash32, unit } from './seed';
import type { Side } from './shape';
import { OUTLINE, centre, pointAt, rim } from './shape';

export interface Point {
  x: number;
  y: number;
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
/** A region's area, as a share of the area its notes would have to themselves. */
const REGION_FILL = 0.85;

/**
 * How deep in its hemisphere a region's anchor sits, as a share of the rim:
 * between `ANCHOR_DEEPEST` and `ANCHOR_DEPTH`, from the core's hash.
 *
 * Near the rim rather than in the middle. The notes of a brain live in its
 * cortex, and on screen the cortex is what draws the outline: regions along
 * the rim trace the silhouette with their own cell bodies, while the tracts
 * between them run through the middle.
 */
const ANCHOR_DEPTH = 0.8;
const ANCHOR_DEEPEST = 0.35;

/** Repulsion between two notes at distance d is REPULSION / d². */
const REPULSION = 1600;
/** Beyond this the repulsion is a few hundredths of a unit and invisible. */
const CUTOFF = 230;
/**
 * Notes of different clusters push a little harder, which opens a furrow
 * between regions. Only a little: much harder, and linked regions end up far
 * apart with long tracts spanned across the brain between them.
 */
const APART = 2;

const SPRING = 0.012;
const REST = 70;
/**
 * A link between clusters pulls less than one inside a cluster, and one across
 * the fissure much less. It is still drawn at full strength; but at full pull a
 * handful of links across the middle would close the fissure.
 */
const ACROSS_CLUSTERS = 0.4;
const ACROSS_FISSURE = 0.05;

/** Region radius, as a share, within which cohesion does nothing. */
const COHESION_FREE = 0.6;
const COHESION = 0.02;
/**
 * Beyond this many region radii from its cluster, a remembered note is not
 * drawn back. Twice the radius is further than any member settles in a layout
 * of its own; a note that far out got there by being reassigned.
 */
const LET_GO = 2;
/** Region radius, as a share, within which placement does nothing. */
const PLACEMENT_FREE = 0.3;
const PLACEMENT = 0.004;
/** Past the rim, the push back in, per unit of overshoot. */
const CONTAINMENT = 0.25;
/**
 * Inside this share of the rim, a slight push outwards.
 *
 * Cross-links pull notes towards the middle of their hemisphere. A slight push
 * keeps the middle from filling into a disc; the first, stronger version
 * emptied it, and the hemispheres read as two rings.
 */
const HOLLOW = 0.6;
const HOLLOW_PUSH = 0.01;
/** The loose arrangement's gentle pull towards the middle. */
const GRAVITY = 0.004;

/**
 * How far round its hemisphere the anchors go, as a share of a half turn each
 * way from the outward direction: most of the way to the fissure, so the
 * inner halves are used too.
 */
const SWEEP = 0.8;
/** The most a note may move in one step, in world units. */
const MAX_SPEED = 30;
/** Velocity kept per step. Lower is calmer; this is still lively enough to see settle. */
const INERTIA = 0.72;
/** How fast the temperature falls towards its target, per step. */
const COOLING = 0.016;
/** Below this the layout counts as settled and stops. */
const FROZEN = 0.004;
/**
 * The temperature a fresh brain starts at once every region has been laid out
 * on its own, and the velocity kept per step while it cools: enough for
 * neighbouring regions to push apart and for the links between them to pull,
 * not enough to rearrange what the regions settled on. Heavily damped, because
 * damped motion follows the forces instead of overshooting, and an overshoot
 * is where one more note in the vault becomes a different brain.
 */
const JOIN = 1;
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
   * Per cluster: its anchor (world), its place — the anchor, or where its
   * remembered members are — its region radius and its hemisphere.
   */
  readonly anchorX: Float64Array;
  readonly anchorY: Float64Array;
  readonly placeX: Float64Array;
  readonly placeY: Float64Array;
  readonly radius: Float64Array;
  readonly side: Int8Array;

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
  /** Live centroid per cluster, recomputed each step. */
  readonly #cx: Float64Array;
  readonly #cy: Float64Array;
  /** Hemisphere per node: its cluster's, or for a remembered note the one it is in. */
  readonly #nodeSide: Int8Array;
  /** Force accumulators, reused: a fresh array per frame is garbage per frame. */
  readonly #ax: Float64Array;
  readonly #ay: Float64Array;
  /** Scratch lists of the moving and the still nodes, in key order. */
  readonly #moving: Int32Array;
  readonly #still: Int32Array;

  constructor(graph: BrainGraph, options: LayoutOptions) {
    const n = graph.nodes.length;
    const clusters = graph.clusters.clusters;
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

    const k = clusters.length;
    this.anchorX = new Float64Array(k);
    this.anchorY = new Float64Array(k);
    this.placeX = new Float64Array(k);
    this.placeY = new Float64Array(k);
    this.radius = new Float64Array(k);
    this.side = new Int8Array(k);
    this.#cx = new Float64Array(k);
    this.#cy = new Float64Array(k);
    this.#nodeSide = new Int8Array(n);
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

    if (this.arrangement === 'brain') this.#placeRegions(remembered);

    // Springs in key order, with their strength decided once.
    const edges = graph.edges
      .map((e, index) => ({ e, index, ka: graph.nodes[e.a]!.key, kb: graph.nodes[e.b]!.key }))
      .sort((p, q) => (p.ka < q.ka ? -1 : p.ka > q.ka ? 1 : p.kb < q.kb ? -1 : p.kb > q.kb ? 1 : p.index - q.index));
    this.#springA = Int32Array.from(edges.map((s) => s.e.a));
    this.#springB = Int32Array.from(edges.map((s) => s.e.b));
    this.#springK = Float64Array.from(edges.map(({ e }) => {
      if (this.arrangement !== 'brain') return SPRING;
      const of = graph.clusters.of;
      if (this.#nodeSide[e.a] !== this.#nodeSide[e.b]) return SPRING * ACROSS_FISSURE;
      return of[e.a] === of[e.b] ? SPRING : SPRING * ACROSS_CLUSTERS;
    }));

    this.#seed(remembered);

    const fresh = this.rememberedShare < 0.5;
    if (fresh && this.arrangement === 'brain') {
      for (let c = 0; c < clusters.length; c += 1) this.#arrangeRegion(c);
    }
    this.alpha = !fresh ? WARM : this.arrangement === 'brain' ? JOIN : 1;
    if (fresh && this.arrangement === 'brain') this.#inertia = JOIN_INERTIA;
    // Nothing that may move, nothing to simulate: a refetch that changed no link.
    if (!this.mobile.includes(1)) this.settled = true;
  }

  /**
   * Decides every cluster's hemisphere, place and size.
   *
   * A cluster most of whose members are remembered keeps the place they are
   * at and the hemisphere most of them are in. Only a cluster that is mostly
   * new is placed from its anchor — and from nothing else. The first version
   * let new regions push each other apart in a small relaxation; that made
   * every region's place depend on every other region's size, and one captured
   * note moved regions on the far side of the brain by two hundred units.
   */
  #placeRegions(remembered: Uint8Array): void {
    const { nodes } = this.graph;
    const { clusters } = this.graph.clusters;
    const u = this.unitLength;
    const arcs = folderArcs(nodes, clusters);
    const arcOf = arcs.arcOf;
    clusters.forEach((cluster, c) => {
      const members = cluster.members;
      this.radius[c] = Math.sqrt((members.length * AREA_PER_NOTE * REGION_FILL) / Math.PI);

      // The anchor, from the folder's arc and the cluster's core and from
      // nothing else: how far along the arc and how deep, both from the core's
      // hash. No slot numbers — a numbered slot would move whenever another
      // cluster in the same folder appeared.
      const arc = arcOf[c]!;
      const g = arcs.start[arc]! + (0.08 + 0.84 * unit(cluster.core, 'along')) * arcs.size[arc]!;
      const anchorSide = arcs.side[arc]! as Side;
      // Around most of the hemisphere, not only its outer half: from the front
      // of the fissure, out and round, to the back of the fissure. (Measured from
      // the outward direction; ±π would be the fissure itself.)
      const sweep = Math.PI * SWEEP;
      const phi = anchorSide === -1 ? -sweep + 2 * sweep * g : sweep - 2 * sweep * g;
      const depth = ANCHOR_DEPTH - (ANCHOR_DEPTH - ANCHOR_DEEPEST) * unit(cluster.core, 'depth');
      const anchor = pointAt(anchorSide, phi, depth);
      this.anchorX[c] = anchor.x * u;
      this.anchorY[c] = anchor.y * u;

      let known = 0;
      let kx = 0;
      let ky = 0;
      let left = 0;
      for (const i of members) {
        if (remembered[i] !== 1) continue;
        known += 1;
        kx += this.x[i]!;
        ky += this.y[i]!;
        if (this.x[i]! < 0) left += 1;
      }

      let side: Side = anchorSide;
      if (known * 2 >= members.length && known > 0) {
        side = left * 2 > known ? -1 : left * 2 < known ? 1 : kx < 0 ? -1 : 1;
        this.placeX[c] = kx / known;
        this.placeY[c] = ky / known;
      } else {
        this.placeX[c] = this.anchorX[c]!;
        this.placeY[c] = this.anchorY[c]!;
      }
      this.side[c] = side;
      // A remembered note keeps the hemisphere it is in, even when its cluster
      // is on the other side now: the fissure is not something a note should be
      // pushed across because a link somewhere else changed its cluster.
      for (const i of members) this.#nodeSide[i] = remembered[i] === 1 ? (this.x[i]! < 0 ? -1 : 1) : side;
    });
  }

  /**
   * Lays out one cluster inside its region, as if nothing else existed.
   *
   * The brief's "a local force simulation per region", and the reason a
   * capture without any stored positions does not reshuffle the brain: a
   * cluster whose members did not change gets the same arrangement, shifted
   * with its region, whatever happened in the next cluster. Only afterwards
   * does the whole brain run together, and then cool (`JOIN`), just enough for
   * the links between regions and the push between neighbours to take effect.
   * Simulated jointly from the start, the same vault with one note more ran
   * through a few hundred chaotic steps and came out visibly different
   * everywhere.
   */
  #arrangeRegion(c: number): void {
    const members = this.graph.clusters.clusters[c]!.members;
    const k = members.length;
    if (k < 2) return;
    const { x, y } = this;
    const inside = new Set(members);
    const springs = this.#springPairs().filter(([a, b]) => inside.has(a) && inside.has(b));
    const vx = new Float64Array(k);
    const vy = new Float64Array(k);
    const fx = new Float64Array(k);
    const fy = new Float64Array(k);
    const slot = new Map(members.map((i, s) => [i, s]));
    let alpha = 1;
    while (alpha >= FROZEN) {
      fx.fill(0);
      fy.fill(0);
      for (let p = 0; p < k; p += 1) {
        const i = members[p]!;
        for (let q = p + 1; q < k; q += 1) {
          const j = members[q]!;
          const dx = x[j]! - x[i]!;
          const dy = y[j]! - y[i]!;
          const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          if (d > CUTOFF) continue;
          const f = REPULSION / (d * d);
          fx[p] = fx[p]! - (dx / d) * f;
          fy[p] = fy[p]! - (dy / d) * f;
          fx[q] = fx[q]! + (dx / d) * f;
          fy[q] = fy[q]! + (dy / d) * f;
        }
      }
      for (const [a, b] of springs) {
        const dx = x[b]! - x[a]!;
        const dy = y[b]! - y[a]!;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - REST) * SPRING;
        const sa = slot.get(a)!;
        const sb = slot.get(b)!;
        fx[sa] = fx[sa]! + (dx / d) * f;
        fy[sa] = fy[sa]! + (dy / d) * f;
        fx[sb] = fx[sb]! - (dx / d) * f;
        fy[sb] = fy[sb]! - (dy / d) * f;
      }
      for (let p = 0; p < k; p += 1) {
        const i = members[p]!;
        this.#pull(i, this.placeX[c]!, this.placeY[c]!, this.radius[c]!, fx, fy, p);
        const [nx, ny] = capped((vx[p]! + fx[p]! * alpha) * INERTIA, (vy[p]! + fy[p]! * alpha) * INERTIA);
        vx[p] = nx;
        vy[p] = ny;
        x[i] = x[i]! + nx;
        y[i] = y[i]! + ny;
      }
      alpha -= alpha * COOLING;
    }
  }

  /** Spring endpoints in key order. */
  #springPairs(): Array<[number, number]> {
    return Array.from(this.#springA, (a, s) => [a, this.#springB[s]!] as [number, number]);
  }

  /**
   * Gives every node that was not remembered a starting point.
   *
   *  1. **Beside its neighbours**, for a note that is new since the last visit.
   *     Dropping it anywhere else would make the springs haul it across the
   *     picture and drag everything it passes out of place — one new note would
   *     rearrange the brain, which is exactly what must not happen.
   *  2. **In its region**, for the rest: a point in the region's disc, from the
   *     path hash. This is where the simulation starts, not where it ends — the
   *     local forces take it from there.
   */
  #seed(remembered: Uint8Array): void {
    const { nodes, touching, edges, clusters } = this.graph;
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
      } else if (this.arrangement === 'brain') {
        const c = clusters.of[i]!;
        const angle = unit(key, 'angle') * Math.PI * 2;
        const distance = Math.sqrt(unit(key, 'ring')) * this.radius[c]! * 0.8;
        this.x[i] = this.placeX[c]! + Math.cos(angle) * distance;
        this.y[i] = this.placeY[c]! + Math.sin(angle) * distance;
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
    repel(x, y, ax, ay, this.#moving.subarray(0, m), this.#still.subarray(0, st), this.arrangement === 'brain' ? this.graph.clusters.of : null);
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

  #springs(ax: Float64Array, ay: Float64Array): void {
    const { x, y } = this;
    for (let s = 0; s < this.#springA.length; s += 1) {
      const a = this.#springA[s]!;
      const b = this.#springB[s]!;
      const dx = x[b]! - x[a]!;
      const dy = y[b]! - y[a]!;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d - REST) * this.#springK[s]!;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      ax[a] = ax[a]! + fx;
      ay[a] = ay[a]! + fy;
      ax[b] = ax[b]! - fx;
      ay[b] = ay[b]! - fy;
    }
  }

  /** Cohesion, placement and containment: the three forces that make it a brain. */
  #shape(ax: Float64Array, ay: Float64Array): void {
    const { x, y } = this;
    const { clusters, of } = this.graph.clusters;

    // Live centroids, members in hash order so the sums do not depend on the reply.
    clusters.forEach((cluster, c) => {
      let sx = 0;
      let sy = 0;
      for (const i of cluster.members) {
        sx += x[i]!;
        sy += y[i]!;
      }
      this.#cx[c] = sx / cluster.members.length;
      this.#cy[c] = sy / cluster.members.length;
    });

    clusters.forEach((_, c) => {
      // Placement: the whole cluster at once, and only outside the dead zone.
      const gx = this.placeX[c]! - this.#cx[c]!;
      const gy = this.placeY[c]! - this.#cy[c]!;
      const gap = Math.hypot(gx, gy);
      const free = this.radius[c]! * PLACEMENT_FREE;
      if (gap > free) {
        const f = ((gap - free) * PLACEMENT) / gap;
        for (const i of clusters[c]!.members) {
          ax[i] = ax[i]! + gx * f;
          ay[i] = ay[i]! + gy * f;
        }
      }
    });

    for (const i of this.#seq) {
      const c = of[i]!;
      // A remembered note far outside its cluster did not stray: its cluster
      // changed under it, because a link elsewhere tipped its strongest tie. It
      // stays where it is remembered rather than crossing the brain to join.
      const d = Math.hypot(this.#cx[c]! - x[i]!, this.#cy[c]! - y[i]!);
      const letGo = this.#remembered[i] === 1 && d > this.radius[c]! * LET_GO;
      this.#pull(i, letGo ? x[i]! : this.#cx[c]!, letGo ? y[i]! : this.#cy[c]!, this.radius[c]!, ax, ay, i);
    }
  }

  /**
   * Cohesion towards a cluster's middle and containment in the node's
   * hemisphere, added to `ax[at]`, `ay[at]` for node `i`.
   */
  #pull(i: number, mx: number, my: number, radius: number, ax: Float64Array, ay: Float64Array, at: number): void {
    const { x, y } = this;
    const u = this.unitLength;
    let fx = 0;
    let fy = 0;
    const dx = mx - x[i]!;
    const dy = my - y[i]!;
    const d = Math.hypot(dx, dy);
    const free = radius * COHESION_FREE;
    if (d > free) {
      const f = ((d - free) * COHESION) / d;
      fx += dx * f;
      fy += dy * f;
    }

    // Containment, measured in normalised units against the node's hemisphere.
    const side = this.#nodeSide[i] as Side;
    const h = centre(side);
    const px = x[i]! / u - h.x;
    const py = y[i]! / u - h.y;
    const dist = Math.hypot(px, py);
    const edge = rim(side, Math.atan2(py, px * side));
    if (dist > edge) {
      const f = ((dist - edge) * u * CONTAINMENT) / (dist || 1);
      fx -= px * f;
      fy -= py * f;
    } else if (dist < edge * HOLLOW) {
      const f = ((edge * HOLLOW - dist) * u * HOLLOW_PUSH) / (dist || 1);
      fx += px * f;
      fy += py * f;
    }
    ax[at] = ax[at]! + fx;
    ay[at] = ay[at]! + fy;
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

/**
 * Where each cluster's folder lies: a hemisphere and an arc along its rim.
 *
 * The unit is the second-level folder — `10_Projects/11_Active`,
 * `20_Areas/21_Homelab` — with notes directly in a top-level folder counting as
 * one more, unnamed subfolder; each vault's folders come as a block. A cluster
 * belongs to the folder most of its members are in.
 *
 * Hemispheres first: the folders by how many clustered notes they hold, the
 * largest first into the lighter hemisphere. That keeps the halves even — a
 * PARA vault's folders differ in size by a factor of forty — and it moves a
 * folder to the other side only when a capture tips two loads that were equal.
 *
 * Arcs second: within its hemisphere each folder, in order, gets one share of
 * the rim plus one for every doubling of its notes — 1 note one share, 2–3 two,
 * 4–7 three, … 32–63 six. Not in proportion to the notes, on purpose: then every
 * capture would shift every folder's arc. As it is, a capture shifts other arcs
 * only when it is the note that doubles a folder or opens a new one.
 */
function folderArcs(
  nodes: BrainGraph['nodes'],
  clusters: BrainGraph['clusters']['clusters'],
): { arcOf: Int32Array; side: Int8Array; start: Float64Array; size: Float64Array } {
  const folderOf = nodes.map((node) => {
    const parts = node.folder === '' ? [] : node.folder.split('/');
    return `${node.owner}\u0000${parts[0] ?? ''}\u0000${parts[1] ?? ''}`;
  });
  const folders = [...new Set(folderOf)].sort();
  const index = new Map(folders.map((f, i) => [f, i]));
  const of = Int32Array.from(folderOf, (f) => index.get(f)!);

  const arcOf = Int32Array.from(clusters, (cluster) => {
    const counts = new Map<number, number>();
    for (const i of cluster.members) counts.set(of[i]!, (counts.get(of[i]!) ?? 0) + 1);
    let arc = -1;
    for (const [a, n] of counts) {
      if (arc === -1 || n > counts.get(arc)! || (n === counts.get(arc)! && a < arc)) arc = a;
    }
    return arc;
  });
  const notes = new Float64Array(folders.length);
  for (const f of of) notes[f] = notes[f]! + 1;
  // One share, plus one for every doubling of the notes in it: 1 note one
  // share, 2–3 two, 4–7 three, … 32–63 six. Every folder, whether or not a
  // cluster calls it home, so that a cluster moving in or out does not open or
  // close an arc.
  const weight = Array.from(notes, (n) => 1 + Math.floor(Math.log2(n)));
  const side = new Int8Array(folders.length);
  const halves = { [-1]: 0, [1]: 0 } as Record<Side, number>;
  [...folders.keys()]
    .filter((f) => weight[f]! > 0)
    .sort((a, b) => weight[b]! - weight[a]! || a - b)
    .forEach((f) => {
      const to: Side = halves[-1] <= halves[1] ? -1 : 1;
      side[f] = to;
      halves[to] += weight[f]!;
    });

  const total = { [-1]: 0, [1]: 0 } as Record<Side, number>;
  folders.forEach((_, f) => {
    if (weight[f]! > 0) total[side[f] as Side] += weight[f]!;
  });
  const start = new Float64Array(folders.length);
  const size = new Float64Array(folders.length);
  const at = { [-1]: 0, [1]: 0 } as Record<Side, number>;
  folders.forEach((_, f) => {
    if (weight[f] === 0) return;
    const s = side[f] as Side;
    start[f] = at[s] / total[s];
    size[f] = weight[f]! / total[s];
    at[s] += weight[f]!;
  });
  return { arcOf, side, start, size };
}

/**
 * Repulsion on every node that may move, from every node closer than the cutoff.
 *
 * The one O(n²) loop, and deliberately a function of flat arrays and nothing
 * else: Barnes-Hut replaces exactly this, and a worker can run it on arrays it
 * owns. Pairs of which neither note may move are skipped — nothing would come
 * of them — so a remembered brain that only has to place a captured note costs
 * a single row instead of the full triangle. `cluster` makes notes of different
 * clusters push harder; null for the loose arrangement, which has none.
 */
function repel(
  x: Float64Array,
  y: Float64Array,
  ax: Float64Array,
  ay: Float64Array,
  moving: Int32Array,
  still: Int32Array,
  cluster: Int32Array | null,
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
      if (d > CUTOFF) continue;
      let f = REPULSION / (d * d);
      if (cluster !== null && cluster[i] !== cluster[j]) f *= APART;
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
      if (d > CUTOFF) continue;
      let f = REPULSION / (d * d);
      if (cluster !== null && cluster[i] !== cluster[j]) f *= APART;
      fxi -= (dx / d) * f;
      fyi -= (dy / d) * f;
    }
    ax[i] = fxi;
    ay[i] = fyi;
  }
}
