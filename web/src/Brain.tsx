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
import { HitIndex } from './brain/hit';
import type { Arrangement } from './brain/layout';
import { BrainLayout } from './brain/layout';
import type { BrainGraph } from './brain/model';
import { buildGraph } from './brain/model';
import type { PositionStore } from './brain/positions';
import { loadPositions, savePositions } from './brain/positions';
import { createCanvasRenderer } from './brain/renderer';
import { SceneBuilder } from './brain/scene';

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

/** Breathing room around the fitted world when the caller asks for none. */
const EDGE: Inset = { top: 12, right: 12, bottom: 12, left: 12 };

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
  /** An animated camera move in progress, or null. */
  glide: { from: Camera; at: number } | null;
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
  width: number;
  height: number;
  savedAt: number;
  /** Where positions are remembered, or null when this instance does not. */
  store: PositionStore | null;
  /** The `view` this engine was built for. */
  view: string;
}

export function Brain({ data, events, onOpen, remember, view, arrangement, inset }: BrainProps): React.JSX.Element {
  const host = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Engine | null>(null);
  /** Set by the frame effect, called by the reset control. */
  const home = useRef<() => void>(() => {});
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

  /** Drives the reset control, which stays hidden until there is somewhere to return from. */
  const [adrift, setAdrift] = useState(false);
  /** Read by the frame loop; a ref so a new object literal per render restarts nothing. */
  const margin = useRef<Inset>(inset ?? EDGE);
  useEffect(() => {
    margin.current = inset ?? EDGE;
  });

  // Rebuilt only when the graph really changes — not on every pulse.
  useEffect(() => {
    const canvas = host.current;
    if (canvas === null) return;

    const rect = canvas.getBoundingClientRect();
    const graph = buildGraph(data);
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
    const picked =
      same === null || same.picked < 0
        ? -1
        : (graph.index.get(same.graph.nodes[same.picked]!.key) ?? -1);

    engine.current = {
      graph,
      layout,
      activity: new Activity(graph),
      builder: new SceneBuilder(graph),
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
      width: rect.width,
      height: rect.height,
      savedAt: performance.now(),
      store,
      view,
    };
  // `remember` is an object from the caller; its contents are what matter.
  }, [data, remember?.account, remember?.store, view, arrangement]);

  /** Fire new events — a flash at the place, sparks along its tracts. */
  useEffect(() => {
    engine.current?.activity.record(events);
  }, [events]);

  // The frame, the pointer and the camera.
  useEffect(() => {
    const canvas = host.current;
    if (canvas === null) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const paint = createCanvasRenderer(canvas);
    let frame = 0;

    const measure = (): void => {
      const e = engine.current;
      const rect = canvas.getBoundingClientRect();
      paint.resize(rect.width, rect.height);
      if (e === null) return;
      // Only the mapping changes. The layout has no idea how big the window is.
      e.width = rect.width;
      e.height = rect.height;
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

    const loop = (): void => {
      const e = engine.current;
      if (e !== null) {
        const now = performance.now();

        const home = fit(e.layout.bounds, e.width, e.height, margin.current);
        if (e.glide !== null) {
          const t = reduce ? 1 : (now - e.glide.at) / GLIDE_MS;
          if (t >= 1) {
            e.glide = null;
            e.homed = true;
          } else {
            // Towards where home is now, not where it was when the glide began:
            // the panel may be changing width at the same moment.
            e.camera = between(e.glide.from, home, ease(t));
          }
        }
        if (e.homed) e.camera = home;

        if (!reduce) {
          // Nothing to compute once it has come to rest; the frame still draws,
          // because pulses still fire.
          if (e.layout.step()) {
            e.hits.invalidate();
            e.dirty = true;
          }
          e.activity.advance();
        }
        persist(e, now, false);

        paint.draw(e.builder.build(e.layout, e.activity, e.camera, e.picked, e.width, e.height));
        const away = !e.homed;
        if (away !== shown) {
          shown = away;
          setAdrift(away);
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    /** The node under a screen point, or -1. */
    const locate = (event: { clientX: number; clientY: number }): number => {
      const e = engine.current;
      if (e === null) return -1;
      const rect = canvas.getBoundingClientRect();
      const at = toWorld(e.camera, event.clientX - rect.left, event.clientY - rect.top);
      return e.hits.at(at.x, at.y, e.camera.scale);
    };

    const goHome = (): void => {
      const e = engine.current;
      if (e === null || e.homed || e.glide !== null) return;
      e.glide = { from: e.camera, at: performance.now() };
    };
    home.current = goHome;

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
    };

    const onMove = (event: PointerEvent): void => {
      const e = engine.current;
      if (e === null) return;
      if (e.press !== null && e.drag < 0) {
        if (Math.hypot(event.clientX - e.press.x, event.clientY - e.press.y) <= DRAG_SLOP) return;
        e.drag = e.press.node;
        e.layout.hold(e.drag);
      }
      if (e.drag >= 0) {
        const rect = canvas.getBoundingClientRect();
        const at = toWorld(e.camera, event.clientX - rect.left, event.clientY - rect.top);
        e.layout.place(e.drag, at.x, at.y);
        e.hits.invalidate();
        e.dirty = true;
        return;
      }
      if (e.pan !== null) {
        if (event.clientX === e.pan.x && event.clientY === e.pan.y) return;
        e.homed = false;
        e.camera = panBy(e.camera, event.clientX - e.pan.x, event.clientY - e.pan.y);
        e.pan = { ...e.pan, x: event.clientX, y: event.clientY };
      }
    };

    const onUp = (event: PointerEvent): void => {
      const e = engine.current;
      if (e === null) return;
      // A click on the dark lets go of the selected note. Only a click: a pan
      // that happens to start and end on the dark keeps it.
      if (e.pan !== null && Math.hypot(event.clientX - e.pan.fromX, event.clientY - e.pan.fromY) <= DRAG_SLOP) {
        e.picked = -1;
      }
      if (e.drag >= 0) {
        e.layout.release();
        // The frame loop does not step under reduced motion: the neighbours
        // settle around the dropped note at once instead of never.
        if (reduce) {
          e.layout.settle();
          e.hits.invalidate();
        }
      }
      e.drag = -1;
      e.press = null;
      e.pan = null;
    };

    const onDouble = (event: MouseEvent): void => {
      const e = engine.current;
      const hit = locate(event);
      if (e !== null && hit >= 0) open.current(e.graph.nodes[hit]!.owner, e.graph.nodes[hit]!.path);
    };

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && engine.current !== null) engine.current.picked = -1;
      if (event.key === '0' || event.key === 'Escape') goHome();
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
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('pagehide', onLeaving);

    return () => {
      cancelAnimationFrame(frame);
      onLeaving();
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('pagehide', onLeaving);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('dblclick', onDouble);
      canvas.removeEventListener('keydown', onKey);
      home.current = () => {};
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
    </>
  );
}
