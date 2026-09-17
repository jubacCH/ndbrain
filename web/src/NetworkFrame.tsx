/**
 * The frame around the whole network: which of its three views is on screen,
 * and the way into full screen.
 *
 * Graph, List and Map show the same graph reply three ways — as the brain, as a
 * table, as a map of the folders — so they share one frame and one switcher
 * rather than being three entries in the sidebar. The choice is remembered with
 * the other preferences of this screen and survives a reload.
 *
 * In the graph view the controls sit inside the brain's own container, beside
 * the canvas. That placement is load-bearing: the renderer measures every
 * element laid over the canvas in that container (`brain/blocked.ts`) and keeps
 * region names clear of them, so the switcher never ends up printed over a name.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { GraphData, PulseEvent } from './api';
import { Brain } from './Brain';
import { Inspector } from './Inspector';
import { indexGraph } from './inspect';
import { RECENT_DAYS } from './brain/scene';
import { copy } from './copy';
import { BrainIcon, ExpandIcon, ListIcon, MapIcon, NetworkIcon, ShrinkIcon } from './icons';
import { ListView } from './network/ListView';
import { MapView } from './network/MapView';
import { NETWORK_VIEWS, type NetworkView } from './prefs';

/**
 * Room the brain's resting view leaves for the controls laid over it: the
 * switcher at the top, the legend along the bottom. Screen pixels, and nowhere
 * near the simulation, which does not know either exists.
 */
const NETWORK_INSET = { top: 64, right: 20, bottom: 64, left: 20 };

/** A frame in full screen: where overlays must be drawn to be seen, and the way out. */
export interface FullscreenFrame {
  host: HTMLElement;
  leave: () => void;
}

const LABELS: Record<NetworkView, { label: string; icon: React.JSX.Element }> = {
  graph: { label: copy.shell.network.graph, icon: <NetworkIcon size={15} /> },
  list: { label: copy.shell.network.list, icon: <ListIcon size={15} /> },
  map: { label: copy.shell.network.map, icon: <MapIcon size={15} /> },
};

