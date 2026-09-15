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
 * hemisphere, a place in it, and a size that grows with its members. Its notes
 * start there and arrange themselves with the same local forces as ever —
 * repulsion, a spring along every link. Three gentle forces add the brain:
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
 * regions, packed into two hemispheres and pushing each other apart, reach it —
 * and the gaps between regions are the brain's furrows.
 *
 * **Where a region is, and why that survives a change to the vault.** A
 * cluster's place is the average of its members' *anchors*: points on a loop
 * through both hemispheres, assigned in path order, so that folders keep
 * neighbouring places and a mixed cluster sits between the folders it draws
 * from. That only decides a region that nobody has seen yet. Once the notes
 * have been laid out and remembered, a cluster's place is simply where most of
 * its members already are. Clusters can change when links change — a note
 * torn between two ties may switch (`clusters.ts`) — but a region's place is
 * never a number the clustering hands out: renumbering moves nothing, and a
 * merged or split cluster finds its members where they already were.
 *
 * **It comes to rest.** Forces are scaled by a temperature that starts high
 * for a fresh layout, low for a remembered one, and decays towards zero; below
 * a floor the simulation stops and `step` does nothing. Dragging a note warms
 * it briefly. A brain that keeps drifting cannot be learned.
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
import { FISSURE, OUTLINE, angleOf, centre, pointAt, rim } from './shape';

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
/** Share of a hemisphere's area the regions claim; the rest is furrows. */
const REGION_FILL = 0.85;

/**
 * How deep in its hemisphere a note's anchor sits, as a share of the rim.
 *
 * Near the rim rather than in the middle. The notes of a brain live in its
 * cortex, and on screen the cortex is what draws the outline: regions along
 * the rim trace the silhouette with their own cell bodies, while the tracts
 * between them run through the middle.
 */
const ANCHOR_DEPTH = 0.8;
/** Rounds of pushing new regions apart, and how strongly each round pulls them home. */
const SPREAD_ROUNDS = 200;
const SPREAD_RETURN = 0.01;
/** The gap left between neighbouring regions: the brain's furrows, in world units. */
const FURROW = 14;
/**
 * How far a region's disc may overhang its hemisphere's rim, as a share of its
 * radius. Some: the outermost notes of a rim region are what press against the
 * outline and give it its shape.
 */
const DISC_OVERHANG = 0.7;

/**
 * Repulsion between two notes at distance d is REPULSION / d².
 *
 * Stronger than the loose arrangement strictly needs: in the brain it is also
 * what spreads a region over its share of the hemisphere instead of letting it
 * huddle in the middle of it.
 */
const REPULSION = 2200;
/** Beyond this the repulsion is a few hundredths of a unit and invisible. */
const CUTOFF = 230;
/** Notes of different clusters push harder: it is what opens the furrows. */
const APART = 2.5;

const SPRING = 0.012;
const REST = 70;
/**
 * A link between clusters pulls less than one inside a cluster, and one across
 * the fissure less again. It is still drawn at full strength; but at full pull
 * a single reference from one region into another would drag both out of
 * shape, and a handful across the middle would close the fissure.
 */
const ACROSS_CLUSTERS = 0.15;
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
 * Inside this share of the rim, a gentle push outwards.
 *
 * Without it the middle of each hemisphere is where every cross-link pulls a
 * note to, and the brain fills from the centre into a disc. With it the middle
 * is left to the large clusters that genuinely belong between many others, and
 * the rest keeps to the cortex.
 */
const HOLLOW = 0.6;
const HOLLOW_PUSH = 0.06;
/** The loose arrangement's gentle pull towards the middle. */
const GRAVITY = 0.004;

