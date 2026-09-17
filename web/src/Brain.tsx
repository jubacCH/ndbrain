/**
 * The vault as a neural network.
 *
 * Every note a cell body, every resolved link a tract, every access a pulse
 * running along it. The only view on a dark ground — not on a whim, but because
 * glow presupposes darkness: on a light ground there is no glow, only pale
 * patches.
 *
 * Two rules everything here has to answer to:
 *
 *  - **Every shape comes from the data.** An early draft gave each cell body
 *    decorative tendrils; they looked like connections and were not. What grows
 *    out of a neuron here is a link that actually exists.
 *  - **The arrangement emerges, it is not drawn.** An earlier version of this
 *    rule said the lobes came from the folders "and not from a brain
 *    silhouette". The redesign briefing reverses the second half on purpose
 *    (points 9, 12, 52): the full network *is* shaped like a brain — two
 *    hemispheres and a fissure — but the shape must still come out of the
 *    nodes, never from a background image, a mask or dots scattered inside an
 *    outline. So clusters get regions and a soft force keeps the regions within
 *    two hemispheres (`brain/layout.ts`, `brain/shape.ts`); what is drawn is only
 *    ever the notes and their links. The shape is the large scale only: zoomed
 *    in, it dissolves into ordinary clusters, and the small neighbourhood panel
 *    is never pressed into it.
 *
 * This file used to be all of it — model, physics, painting and pointer
 * handling in one `useEffect`. Those now live in `./brain`, in the order the
 * data flows: `model` (what is connected to what) → `layout` (where it is) →
 * `scene` (what colour and how big) → `renderer` (paint it). What is left here
 * is the part that genuinely needs React and a DOM: owning the canvas, driving
 * the frame, and turning pointer events into camera or layout changes.
 *
 * The split is not tidiness. Each of those layers has a different reason to
 * change — a new force, a new colour rule, WebGL — and while they shared one
 * closure, every one of those changes was a change to all of them.
 */

import { useEffect, useRef, useState } from 'react';

import type { GraphData, PulseEvent } from './api';
import { copy } from './copy';
import { Activity } from './brain/activity';
import type { Camera, Inset } from './brain/camera';
import { between, ease, fit, limitsFor, panBy, toWorld, zoomAt } from './brain/camera';
import { blockedAround } from './brain/blocked';
import { focusCamera } from './brain/focus';
import { HitIndex } from './brain/hit';
import { noteKind } from './brain/kind';
import type { Arrangement } from './brain/layout';
import { BrainLayout } from './brain/layout';
import type { BrainGraph } from './brain/model';
import { buildGraph, nodeKey } from './brain/model';
import type { PositionStore } from './brain/positions';
import { loadPositions, savePositions } from './brain/positions';
import type { RegionView } from './brain/regions';
import { regionView } from './brain/regions';
import { createCanvasRenderer } from './brain/renderer';
import { RECENT_DAYS, SceneBuilder } from './brain/scene';

export interface BrainProps {
  data: GraphData;
  /** Events that have arrived since the last call. */
  events: PulseEvent[];
  onOpen: (owner: string, path: string) => void;
  /**
   * Where to remember the settled arrangement: whose account, which view.
   *
   * Only the full network passes one. The neighbourhood panel is a different
   * subgraph for every note opened, so remembering it would mean storing one
   * arrangement per note to answer a question the path hash already answers:
   * it opens the same way every time regardless.
   */
  remember?: PositionStore;
  /**
   * The brain shape, or a loose cluster.
   *
   * Required for the same reason as `view`: the full network and the
   * neighbourhood panel want different things, and a third use should have to
   * say which it is rather than inherit one.
   */
  arrangement: Arrangement;
  /**
   * Screen space the resting view keeps clear, for controls laid over the
   * canvas. The component cannot see them; the caller placed them.
   */
  inset?: Inset;
  /**
   * What this canvas is showing, as an identity: the whole network, or the
   * neighbourhood of one particular note.
   *
   * A new graph arrives for two reasons that want opposite things. A refetch of
   * the same view — an edit somewhere, an agent's write — keeps the camera, the
   * selection and the live positions, because the picture is the same picture.
   * Switching the panel to another note is a different picture, and it starts
   * from the overview. The data alone cannot say which happened: two
   * neighbouring notes share most of their neighbourhood. The caller knows, so
   * the caller says — and it is required, so that a third use of this component
   * cannot quietly inherit the wrong answer.
   */
  view: string;
  /**
   * Focus mode: the caller follows the selection and may set it.
   *
   * With it, a click on a note selects it *and* glides the camera so that the
   * note and its direct neighbours are in view, clear of whatever the caller
   * has laid over the canvas to reserve room (`data-brain-reserve`, see
   * `reserved`). Escape or a click on the dark ends the focus and leaves the
   * camera where it is: jumping back would take away the place somebody was
   * just looking at. The reset control still goes home.
   *
   * Without it the selection is the canvas's own business and the camera never
   * moves by itself — the neighbourhood panel beside an open note, which is too
   * small for a camera flight to help anybody.
   */
  focus?: {
    /** The selected note's key (`nodeKey`), or null. */
    picked: string | null;
    onPick: (key: string | null) => void;
  };
}

