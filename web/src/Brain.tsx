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
 *  - **The arrangement emerges, it is not drawn.** The lobes come from the
 *    vault's folders, not from a brain silhouette.
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
import type { Camera } from './brain/camera';
import { HOME, between, ease, isHome, panBy, toWorld, zoomAt } from './brain/camera';
import { HitIndex } from './brain/hit';
import { BrainLayout } from './brain/layout';
import type { BrainGraph } from './brain/model';
import { buildGraph } from './brain/model';
import { loadPositions, savePositions } from './brain/positions';
import { createCanvasRenderer } from './brain/renderer';
import { SceneBuilder } from './brain/scene';

export interface BrainProps {
  data: GraphData;
  /** Events that have arrived since the last call. */
  events: PulseEvent[];
  onOpen: (owner: string, path: string) => void;
  /**
   * Name of the store that remembers where the nodes settled.
   *
   * Only the full network passes one. The neighbourhood panel is a different
   * subgraph in a different-sized box for every note opened, so remembering it
   * would mean storing one arrangement per note to answer a question the path
   * hash already answers: it opens the same way every time regardless.
   */
  remember?: string;
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

interface Engine {
  graph: BrainGraph;
  layout: BrainLayout;
  activity: Activity;
  builder: SceneBuilder;
  camera: Camera;
  /** An animated camera move in progress, or null. */
  glide: { from: Camera; to: Camera; at: number } | null;
  /** The node whose name is shown because it was clicked, or -1. */
  picked: number;
  /** The node being dragged, or -1. */
  drag: number;
  /** Where the pointer was when panning, in screen pixels, or null. */
  pan: { x: number; y: number } | null;
  /** Which node is under a point. Rebuilt on demand, not per frame. */
  hits: HitIndex;
  width: number;
  height: number;
  savedAt: number;
  /** Name of the position store, or null when this instance does not remember. */
  store: string | null;
}

export function Brain({ data, events, onOpen, remember }: BrainProps): React.JSX.Element {
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

  // Rebuilt only when the graph really changes — not on every pulse.
  useEffect(() => {
    const canvas = host.current;
    if (canvas === null) return;

    const rect = canvas.getBoundingClientRect();
    const graph = buildGraph(data);
    const store = remember ?? null;
    const before = engine.current;

    // A refetch while the view is open starts from where the nodes are *now*,
    // not from storage, which can be up to one save interval behind — reading it
    // back would make every edit elsewhere twitch the picture. Storage is for
    // arriving; the running layout is for staying.
    const remembered =
      store === null
        ? undefined
        : before !== null && before.store === store
          ? before.layout.positions()
          : loadPositions(store);
    const layout = new BrainLayout(graph, rect.width, rect.height, remembered);

    // The camera survives a rebuild. A note saved elsewhere refetches the graph,
    // and yanking the view back to the overview mid-read would punish the user
    // for somebody else's edit.
    const picked =
      before === null || before.picked < 0
        ? -1
        : (graph.index.get(before.graph.nodes[before.picked]!.key) ?? -1);

    engine.current = {
      graph,
      layout,
      activity: new Activity(graph),
      builder: new SceneBuilder(graph),
      camera: before?.camera ?? HOME,
      glide: null,
      picked,
      drag: -1,
      pan: null,
      hits: new HitIndex(layout),
      width: rect.width,
      height: rect.height,
      savedAt: performance.now(),
      store,
    };
  }, [data, remember]);

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
      e.width = rect.width;
      e.height = rect.height;
      e.layout.resize(rect.width, rect.height);
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
      if (e.store === null) return;
      if (!force && now - e.savedAt < SAVE_MS) return;
      e.savedAt = now;
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

        if (e.glide !== null) {
          const t = reduce ? 1 : (now - e.glide.at) / GLIDE_MS;
          if (t >= 1) {
            e.camera = e.glide.to;
            e.glide = null;
          } else {
            e.camera = between(e.glide.from, e.glide.to, ease(t));
          }
        }

        if (!reduce) {
          e.layout.step();
          e.activity.advance();
          e.hits.invalidate();
        }
        persist(e, now, false);

        paint.draw(e.builder.build(e.layout, e.activity, e.camera, e.picked, e.width, e.height));
        const away = !isHome(e.camera);
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
      if (e === null || isHome(e.camera)) return;
      e.glide = { from: e.camera, to: HOME, at: performance.now() };
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
      e.glide = null;
      e.camera = zoomAt(
        e.camera,
        event.clientX - rect.left,
        event.clientY - rect.top,
        Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0022)),
      );
    };

    /**
     * One gesture, two meanings, decided here and nowhere else.
     *
     * Press on a cell body and you move that note; press on the dark and you
     * move the camera. Deciding it once at `pointerdown` is what keeps it
     * predictable — a drag that changed its mind partway, because the pointer
     * happened to cross a node, would be unusable.
     */
    const onDown = (event: PointerEvent): void => {
      const e = engine.current;
      if (e === null) return;
      const hit = locate(event);
      e.glide = null;
      canvas.setPointerCapture(event.pointerId);
      if (hit >= 0) {
        e.drag = hit;
        e.picked = hit;
        e.layout.pinned = hit;
      } else {
        e.pan = { x: event.clientX, y: event.clientY };
      }
    };

    const onMove = (event: PointerEvent): void => {
      const e = engine.current;
      if (e === null) return;
      if (e.drag >= 0) {
        const rect = canvas.getBoundingClientRect();
        const at = toWorld(e.camera, event.clientX - rect.left, event.clientY - rect.top);
        e.layout.place(e.drag, at.x, at.y);
        e.hits.invalidate();
        return;
      }
      if (e.pan !== null) {
        e.camera = panBy(e.camera, event.clientX - e.pan.x, event.clientY - e.pan.y);
        e.pan = { x: event.clientX, y: event.clientY };
      }
    };

    const onUp = (): void => {
      const e = engine.current;
      if (e === null) return;
      e.drag = -1;
      e.pan = null;
      e.layout.pinned = -1;
    };

    const onDouble = (event: MouseEvent): void => {
      const e = engine.current;
      const hit = locate(event);
      if (e !== null && hit >= 0) open.current(e.graph.nodes[hit]!.owner, e.graph.nodes[hit]!.path);
    };

    const onKey = (event: KeyboardEvent): void => {
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