/** Velocity kept per step. Lower is calmer; this is still lively enough to see settle. */
const INERTIA = 0.72;
/** How fast the temperature falls towards its target, per step. */
const COOLING = 0.016;
/** Below this the layout counts as settled and stops. */
const FROZEN = 0.004;
/** A remembered arrangement starts cool: it only has to absorb what changed. */
const WARM = 0.2;
/** Dragging a note keeps the rest this warm, so neighbours make room and follow. */
const HELD = 0.12;
/** New notes start this far from the neighbours they link to. */
const NUDGE = 18;

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

  /** Per cluster: place (world), region radius, hemisphere. */
  readonly placeX: Float64Array;
  readonly placeY: Float64Array;
  readonly radius: Float64Array;
  readonly side: Int8Array;

  /** The node being dragged, or -1. It is held still while the rest settles. */
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
   * All of them in a fresh layout. In one that starts from memory, only what
   * changed: a note that is new, a note whose links are not the ones it had
   * when its position was remembered, and the direct neighbours of either,
   * which have to make room. Everything else stays exactly where it was — it
   * still pushes and pulls on the notes that move, but is not moved itself.
   *
   * This is the answer to briefing point 47 that does not depend on luck. A
   * warm restart of the whole brain drifts every note by a few units even when
   * nothing changed at all, because a simulation stopped by cooling is never
   * exactly at rest; and a note whose cluster changed would be hauled across to
   * its new cluster. Neither is a reason to move a note that nothing happened to.
   * Picking a note up (`hold`) frees everything: that is somebody deliberately
   * rearranging.
   */
  readonly mobile: Uint8Array;
  /** Which nodes started from a remembered position. */
  readonly #remembered: Uint8Array;
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
    this.placeX = new Float64Array(k);
    this.placeY = new Float64Array(k);
    this.radius = new Float64Array(k);
    this.side = new Int8Array(k);
    this.#cx = new Float64Array(k);
    this.#cy = new Float64Array(k);
    this.#nodeSide = new Int8Array(n);
    this.#ax = new Float64Array(n);
    this.#ay = new Float64Array(n);

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
      this.x[i] = at.x;
      this.y[i] = at.y;
      remembered[i] = 1;
      if (at.links !== this.#links[i]) changed[i] = 1;
      count += 1;
    }
    this.rememberedShare = n === 0 ? 1 : count / n;

    this.mobile = new Uint8Array(n);
    if (this.rememberedShare < 0.5) {
      this.mobile.fill(1);
    } else {
      for (let i = 0; i < n; i += 1) {
        if (changed[i] !== 1) continue;
        this.mobile[i] = 1;
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

    this.alpha = this.rememberedShare >= 0.5 ? WARM : 1;
    // Nothing that may move, nothing to simulate: a refetch that changed no link.
    if (!this.mobile.includes(1)) this.settled = true;
  }

  /**
   * Decides every cluster's hemisphere, place and size.
   *
   * A cluster most of whose members are remembered keeps the place they are
   * at and the hemisphere most of them are in. Only a cluster that is mostly
   * new is placed from its anchors. See the header for why.
   */
  #placeRegions(remembered: Uint8Array): void {
    const { nodes } = this.graph;
    const { clusters } = this.graph.clusters;
    const n = nodes.length;
    const u = this.unitLength;

    // Anchors: every note's point on the loop through both hemispheres, in path
    // order. The loop runs down the left hemisphere from the front, across at
    // the back and up the right one, so the first and last folders meet at the
    // front and every folder's neighbours in the listing are its neighbours in
    // the brain.
    const byPath = nodes.map((_, i) => i).sort((a, b) => (nodes[a]!.key < nodes[b]!.key ? -1 : 1));
    const anchorX = new Float64Array(n);
    const anchorY = new Float64Array(n);
    const anchorSide = new Int8Array(n);
    byPath.forEach((i, rank) => {
      const f = (rank + 0.5) / n;
      const side: Side = f < 0.5 ? -1 : 1;
      const g = side === -1 ? f * 2 : f * 2 - 1;
      const phi = side === -1 ? -Math.PI / 2 + Math.PI * g : Math.PI / 2 - Math.PI * g;
      const p = pointAt(side, phi, ANCHOR_DEPTH);
      anchorX[i] = p.x;
      anchorY[i] = p.y;
      anchorSide[i] = side;
    });

    const fixed = new Uint8Array(clusters.length);
    const wantX = new Float64Array(clusters.length);
    const wantY = new Float64Array(clusters.length);
    clusters.forEach((cluster, c) => {
      const members = cluster.members;
      this.radius[c] = Math.sqrt((members.length * AREA_PER_NOTE * REGION_FILL) / Math.PI);

      let known = 0;
      let kx = 0;
      let ky = 0;
      let left = 0;
      let ax = 0;
      let ay = 0;
      let anchorLeft = 0;
      for (const i of members) {
        ax += anchorX[i]!;
        ay += anchorY[i]!;
        if (anchorSide[i] === -1) anchorLeft += 1;
        if (remembered[i] !== 1) continue;
        known += 1;
        kx += this.x[i]!;
        ky += this.y[i]!;
        if (this.x[i]! < 0) left += 1;
      }

      let side: Side;
      if (known * 2 >= members.length && known > 0) {
        side = left * 2 > known ? -1 : left * 2 < known ? 1 : kx < 0 ? -1 : 1;
        this.placeX[c] = kx / known;
        this.placeY[c] = ky / known;
        fixed[c] = 1;
      } else {
        // The majority of anchors decides; a dead heat goes to the side of the
        // cluster's identity member, which is as stable as the cluster itself.
        const first = members[0]!;
        side = anchorLeft * 2 > members.length ? -1 : anchorLeft * 2 < members.length ? 1 : (anchorSide[first] as Side);
        let px = ax / members.length;
        let py = ay / members.length;
        // A cluster drawing on both hemispheres averages to somewhere near the
        // fissure or across it. Bring its place back into its own half.
        if (px * side < FISSURE) {
          const p = pointAt(side, angleOf(side, px, py), ANCHOR_DEPTH / 2);
          px = p.x;
          py = p.y;
        }
        this.placeX[c] = px * u;
        this.placeY[c] = py * u;
      }
      wantX[c] = this.placeX[c]!;
      wantY[c] = this.placeY[c]!;
      this.side[c] = side;
      // A remembered note keeps the hemisphere it is in, even when its cluster
      // is on the other side now: the fissure is not something a note should be
      // pushed across because a link somewhere else changed its cluster.
      for (const i of members) this.#nodeSide[i] = remembered[i] === 1 ? (this.x[i]! < 0 ? -1 : 1) : side;
    });

    this.#spreadRegions(fixed, wantX, wantY);
  }

  /**
   * Moves new regions apart until they share their hemisphere instead of
   * piling onto the same anchors.
   *
   * Anchors put regions where their folders are, but two clusters from one
   * folder get nearly the same anchor, and a ring of anchors leaves the middle
   * of each hemisphere empty. So the regions, as discs, push each other apart,
   * are held inside their hemisphere, and are pulled back towards their anchor
   * — a small relaxation over a few dozen discs, run once, before any note
   * moves. Remembered regions take part as obstacles but do not move: they are
   * where their notes are.
   *
   * Every sum runs over the clusters in their stable order and is applied all
   * at once per round, so the outcome does not depend on the order either.
   */
  #spreadRegions(fixed: Uint8Array, wantX: Float64Array, wantY: Float64Array): void {
    const k = this.radius.length;
    const u = this.unitLength;
    const px = this.placeX;
    const py = this.placeY;
    const dx = new Float64Array(k);
    const dy = new Float64Array(k);
    for (let round = 0; round < SPREAD_ROUNDS; round += 1) {
      dx.fill(0);
      dy.fill(0);
      for (let a = 0; a < k; a += 1) {
        for (let b = a + 1; b < k; b += 1) {
          if (this.side[a] !== this.side[b]) continue;
          const ex = px[b]! - px[a]!;
          const ey = py[b]! - py[a]!;
          const d = Math.hypot(ex, ey) || 0.01;
          const overlap = this.radius[a]! + this.radius[b]! + FURROW - d;
          if (overlap <= 0) continue;
          // The smaller region gives way more: a large one is harder to move.
          const wa = this.radius[b]! ** 2 / (this.radius[a]! ** 2 + this.radius[b]! ** 2);
          const push = (overlap * 0.5) / d;
          dx[a] = dx[a]! - ex * push * wa * 2;
          dy[a] = dy[a]! - ey * push * wa * 2;
          dx[b] = dx[b]! + ex * push * (1 - wa) * 2;
          dy[b] = dy[b]! + ey * push * (1 - wa) * 2;
        }
      }
      for (let c = 0; c < k; c += 1) {
        if (fixed[c] === 1) continue;
        let x = px[c]! + dx[c]! * 0.5 + (wantX[c]! - px[c]!) * SPREAD_RETURN;
        let y = py[c]! + dy[c]! * 0.5 + (wantY[c]! - py[c]!) * SPREAD_RETURN;
        // Inside the hemisphere, with the disc's own radius as a margin — but
        // never deeper than its middle, however large the region.
        const side = this.side[c] as Side;
        const h = centre(side);
        const nx = x / u;
        const ny = y / u;
        const phi = angleOf(side, nx, ny);
        const edge = rim(side, phi);
        const room = Math.max(edge * 0.15, edge - (this.radius[c]! * (1 - DISC_OVERHANG)) / u);
        const dist = Math.hypot(nx - h.x, ny - h.y);
        if (dist > room || nx * side < FISSURE) {
          const p = pointAt(side, phi, Math.min(dist, room) / edge);
          x = p.x * u;
          y = p.y * u;
        }
        px[c] = x;
        py[c] = y;
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

  /** A node is picked up: hold it, and warm the rest so they make room. */
  hold(i: number): void {
    this.pinned = i;
    this.mobile.fill(1);
    this.alphaTarget = HELD;
    this.alpha = Math.max(this.alpha, HELD);
    this.settled = false;
  }

  /** The node is let go; everything cools down again. */
  release(): void {
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

    repel(x, y, ax, ay, this.#seq, this.arrangement === 'brain' ? this.graph.clusters.of : null);
    this.#springs(ax, ay);
    if (this.arrangement === 'brain') this.#shape(ax, ay);
    else this.#gather(ax, ay);

    for (const i of this.#seq) {
      if (i === this.pinned || this.mobile[i] !== 1) {
        vx[i] = 0;
        vy[i] = 0;
        continue;
      }
      const nx = (vx[i]! + ax[i]! * alpha) * INERTIA;
      const ny = (vy[i]! + ay[i]! * alpha) * INERTIA;
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
    const u = this.unitLength;

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
      // Cohesion.
      const dx = this.#cx[c]! - x[i]!;
      const dy = this.#cy[c]! - y[i]!;
      const d = Math.hypot(dx, dy);
      const free = this.radius[c]! * COHESION_FREE;
      // A remembered note far outside its cluster did not stray: its cluster
      // changed under it, because a link elsewhere tipped its strongest tie. It
      // stays where it is remembered rather than crossing the brain to join.
      const letGo = this.#remembered[i] === 1 && d > this.radius[c]! * LET_GO;
      if (d > free && !letGo) {
        const f = ((d - free) * COHESION) / d;
        ax[i] = ax[i]! + dx * f;
        ay[i] = ay[i]! + dy * f;
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
        ax[i] = ax[i]! - px * f;
        ay[i] = ay[i]! - py * f;
      } else if (dist < edge * HOLLOW) {
        const f = ((edge * HOLLOW - dist) * u * HOLLOW_PUSH) / (dist || 1);
        ax[i] = ax[i]! + px * f;
        ay[i] = ay[i]! + py * f;
      }
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
 * Repulsion between every pair closer than the cutoff, in `seq` order.
 *
 * The one O(n²) loop, and deliberately a function of flat arrays and nothing
 * else: Barnes-Hut replaces exactly this, and a worker can run it on arrays it
 * owns. `cluster` makes notes of different clusters push harder; null for the
 * loose arrangement, which has no clusters to separate.
 */
function repel(
  x: Float64Array,
  y: Float64Array,
  ax: Float64Array,
  ay: Float64Array,
  seq: Int32Array,
  cluster: Int32Array | null,
): void {
  const n = seq.length;
  for (let p = 0; p < n; p += 1) {
    const i = seq[p]!;
    const xi = x[i]!;
    const yi = y[i]!;
    let fxi = ax[i]!;
    let fyi = ay[i]!;
    for (let q = p + 1; q < n; q += 1) {
      const j = seq[q]!;
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
    ax[i] = fxi;
    ay[i] = fyi;
  }
}