/** Space between a reserving element and the framed notes, in screen pixels. */
const RESERVE_GAP = 16;
/**
 * Room for the names beside the rightmost focused notes, in screen pixels, at
 * most this share of the canvas: a name is up to 26 characters, and on a phone
 * a quarter of the width is all that can be spared for it.
 */
const LABEL_ROOM = 150;
const LABEL_SHARE = 0.25;

/**
 * Room the focused view keeps clear for elements over the canvas that reserve
 * it, added to the caller's inset.
 *
 * The inspector reserves room: a strip on the right in a wide view, a band
 * along the bottom in a narrow one. Which of the two is the stylesheet's
 * decision, so it is read off the element's box rather than passed in. An
 * element spanning most of the width is a band and reserves everything below
 * its top; a narrower one that starts in the right half is a strip and
 * reserves everything right of its left edge.
 */
function reserved(canvas: HTMLElement, base: Inset): Inset {
  const host = canvas.parentElement;
  if (host === null) return base;
  const frame = canvas.getBoundingClientRect();
  let { right, bottom } = base;
  for (const el of Array.from(host.children)) {
    if (el === canvas || !(el instanceof HTMLElement) || !el.hasAttribute('data-brain-reserve')) continue;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0) || !(r.height > 0)) continue;
    const x = r.left - frame.left;
    const y = r.top - frame.top;
    if (r.width >= frame.width * 0.6) bottom = Math.max(bottom, frame.height - y + RESERVE_GAP);
    else if (x > frame.width / 2) right = Math.max(right, frame.width - x + RESERVE_GAP);
  }
  return { top: base.top, right, bottom, left: base.left };
}

/** A camera move takes this long. Long enough to follow, short enough not to wait. */
const GLIDE_MS = 320;

/**
 * How often the settled arrangement is written back, in milliseconds.
 *
 * Not every frame, and not only on unmount: a tab that is closed by the
 * operating system never unmounts anything. Five seconds is far below how long
 * somebody watches this view and far above the cost of serialising it. When the
 * simulation moves to a worker this belongs there, where the main thread cannot
 * feel it.
 */
const SAVE_MS = 5000;

/**
 * How far, in screen pixels, a press on a note has to travel before it counts as
 * a drag. Below it, it is a click: a hand never holds a mouse perfectly still,
 * and a click that nudged the layout would, over a day of clicking, move it.
 */
const DRAG_SLOP = 4;

/** How long after a click a second press still belongs to it, as a double click. */
const DOUBLE_MS = 500;

/** Breathing room around the fitted world when the caller asks for none. */
const EDGE: Inset = { top: 12, right: 12, bottom: 12, left: 12 };

/** How far the pointer has to travel before the card under it is moved again. */
const CARD_STEP = 14;
/** Roughly how much room the card needs. Enough to decide which way it opens. */
const CARD_W = 320;
const CARD_H = 230;
/** A day, in milliseconds. */
const DAY = 86_400_000;

/**
 * What the card under the pointer says about one note.
 *
 * Built in the pointer handler and held in React state, because it is DOM: a
 * canvas cannot lay out a table, wrap a folder path or let the text be selected
 * by a screen reader, and this is the one place in the view where those matter.
 */
interface Card {
  node: number;
  /** Where the card sits, in pixels inside the canvas's own box. */
  x: number;
  y: number;
  /** Whether it has to open to the left of the pointer, or upwards. */
  flipX: boolean;
  flipY: boolean;
  title: string;
  kind: string;
  links: number;
  folder: string;
  region: string;
  topics: string[];
  /** Null until the graph endpoint carries a timestamp. */
  edited: string | null;
}

/** "today", "yesterday", "12 days ago". */
function edited(at: number, now: number): string {
  const days = Math.max(0, Math.floor((now - at) / DAY));
  if (days === 0) return copy.network.card.today;
  if (days === 1) return copy.network.card.yesterday;
  return copy.network.card.daysAgo(days);
}