export function NetworkFrame({
  graph,
  events,
  account,
  view,
  onView,
  onOpen,
  onFullscreen,
  onReveal,
  hidePrefixes = true,
}: {
  graph: GraphData;
  events: PulseEvent[];
  /** Whose arrangement the brain remembers. */
  account: string;
  view: NetworkView;
  onView: (view: NetworkView) => void;
  onOpen: (owner: string, path: string) => void;
  /**
   * Told when full screen begins and ends.
   *
   * In full screen nothing outside this frame is visible — with the platform's
   * API the browser shows only this element, and without it the frame covers
   * the window — so the shell needs to know where a message has to go, and how
   * to step out before opening something that lives outside.
   */
  onFullscreen?: (frame: FullscreenFrame | null) => void;
  /**
   * Shows a note in the sidebar's tree without opening it. The inspector
   * offers "Show in tree" only when the shell passes this.
   */
  onReveal?: (owner: string, path: string) => void;
  /** Show folder names without their sort prefixes, as the tree does. */
  hidePrefixes?: boolean;
}): React.JSX.Element {
  const frame = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  /**
   * The focused note in the brain, by key, or null.
   *
   * Held here rather than in the canvas because two things show it: the brain,
   * which frames it, and the inspector, which describes it and can move the
   * focus on to a neighbour.
   */
  const [picked, setPicked] = useState<string | null>(null);
  const index = useMemo(() => indexGraph(graph), [graph]);

  // Another view has no canvas to hold the focus; coming back starts without one.
  useEffect(() => {
    if (view !== 'graph') setPicked(null);
  }, [view]);

  /** Ends the focus from the inspector, and hands the keyboard back to the canvas. */
  const pick = useCallback((key: string | null): void => {
    setPicked(key);
    if (key === null) frame.current?.querySelector<HTMLCanvasElement>('canvas.brain')?.focus();
  }, []);

  // Full screen can end without this button — Escape, the browser's own
  // control — so the state follows the document rather than the click.
  useEffect(() => {
    const sync = (): void => {
      if (!document.fullscreenElement) setFull(false);
    };
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  // The fallback, where the platform has no full-screen API for an element
  // (Safari on an iPhone): the frame covers the window instead, and Escape
  // leaves it the same way.
  useEffect(() => {
    if (!full) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !document.fullscreenElement) setFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  const leave = useCallback((): void => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    setFull(false);
  }, []);

  useEffect(() => {
    if (onFullscreen === undefined) return;
    const host = frame.current;
    onFullscreen(full && host !== null ? { host, leave } : null);
    return () => onFullscreen(null);
  }, [full, leave, onFullscreen]);

  const toggleFull = useCallback((): void => {
    const el = frame.current;
    if (full) {
      leave();
      return;
    }
    setFull(true);
    if (el !== null && document.fullscreenEnabled && typeof el.requestFullscreen === 'function') {
      void el.requestFullscreen().catch(() => undefined);
    }
  }, [full, leave]);

  /**
   * Arrow keys move between the three, as in any radio group; the choice
   * follows the focus, because every view is cheap to show.
   */
  const onSwitchKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = NETWORK_VIEWS.indexOf(view);
    const next = NETWORK_VIEWS[(index + step + NETWORK_VIEWS.length) % NETWORK_VIEWS.length]!;
    onView(next);
    window.setTimeout(() => {
      frame.current?.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus();
    }, 0);
  };

  const controls = (
    <div className="netbar">
      <div className="netswitch" role="radiogroup" aria-label={copy.shell.network.switcher} onKeyDown={onSwitchKey}>
        {NETWORK_VIEWS.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            data-view={option}
            aria-checked={view === option}
            aria-label={LABELS[option].label}
            title={LABELS[option].label}
            tabIndex={view === option ? 0 : -1}
            onClick={() => onView(option)}
          >
            {LABELS[option].icon}
            <span>{LABELS[option].label}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="netfull"
        onClick={toggleFull}
        aria-label={full ? copy.shell.network.exitFullscreen : copy.shell.network.fullscreen}
        title={full ? copy.shell.network.exitFullscreen : copy.shell.network.fullscreen}
        aria-pressed={full}
      >
        {full ? <ShrinkIcon size={16} /> : <ExpandIcon size={16} />}
      </button>
    </div>
  );

  return (
    <div className="netframe" ref={frame} data-view={view} data-full={full}>
      {view === 'graph' ? (
        <div className="brainwrap">
          <Brain
            data={graph}
            events={events}
            onOpen={onOpen}
            remember={{ account, store: 'network' }}
            view="network"
            arrangement="brain"
            inset={NETWORK_INSET}
            focus={{ picked, onPick: setPicked }}
          />
          {/* Right after the canvas, so Tab from a focused note reaches the
              inspector before the controls. A sibling of the canvas, so the
              region names keep clear of it (`brain/blocked.ts`). */}
          {picked !== null && index.nodes.has(picked) && (
            <Inspector
              index={index}
              picked={picked}
              onPick={pick}
              onOpen={onOpen}
              onReveal={onReveal}
            />
          )}
          {controls}
          {/* The legend, where the reference has its motto: along the bottom,
              one line. Colours from the renderer's palette, which is not a
              theme token — the canvas is dark in both themes. */}
          <div className="brainfoot">
            <BrainIcon size={16} />
            <span><i style={{ background: '#7fe9f0' }} />{copy.network.read}</span>
            <span className="sep" />
            <span><i style={{ background: '#ffb86b' }} />{copy.network.written}</span>
            <span className="sep" />
            {/* The amber points, as opposed to the amber flash: what has been
                worked on lately, not what is being written now. */}
            <span><i style={{ background: '#f0cd8c' }} />{copy.network.recent(RECENT_DAYS)}</span>
            <span className="sep" />
            {/* How to get from a point to its note, which the canvas cannot say. */}
            <span className="brainfoot-hint">{copy.network.doubleClick}</span>
          </div>
        </div>
      ) : (
        <div className="netpane">
          {controls}
          <div className="netpane-body">
            {view === 'list' ? (
              <ListView graph={graph} onOpen={onOpen} hidePrefixes={hidePrefixes} />
            ) : (
              <MapView graph={graph} onOpen={onOpen} self={account} hidePrefixes={hidePrefixes} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