/**
 * How warm each note is drawn: 1 the day it was written, 0 a fortnight later.
 *
 * The target picture scatters warm points through the cyan, and what they mean
 * is "this is what is being worked on". A hard fortnight boundary would make a
 * note change colour overnight for no reason anybody watching could see, so the
 * accent fades with the age instead — the picture then shows not only *what* is
 * being worked on but roughly *how recently*, and a vault nobody has touched in
 * a month is honestly all cyan.
 *
 * Computed when the graph arrives, not per frame: "now" moving by a few minutes
 * cannot change a colour anybody would notice, and a fortnight is the scale.
 */
function warmth(data: GraphData): Float64Array {
  const heat = new Float64Array(data.nodes.length);
  const now = Date.now();
  const span = RECENT_DAYS * DAY;
  data.nodes.forEach((node, i) => {
    const age = now - node.updatedAt;
    heat[i] = age <= 0 ? 1 : age >= span ? 0 : 1 - age / span;
  });
  return heat;
}

/**
 * Tags by node key, for the clustering.
 *
 * `detectClusters` groups by links, folders *and* tags, and `groupRegions`
 * names a region after the tags its members share when no folder dominates it.
 * Both uses of this component pass them: the full network and the
 * neighbourhood panel alike, since the graph reply carries tags for every node
 * either way. Without them the regions would fall back to folders alone, which
 * still works; only the loose neighbourhood arrangement draws no regions, so
 * there the tags only shape the clusters.
 */
function tagsByKey(data: GraphData): Map<string, readonly string[]> {
  const tags = new Map<string, readonly string[]>();
  for (const node of data.nodes) {
    if (node.tags.length > 0) tags.set(nodeKey(node.owner, node.path), node.tags);
  }
  return tags;
}

interface Engine {
  graph: BrainGraph;
  layout: BrainLayout;
  activity: Activity;
  builder: SceneBuilder;
  camera: Camera;
  /**
   * Whether the camera is at rest in the fitted view.
   *
   * A state, not a comparison. While it holds, the camera follows the fit
   * every frame — so resizing the window, or the panel changing width, only
   * changes the mapping and the whole brain stays in view. Any zoom or pan
   * clears it; arriving back home sets it again.
   */
  homed: boolean;
  /**
   * An animated camera move in progress, or null: home, or onto the picked
   * note and its neighbours. The target is worked out again every frame, so a
   * panel appearing or the window changing mid-move is followed.
   */
  glide: { from: Camera; at: number; to: 'home' | 'focus' } | null;
  /** The node whose name is shown because it was clicked, or -1. */
  picked: number;
  /** The node being dragged, or -1. */
  drag: number;
  /** A press on a node that has not yet moved far enough to be a drag. */
  press: { node: number; x: number; y: number } | null;
  /**
   * Whether the positions changed since they were last stored. A brain that
   * has come to rest is not written back every few seconds for nothing.
   */
  dirty: boolean;
  /**
   * Where the pointer was when panning, in screen pixels, and where the press
   * began — a press on the dark that never travels is a click, not a pan.
   */
  pan: { x: number; y: number; fromX: number; fromY: number } | null;
  /** Which node is under a point. Rebuilt on demand, not per frame. */
  hits: HitIndex;
  /** The regions and the outline, read off the layout once (see `brain/regions.ts`). */
  regions: RegionView;
  /**
   * Where the pointer is, as a deflection from the middle of the canvas, and
   * which note it is over. The parallax and the hover ring read it; neither is
   * worth a React render.
   */
  pointer: { x: number; y: number; over: number };
  width: number;
  height: number;
  savedAt: number;
  /** Where positions are remembered, or null when this instance does not. */
  store: PositionStore | null;
  /** The `view` this engine was built for. */
  view: string;
}

export function Brain({ data, events, onOpen, remember, view, arrangement, inset, focus }: BrainProps): React.JSX.Element {
  const host = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Engine | null>(null);
  /** Set by the frame effect, called by the reset control. */
  const home = useRef<() => void>(() => {});
  /** Set by the frame effect: selects a node and, in focus mode, glides to it. */
  const focusOn = useRef<(node: number) => void>(() => {});
  /**
   * The focus-mode props, in a ref for the same reason as `onOpen`: the frame
   * effect runs once, and the caller's `onPick` is an inline function.
   */
  const follow = useRef(focus);
  useEffect(() => {
    follow.current = focus;
  });
  /**
   * Held in a ref rather than a dependency.
   *
   * Both call sites pass an inline arrow, so `onOpen` is a new function on every
   * render of the shell. As a dependency it tore down and restarted the
   * animation loop and every listener each time — which was merely wasteful
   * before, and would now throw away the camera position mid-gesture.
   */
  const open = useRef(onOpen);
  useEffect(() => {
    open.current = onOpen;
  });
  /**
   * The server's rows, for the card under the pointer.
   *
   * The model keeps only what the picture needs; the card also wants whatever
   * else the reply happened to carry — topics today, a timestamp once the graph
   * endpoint sends one. A ref, for the same reason as `onOpen`: the frame effect
   * runs once and must not be torn down because a refetch returned a new array.
   */
  const rows = useRef(data.nodes);
  useEffect(() => {
    rows.current = data.nodes;
  });

  /** Drives the reset control, which stays hidden until there is somewhere to return from. */
  const [adrift, setAdrift] = useState(false);
  /** The card under the pointer, or null. */
  const [card, setCard] = useState<Card | null>(null);
  /** True once the tissue exists, so the legend only names what is on screen. */
  const [tissue, setTissue] = useState(false);
  /**
   * Asks for a frame.
   *
   * The loop stops when there is nothing left to compute — the layout is at
   * rest, no pulse is running, the camera is still. Everything that can change
   * any of that calls this. Set by the frame effect; a no-op before it runs and
   * after it is torn down, which is what keeps a view that has been left from
   * ever scheduling another frame.
   */
  const wake = useRef<() => void>(() => {});
  /** Read by the frame loop; a ref so a new object literal per render restarts nothing. */
  const margin = useRef<Inset>(inset ?? EDGE);
  useEffect(() => {
    margin.current = inset ?? EDGE;
  });

  /**
   * The caller changed the selection: a neighbour picked in the inspector, or
   * the inspector closed. A selection made on the canvas comes back through
   * here too, and is then already what the engine holds.
   */
  const wantedKey = focus?.picked ?? null;
  useEffect(() => {
    const e = engine.current;
    if (e === null || follow.current === undefined) return;
    const node = wantedKey === null ? -1 : (e.graph.index.get(wantedKey) ?? -1);
    if (node === e.picked) return;
    if (node < 0) {
      e.picked = -1;
      wake.current();
      return;
    }
    focusOn.current(node);
  }, [wantedKey]);

  // Rebuilt only when the graph really changes — not on every pulse.
  useEffect(() => {
    const canvas = host.current;
    if (canvas === null) return;

    const rect = canvas.getBoundingClientRect();
    const graph = buildGraph(data, { tags: tagsByKey(data) });
    const store = remember ?? null;
    // The same view refetched, as opposed to a first mount or another note — or
    // the same view of another account after signing in again.
    const same =
      engine.current !== null && engine.current.view === view && engine.current.store?.account === remember?.account
        ? engine.current
        : null;

    // A refetch starts from where the nodes are *now*, not from storage, which
    // can be up to one save interval behind — reading it back would make every
    // edit elsewhere twitch the picture. Storage is for arriving; the running
    // layout is for staying. That holds for the neighbourhood too, which has no
    // storage: without this, each refetch threw it back to its hash start.
    const remembered =
      same !== null ? same.layout.positions() : store === null ? undefined : loadPositions(store);
    const layout = new BrainLayout(graph, { arrangement, remembered });
    // A brain nobody has seen yet is laid out before its first frame. Watching
    // it assemble is a few seconds of motion that says nothing, on a view whose
    // resting state is meant to be calm; a remembered one only has to absorb
    // what changed, and does that on screen, briefly.
    // Under reduced motion the frame loop never steps, so whatever has to move —
    // a note captured since, its neighbours — is settled here or never.
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (layout.rememberedShare < 0.5 || reduce) layout.settle();

    // The camera and the selection survive a refetch of the same view. Yanking
    // the view back to the overview mid-read would punish the user for somebody
    // else's edit. Another view starts at home.
    // In focus mode the caller holds the selection, so that is what survives;
    // a note that has gone from the graph ends the focus.
    const wanted = follow.current?.picked ?? null;
    const picked =
      follow.current !== undefined
        ? wanted === null
          ? -1
          : (graph.index.get(wanted) ?? -1)
        : same === null || same.picked < 0
          ? -1
          : (graph.index.get(same.graph.nodes[same.picked]!.key) ?? -1);
    if (wanted !== null && picked < 0) follow.current?.onPick(null);

    const builder = new SceneBuilder(graph);
    builder.recent(warmth(data));
    // The tissue and the region anchors are grown from positions and regions;
    // a refetch that changed neither keeps them instead of growing them again.
    if (same !== null) builder.inherit(same.builder);

    engine.current = {
      graph,
      layout,
      activity: new Activity(graph),
      builder,
      camera: same?.camera ?? fit(layout.bounds, rect.width, rect.height, margin.current),
      homed: same?.homed ?? true,
      glide: null,
      picked,
      drag: -1,
      press: null,
      // Nothing to write if every note came from storage and none has to move.
      dirty: !(same === null && layout.rememberedShare === 1 && layout.settled),
      pan: null,
      hits: new HitIndex(layout),
      regions: regionView(layout),
      pointer: { x: 0, y: 0, over: -1 },
      width: rect.width,
      height: rect.height,
      savedAt: performance.now(),
      store,
      view,
    };
    setCard(null);
    wake.current();
  // `remember` is an object from the caller; its contents are what matter.
  }, [data, remember?.account, remember?.store, view, arrangement]);

  /** Fire new events — a flash at the place, sparks along its tracts. */
  useEffect(() => {
    if (events.length === 0) return;
    engine.current?.activity.record(events);
    wake.current();
  }, [events]);

  // The frame, the pointer and the camera.
  useEffect(() => {
    const canvas = host.current;
    if (canvas === null) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const paint = createCanvasRenderer(canvas);
    // Narrowed once for the hoisted frame function, which TypeScript does not
    // see the null check above from.
    const surface: HTMLCanvasElement = canvas;
    let frame = 0;

    /**
     * The loop only runs while there is something to compute.
     *
     * A settled brain with no pulse on it and a camera nobody is moving paints
     * the same picture sixty times a second, which on a fanless machine is a
     * warm lap for nothing. So the frame is scheduled rather than standing:
     * `ask` puts one in the queue if none is queued, `loop` asks for the next
     * only while something is still moving, and every input asks for one.
     */
    let stopped = false;
    const ask = (): void => {
      if (frame === 0 && !stopped) frame = requestAnimationFrame(loop);
    };
    wake.current = ask;

    const measure = (): void => {
      const e = engine.current;
      const rect = canvas.getBoundingClientRect();
      paint.resize(rect.width, rect.height);
      if (e !== null) {
        // Only the mapping changes. The layout has no idea how big the window is.
        e.width = rect.width;
        e.height = rect.height;
      }
      ask();
    };
    measure();

    // A ResizeObserver, not only the window's resize event: the neighbourhood
    // panel changes width when the right column appears or the note view is
    // left, and the window never resizes for either.
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());
    observer?.observe(canvas);
    // Still needed alongside it — moving the window to a second display changes
    // the device-pixel ratio without changing the element's size.
    window.addEventListener('resize', measure);

    // The controls laid over the canvas — legend, footer, reset, the note on
    // the decoration — are areas no region name may cover (`brain/blocked.ts`).
    // They are measured every frame, which costs nothing because frames only
    // run when something changed; these observers are what makes something
    // changing *count*: one of them appearing, disappearing or changing size
    // asks for a frame, so the names move out of its way even at rest.
    const overlays = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => ask());
    const watchOverlays = (): void => {
      if (overlays === null || canvas.parentElement === null) return;
      overlays.disconnect();
      for (const el of Array.from(canvas.parentElement.children)) if (el !== canvas) overlays.observe(el);
    };
    const arrivals =
      typeof MutationObserver === 'undefined' || canvas.parentElement === null
        ? null
        : new MutationObserver(() => {
            watchOverlays();
            ask();
          });
    arrivals?.observe(canvas.parentElement!, { childList: true });
    watchOverlays();

    const persist = (e: Engine, now: number, force: boolean): void => {
      if (e.store === null || !e.dirty) return;
      if (!force && now - e.savedAt < SAVE_MS) return;
      e.savedAt = now;
      e.dirty = false;
      savePositions(e.store, e.layout.positions());
    };

    // Mirrors the camera into React state, but only when the answer changes.
    // A `setState` per frame would make the shell re-render sixty times a
    // second to decide the same thing again.
    let shown = false;
    let grown = false;

    // A declaration, not a const: `measure` asks for the first frame before
    // this line is reached, and a const would still be in its dead zone.
    function loop(): void {
      frame = 0;
      const e = engine.current;
      if (e === null) return;
      const now = performance.now();

      const home = fit(e.layout.bounds, e.width, e.height, margin.current);
      if (e.glide !== null) {
        const t = reduce ? 1 : (now - e.glide.at) / GLIDE_MS;
        // Towards where the target is now, not where it was when the glide
        // began: the panel may be changing width at the same moment, and the
        // inspector appears a frame after the click that asked for it.
        const target = e.glide.to === 'home' ? home : focusTarget(e);
        if (t >= 1) {
          if (e.glide.to === 'home') e.homed = true;
          else e.camera = target;
          e.glide = null;
        } else {
          e.camera = between(e.glide.from, target, ease(t));
        }
      }
      if (e.homed) e.camera = home;

      let moving = false;
      if (!reduce) {
        // Nothing to compute once it has come to rest; the frame still draws,
        // because pulses still fire.
        if (e.layout.step()) {
          e.hits.invalidate();
          e.builder.moved();
          e.dirty = true;
          moving = true;
        }
        e.activity.advance();
      }
      persist(e, now, false);

      const scene = e.builder.build(
        e.layout,
        e.activity,
        e.camera,
        e.picked,
        e.width,
        e.height,
        e.pointer,
        blockedAround(surface),
      );
      paint.draw(scene);

      const away = !e.homed;
      if (away !== shown) {
        shown = away;
        setAdrift(away);
      }
      const has = scene.deco.dustCount > 0;
      if (has !== grown) {
        grown = has;
        setTissue(has);
      }

      // What is left to do: the layout still settling, a camera move under way,
      // a note being dragged, or a pulse still on screen. Anything else that
      // changes the picture — the pointer, the wheel, a new event, a resize —
      // asks for a frame of its own.
      const busy =
        moving ||
        e.glide !== null ||
        e.drag >= 0 ||
        (!reduce &&
          (e.activity.sparks.length > 0 ||
            e.activity.fire.some((v) => v > 0) ||
            e.activity.warm.some((v) => v > 0)));
      if (busy) ask();
    }
    ask();

    /**
     * The note the last click landed on, and where and when.
     *
     * A click in focus mode sets the camera moving, so by the second press of
     * a double click the note is no longer under the pointer. A press close to
     * the last click, soon after it, means the same note — which is what
     * somebody double-clicking a point meant.
     */
    let lastClick: { node: number; x: number; y: number; at: number } | null = null;

    /** The node under a screen point, or -1. */
    const locate = (event: { clientX: number; clientY: number }): number => {
      const e = engine.current;
      if (e === null) return -1;
      if (
        lastClick !== null &&
        lastClick.node < e.graph.nodes.length &&
        performance.now() - lastClick.at <= DOUBLE_MS &&
        Math.hypot(event.clientX - lastClick.x, event.clientY - lastClick.y) <= DRAG_SLOP * 2
      ) {
        return lastClick.node;
      }
      const rect = canvas.getBoundingClientRect();
      const at = toWorld(e.camera, event.clientX - rect.left, event.clientY - rect.top);
      return e.hits.at(at.x, at.y, e.camera.scale);
    };

    const goHome = (): void => {
      const e = engine.current;
      if (e === null || (e.homed && e.glide === null) || e.glide?.to === 'home') return;
      e.glide = { from: e.camera, at: performance.now(), to: 'home' };
      ask();
    };
    home.current = goHome;

    /** The picked node and its direct neighbours, framed clear of the reserved room. */
    function focusTarget(e: Engine): Camera {
      if (e.picked < 0) return e.camera;
      const members = [e.picked];
      for (const edge of e.graph.touching[e.picked]!) {
        const link = e.graph.edges[edge]!;
        members.push(link.a === e.picked ? link.b : link.a);
      }
      return focusCamera({
        x: e.layout.x,
        y: e.layout.y,
        r: e.layout.r,
        members,
        bounds: e.layout.bounds,
        width: e.width,
        height: e.height,
        inset: reserved(surface, margin.current),
        labelRoom: Math.min(LABEL_ROOM, e.width * LABEL_SHARE),
      });
    }

    /**
     * Selects a node and, in focus mode, glides to it. Only the camera moves:
     * the layout is not touched, so a focus can never shift a note.
     */
    const select = (node: number): void => {
      const e = engine.current;
      if (e === null || node < 0 || node >= e.graph.nodes.length) return;
      e.picked = node;
      if (follow.current !== undefined) {
        e.homed = false;
        e.glide = { from: e.camera, at: performance.now(), to: 'focus' };
      }
      ask();
    };
    focusOn.current = select;

    /** Tells a caller in focus mode what is selected now, if that changed. */
    const report = (e: Engine): void => {
      const f = follow.current;
      if (f === undefined) return;
      const key = e.picked < 0 ? null : e.graph.nodes[e.picked]!.key;
      if (key !== f.picked) f.onPick(key);
    };

    /**
     * The card under the pointer.
     *
     * Two rules keep it from flickering. It is only rebuilt when the note under
     * the pointer changes, or when the pointer has travelled far enough that the
     * card would visibly lag behind it; and it is moved, never re-created, for
     * the same note. A `setState` per pointer event would re-render the shell
     * some hundred times a second for the same table.
     */
    const hover = (e: Engine, x: number, y: number): void => {
      const at = toWorld(e.camera, x, y);
      const over = e.hits.at(at.x, at.y, e.camera.scale);
      e.pointer.over = over;
      canvas.style.cursor = over >= 0 ? 'pointer' : '';
      if (over < 0) {
        setCard((held) => (held === null ? held : null));
        return;
      }
      const node = e.graph.nodes[over]!;
      const row = rows.current[over];
      const left = x + canvas.offsetLeft;
      const top = y + canvas.offsetTop;
      // Which way it opens, so it never runs off the canvas and takes its own
      // content with it.
      const flipX = x + CARD_W > e.width;
      const flipY = y + CARD_H > e.height;
      setCard((held) => {
        if (held !== null && held.node === over && Math.hypot(held.x - left, held.y - top) < CARD_STEP) return held;
        if (held !== null && held.node === over) return { ...held, x: left, y: top, flipX, flipY };
        const kind = noteKind(node.folder, node.title);
        const region = e.regions.regions[e.regions.regionOf[over] ?? -1];
        return {
          node: over,
          x: left,
          y: top,
          flipX,
          flipY,
          title: node.title,
          kind: kind.kind === 'folder' ? kind.label : copy.network.card.kind[kind.kind],
          links: node.degree,
          folder: node.folder,
          region: region?.name ?? '',
          topics: rows.current[over]?.tags ?? [],
          edited: row === undefined ? null : edited(row.updatedAt, Date.now()),
        };
      });
    };

    /**
     * Wheel and pinch, both anchored on the pointer.
     *
     * A trackpad pinch reaches the page as a wheel event with `ctrlKey` set and
     * a much smaller delta, so the same handler covers it — with its own
     * sensitivity, or a pinch would barely move and a wheel notch would leap.
     */
    const onWheel = (event: WheelEvent): void => {
      const e = engine.current;
      if (e === null) return;
      event.preventDefault();
      // Lines and pages, not only pixels: Firefox reports a mouse wheel in lines.
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? e.height : 1;
      const delta = event.deltaY * unit;
      const rect = canvas.getBoundingClientRect();
      const home = fit(e.layout.bounds, e.width, e.height, margin.current);
      e.glide = null;
      const next = zoomAt(
        e.camera,
        event.clientX - rect.left,
        event.clientY - rect.top,
        Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0022)),
        limitsFor(home),
      );
      if (next !== e.camera) e.homed = false;
      e.camera = next;
      ask();
    };

    /**
     * One gesture, two meanings, decided here and nowhere else.
     *
     * Press on a cell body and you move that note; press on the dark and you
     * move the camera. Deciding it once at `pointerdown` is what keeps it
     * predictable — a drag that changed its mind partway, because the pointer
     * happened to cross a node, would be unusable.
     *
     * A press on a note is only a candidate, though. It becomes a drag — and
     * the layout is only touched — once the pointer has travelled `DRAG_SLOP`
     * pixels. A click, a double click, a press that trembles: none of them
     * moves anything.
     */
    const onDown = (event: PointerEvent): void => {
      const e = engine.current;
      if (e === null) return;
      const hit = locate(event);
      e.glide = null;
      canvas.setPointerCapture(event.pointerId);
      if (hit >= 0) {
        e.press = { node: hit, x: event.clientX, y: event.clientY };
        e.picked = hit;
      } else {
        e.pan = { x: event.clientX, y: event.clientY, fromX: event.clientX, fromY: event.clientY };
      }
      ask();
    };

    const onMove = (event: PointerEvent): void => {
      const e = engine.current;
      if (e === null) return;
      const rect = canvas.getBoundingClientRect();
      // The parallax deflection. Kept on the engine rather than in React state:
      // it moves with every pixel of pointer travel and changes nothing but
      // three drawImage offsets.
      e.pointer.x = e.width > 0 ? ((event.clientX - rect.left) / e.width - 0.5) * 2 : 0;
      e.pointer.y = e.height > 0 ? ((event.clientY - rect.top) / e.height - 0.5) * 2 : 0;

      if (e.press !== null && e.drag < 0) {
        if (Math.hypot(event.clientX - e.press.x, event.clientY - e.press.y) <= DRAG_SLOP) return;
        e.drag = e.press.node;
        e.layout.hold(e.drag);
        setCard(null);
      }
      if (e.drag >= 0) {
        const at = toWorld(e.camera, event.clientX - rect.left, event.clientY - rect.top);
        e.layout.place(e.drag, at.x, at.y);
        e.hits.invalidate();
        e.builder.moved();
        e.dirty = true;
        ask();
        return;
      }
      if (e.pan !== null) {
        if (event.clientX === e.pan.x && event.clientY === e.pan.y) return;
        e.homed = false;
        e.camera = panBy(e.camera, event.clientX - e.pan.x, event.clientY - e.pan.y);
        e.pan = { ...e.pan, x: event.clientX, y: event.clientY };
        ask();
        return;
      }
      hover(e, event.clientX - rect.left, event.clientY - rect.top);
      ask();
    };

    const onUp = (event: PointerEvent): void => {
      const e = engine.current;
      if (e === null) return;
      // A click on the dark lets go of the selected note. Only a click: a pan
      // that happens to start and end on the dark keeps it.
      if (e.pan !== null && Math.hypot(event.clientX - e.pan.fromX, event.clientY - e.pan.fromY) <= DRAG_SLOP) {
        e.picked = -1;
        report(e);
      }
      // A press on a note that never became a drag is a click: it focuses the
      // note. A drag keeps the selection its press made, and the camera.
      if (e.press !== null && e.drag < 0) {
        select(e.press.node);
        lastClick = { node: e.press.node, x: e.press.x, y: e.press.y, at: performance.now() };
      } else {
        lastClick = null;
      }
      if (e.press !== null) report(e);
      if (e.drag >= 0) {
        e.layout.release();
        // The frame loop does not step under reduced motion: the neighbours
        // settle around the dropped note at once instead of never.
        if (reduce) {
          e.layout.settle();
          e.hits.invalidate();
        }
      }
      if (e.drag >= 0) e.builder.moved();
      e.drag = -1;
      e.press = null;
      e.pan = null;
      ask();
    };

    const onDouble = (event: MouseEvent): void => {
      const e = engine.current;
      const hit = locate(event);
      if (e !== null && hit >= 0) open.current(e.graph.nodes[hit]!.owner, e.graph.nodes[hit]!.path);
    };

    const onLeave = (): void => {
      const e = engine.current;
      if (e === null) return;
      e.pointer.over = -1;
      e.pointer.x = 0;
      e.pointer.y = 0;
      setCard(null);
      ask();
    };

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && engine.current !== null) {
        engine.current.picked = -1;
        setCard(null);
        report(engine.current);
        // In focus mode Escape ends the focus and nothing else: the camera
        // stays on what was being looked at. Without it, Escape also goes home.
        if (follow.current === undefined) goHome();
      }
      ask();
      if (event.key === '0') goHome();
    };

    const onLeaving = (): void => {
      const e = engine.current;
      if (e !== null) persist(e, performance.now(), true);
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('dblclick', onDouble);
    canvas.addEventListener('keydown', onKey);
    canvas.addEventListener('pointerleave', onLeave);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('pagehide', onLeaving);

    return () => {
      // No frame may outlive the view. `stopped` closes the door behind the
      // cancel: a listener that fires while React is tearing down would
      // otherwise queue one more.
      stopped = true;
      wake.current = () => {};
      cancelAnimationFrame(frame);
      frame = 0;
      onLeaving();
      observer?.disconnect();
      overlays?.disconnect();
      arrivals?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('pagehide', onLeaving);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('dblclick', onDouble);
      canvas.removeEventListener('keydown', onKey);
      canvas.removeEventListener('pointerleave', onLeave);
      home.current = () => {};
      focusOn.current = () => {};
      paint.dispose();
    };
  }, []);

  return (
    <>
      <canvas className="brain" ref={host} tabIndex={0} aria-label={copy.network.canvas} />
      {adrift && (
        <button
          type="button"
          className="brainhome"
          onClick={() => home.current()}
        >
          {copy.network.resetView}
        </button>
      )}
      {/* The tissue is named as decoration wherever it is on screen. */}
      {tissue && (
        <p className="braindeco">
          <i />
          {copy.network.decoration}
        </p>
      )}
      {card !== null && (
        <div
          className="braincard"
          data-flip-x={card.flipX}
          data-flip-y={card.flipY}
          style={{ left: card.x, top: card.y }}
          role="presentation"
        >
          <p className="braincard-title">{card.title}</p>
          <dl>
            <dt>{copy.network.card.type}</dt>
            <dd>{card.kind}</dd>
            <dt>{copy.network.card.linksLabel}</dt>
            <dd>{copy.network.card.links(card.links)}</dd>
            {card.folder !== '' && (
              <>
                <dt>{copy.network.card.folder}</dt>
                <dd className="braincard-path">{card.folder}</dd>
              </>
            )}
            {card.region !== '' && (
              <>
                <dt>{copy.network.card.region}</dt>
                <dd>{card.region}</dd>
              </>
            )}
            {/* Appears the day the graph endpoint carries a timestamp. */}
            {card.edited !== null && (
              <>
                <dt>{copy.network.card.edited}</dt>
                <dd>{card.edited}</dd>
              </>
            )}
            <dt>{copy.network.card.topics}</dt>
            <dd>
              {card.topics.length === 0 ? (
                <span className="braincard-none">{copy.network.card.noTopics}</span>
              ) : (
                card.topics.map((t) => (
                  <span className="braincard-tag" key={t}>
                    #{t}
                  </span>
                ))
              )}
            </dd>
          </dl>
          <p className="braincard-open">{copy.network.card.open}</p>
        </div>
      )}
    </>
  );
}
