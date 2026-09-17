/**
 * The network as a treemap of the folder structure.
 *
 * Where the graph shows shape and the list shows facts, this shows scale: which
 * parts of the vault are big, and which of them have been alive lately. Area is
 * note count, nested by folder (`10_Projects` → `11_Active` → …); warmth is the
 * share of a folder's notes touched in the last two weeks, the same window the
 * brain view warms a note's halo over.
 *
 * Two levels are drawn for every folder big enough to hold them: its own frame
 * and header, and inside that, its direct children laid out again and coloured
 * by their own warmth. A treemap with only one level visible is four flat
 * blocks that say almost nothing; the nesting is the point, and warmth reads
 * at the level where "where is work happening" is actually answered, rather
 * than averaged away across a folder's entire subtree.
 *
 * Other people's vaults, where shares make them visible, are folders of their
 * own under the root, named after their owner — never merged into a folder of
 * yours that happens to have the same name.
 *
 * **What re-renders when.** The layout (both levels, every rect) is computed
 * once per folder shown and container size, in `layoutMap`, and the SVG is a
 * memoised child fed only that. Hovering writes to a small store the details
 * panel alone subscribes to, so moving the pointer across a thousand cells
 * repaints one panel and lays out nothing.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { GraphData } from '../api';
import { copy } from '../copy';
import { ownerLabel, useOwners } from '../owners';
import { displayName } from '../Tree';
import { absoluteTime } from './relativeTime';
import type { FolderNode, MapNode, Rect } from './treemap';
import { buildFolderTree, findFolder, folderWarmth, layoutFolder, noteWarmth } from './treemap';
import { paintCell, truncate } from './mapPaint';
import './network.css';

/** Gap between sibling cells, and padding between a folder's frame and its nested children. */
const GAP = 2;
const INNER_PAD = 4;
/** Height of a nested folder's name header. */
const HEADER_H = 20;
/**
 * Below this size a folder cell shows no header and no nested preview — just
 * a single warmth-coloured block, the same as a note. There would be nothing
 * legible to nest into it anyway.
 */
const MIN_NEST_W = 90;
const MIN_NEST_H = 60;

/**
 * Before the container has been measured (the first paint, or a test
 * environment with no real layout engine) there is no real size to lay out
 * into. A fixed fallback keeps the treemap renderable in both cases rather
 * than laying out into a zero-area rect.
 */
const FALLBACK_SIZE = { w: 960, h: 600 };

function shrink(rect: Rect, by: number): Rect {
  const w = Math.max(0, rect.w - by * 2);
  const h = Math.max(0, rect.h - by * 2);
  return { x: rect.x + by, y: rect.y + by, w, h };
}

/**
 * The frame's actual rendered size in CSS pixels, kept live with a
 * `ResizeObserver`.
 *
 * Measuring the container and using that exact size as both the layout bounds
 * and the `viewBox` is what keeps the treemap from letterboxing: a fixed box
 * scaled uniformly into a container of another aspect ratio leaves empty bars.
 *
 * A callback ref rather than a ref object. The frame does not exist while the
 * vault is empty, and an effect keyed on a ref object never runs again when
 * the element behind it appears later — the map then stayed on the fallback
 * size, letterboxed, until the next remount. Holding the element in state
 * makes its arrival a change the effect sees.
 */
function useContainerSize(): [(el: HTMLDivElement | null) => void, { w: number; h: number }] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState(FALLBACK_SIZE);

  useEffect(() => {
    if (el === null) return;

    const measure = (): void => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      // A test environment with no layout engine reports 0 for everything;
      // keeping the fallback then is better than laying out into nothing.
      if (w > 0 && h > 0) setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);

  return [setEl, size];
}

function folderName(folder: FolderNode, hidePrefixes: boolean, labelOf?: (owner: string) => string): string {
  // Another vault, under its root: a space by its display name, a person by account.
  if (folder.vault) return labelOf === undefined ? folder.owner : labelOf(folder.owner);
  return folder.path === '' ? copy.network.mapView.root : displayName(folder.name, hidePrefixes);
}

interface HoverInfo {
  title: string;
  notes: number;
  links: number;
  lastUpdated: number;
}

/** Where a cell leads: into a folder, or to a note. */
type Target = { kind: 'zoom'; owner: string; path: string } | { kind: 'open'; owner: string; path: string };

/** One drawn cell, with everything the SVG needs and nothing it has to compute. */
export interface MapCell {
  key: string;
  /** A frame holds nested cells drawn after it; a leaf is a single block. */
  kind: 'frame' | 'leaf';
  rect: Rect;
  label: string;
  /** Leaves only: 0 cool … 1 fully warm. */
  warmth: number;
  /** A leaf inside a frame, drawn with smaller labels. */
  small: boolean;
  a11yLabel: string;
  hover: HoverInfo;
  target: Target;
}

/**
 * Both levels of the map for one folder, as a flat list in drawing order: a
 * frame is followed by the cells nested inside it.
 *
 * Pure and exported so that what a hover must *not* cause — running this
 * again — is something a test can count.
 */
export function layoutMap(
  current: FolderNode,
  w: number,
  h: number,
  hidePrefixes: boolean,
  labelOf?: (owner: string) => string,
): MapCell[] {
  const out: MapCell[] = [];
  const now = Date.now();

  const noteCell = (note: MapNode, rect: Rect, small: boolean): MapCell => ({
    key: `n:${JSON.stringify([note.owner, note.path])}`,
    kind: 'leaf',
    rect,
    label: note.title,
    warmth: noteWarmth(note.updatedAt, now),
    small,
    a11yLabel: copy.network.mapView.noteLabel(note.title),
    hover: { title: note.title, notes: 1, links: note.links, lastUpdated: note.updatedAt },
    target: { kind: 'open', owner: note.owner, path: note.path },
  });

  const folderLeaf = (folder: FolderNode, rect: Rect, small: boolean): MapCell => {
    const name = folderName(folder, hidePrefixes, labelOf);
    return {
      key: `f:${folder.key}`,
      kind: 'leaf',
      rect,
      label: name,
      warmth: folderWarmth(folder),
      small,
      a11yLabel: copy.network.mapView.folderLabel(name, folder.noteCount),
      hover: { title: name, notes: folder.noteCount, links: folder.linkTotal, lastUpdated: folder.lastUpdated },
      target: { kind: 'zoom', owner: folder.owner, path: folder.path },
    };
  };

  const top = layoutFolder(current, { x: 0, y: 0, w, h });
  for (const cell of top) {
    const rect = shrink(cell.rect, GAP / 2);
    if (cell.kind === 'note') {
      out.push(noteCell(cell.note, rect, false));
      continue;
    }
    const folder = cell.folder;
    const canNest =
      rect.w >= MIN_NEST_W && rect.h >= MIN_NEST_H && folder.children.length + folder.notes.length > 0;
    if (!canNest) {
      out.push(folderLeaf(folder, rect, false));
      continue;
    }

    // A second level, never a third: a grandchild folder is always a leaf.
    // Frame and children are siblings in the SVG, not one inside the other's
    // click target, so a click on a nested cell never also zooms the parent.
    const frame = folderLeaf(folder, rect, false);
    out.push({ ...frame, kind: 'frame', label: `${truncate(frame.label, 30)} · ${folder.noteCount}` });
    const inner: Rect = {
      x: rect.x + INNER_PAD,
      y: rect.y + HEADER_H,
      w: Math.max(0, rect.w - INNER_PAD * 2),
      h: Math.max(0, rect.h - HEADER_H - INNER_PAD),
    };
    for (const child of layoutFolder(folder, inner)) {
      const childRect = shrink(child.rect, GAP / 2);
      out.push(child.kind === 'folder' ? folderLeaf(child.folder, childRect, true) : noteCell(child.note, childRect, true));
    }
  }
  return out;
}

/* ---- hover: a store only the panel listens to ---------------------------- */

interface HoverState {
  /**
   * Which cell, by its key, not a copy of its numbers. The panel looks the
   * cell up in the current layout, so a refetch shows the new numbers and a
   * cell that disappeared takes its details with it instead of leaving them
   * hanging.
   */
  key: string | null;
  /** Whether the change came from the keyboard, and so is worth saying out loud. */
  announce: boolean;
}

interface HoverStore {
  get: () => HoverState;
  set: (key: string | null, announce: boolean) => void;
  subscribe: (listener: () => void) => () => void;
}

function createHoverStore(): HoverStore {
  let state: HoverState = { key: null, announce: false };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (key, announce) => {
      if (state.key === key && state.announce === announce) return;
      state = { key, announce };
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function HoverPanel({ store, cells }: { store: HoverStore; cells: readonly MapCell[] }): React.JSX.Element {
  const { key, announce } = useSyncExternalStore(store.subscribe, store.get, store.get);
  const byKey = useMemo(() => new Map(cells.map((cell) => [cell.key, cell.hover])), [cells]);
  const info = key === null ? null : (byKey.get(key) ?? null);
  const details =
    info === null
      ? null
      : [
          copy.network.mapView.notes(info.notes),
          copy.network.mapView.links(info.links),
          `${copy.network.mapView.updated}: ${info.lastUpdated > 0 ? absoluteTime(info.lastUpdated) : copy.network.mapView.never}`,
        ];

  return (
    <div className="nv-hover-panel">
      {info !== null && details !== null ? (
        <>
          <span className="nv-hover-title">{info.title}</span>
          <span className="nv-hover-stats">
            {details.map((d) => (
              <span key={d}>{d}</span>
            ))}
          </span>
        </>
      ) : (
        <span>{copy.network.mapView.hoverHint}</span>
      )}
      {/* Spoken only for what the keyboard reached. A pointer sweeping across
          the map would otherwise queue an announcement per cell it crossed. */}
      <span className="nv-sr" aria-live="polite">
        {announce && info !== null && details !== null ? `${info.title}. ${details.join(', ')}` : ''}
      </span>
    </div>
  );
}

/* ---- the cells ------------------------------------------------------------ */

type Direction = 'left' | 'right' | 'up' | 'down';

const ARROWS: Record<string, Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

/**
 * The nearest cell in a direction, by centre.
 *
 * A treemap has no rows or columns to step through, so "right" means the
 * closest cell whose centre lies to the right, with distance across the
 * direction of travel weighing double — the cell straight ahead wins over one
 * that is nearer but off to the side.
 */
export function neighbour(cells: readonly MapCell[], from: number, direction: Direction): number {
  const here = cells[from];
  if (here === undefined) return from;
  const cx = here.rect.x + here.rect.w / 2;
  const cy = here.rect.y + here.rect.h / 2;
  let best = from;
  let bestScore = Infinity;
  cells.forEach((cell, index) => {
    if (index === from) return;
    const dx = cell.rect.x + cell.rect.w / 2 - cx;
    const dy = cell.rect.y + cell.rect.h / 2 - cy;
    const along = direction === 'right' ? dx : direction === 'left' ? -dx : direction === 'down' ? dy : -dy;
    const across = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0.5) return;
    const score = along + 2 * across;
    if (score < bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}

/**
 * The SVG body. Memoised: it changes when the layout does, and neither a hover
 * nor a parent render that changed nothing is a change to the layout.
 *
 * One tab stop for the whole map (roving tabindex): Tab enters on the last
 * cell that had focus and leaves again, the arrows move between cells. The
 * stop is remembered by the cell's key, not its position, so a refetch that
 * lays the same folder out again keeps it where it was; only when that cell is
 * gone does it fall back to the first.
 */
const MapCells = memo(function MapCells({
  cells,
  hover,
  onActivate,
}: {
  cells: readonly MapCell[];
  hover: HoverStore;
  onActivate: (target: Target) => void;
}): React.JSX.Element {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const refs = useRef(new Map<string, SVGGElement>());

  const found = activeKey === null ? -1 : cells.findIndex((cell) => cell.key === activeKey);
  const stop = found === -1 ? 0 : found;

  const onKeyDown = (event: React.KeyboardEvent<SVGGElement>, index: number, cell: MapCell): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onActivate(cell.target);
      return;
    }
    let next: number | null = null;
    const direction = ARROWS[event.key];
    if (direction !== undefined) next = neighbour(cells, index, direction);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = cells.length - 1;
    const target = next === null ? undefined : cells[next];
    if (target === undefined) return;
    event.preventDefault();
    setActiveKey(target.key);
    refs.current.get(target.key)?.focus();
  };

  return (
    <>
      {cells.map((cell, index) => {
        const { rect } = cell;
        const paint = paintCell(cell);
        return (
          <g
            key={cell.key}
            ref={(el) => {
              if (el === null) refs.current.delete(cell.key);
              else refs.current.set(cell.key, el);
            }}
            tabIndex={index === stop ? 0 : -1}
            role="button"
            aria-label={cell.a11yLabel}
            onMouseEnter={() => hover.set(cell.key, false)}
            onMouseLeave={() => hover.set(null, false)}
            onFocus={() => {
              setActiveKey(cell.key);
              hover.set(cell.key, true);
            }}
            onBlur={() => hover.set(null, false)}
            onClick={() => onActivate(cell.target)}
            onKeyDown={(event) => onKeyDown(event, index, cell)}
          >
            {cell.kind === 'frame' ? (
              <>
                <rect className="nv-cell-frame" x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={4} />
                <text className="nv-cell-header-label" x={rect.x + 8} y={rect.y + 14}>
                  {paint.text}
                </text>
              </>
            ) : (
              <>
                <rect
                  className="nv-cell-rect"
                  x={rect.x}
                  y={rect.y}
                  width={rect.w}
                  height={rect.h}
                  rx={3}
                  data-warm={paint.t > 0 ? '' : undefined}
                  style={paint.t > 0 ? ({ '--t': paint.t.toFixed(3) } as React.CSSProperties) : undefined}
                />
                {paint.showLabel && (
                  <text
                    className="nv-cell-label"
                    data-hot={paint.hot ? '' : undefined}
                    x={rect.x + 6}
                    y={rect.y + 14}
                  >
                    {paint.text}
                  </text>
                )}
              </>
            )}
          </g>
        );
      })}
    </>
  );
});

export function MapView(props: {
  graph: GraphData;
  onOpen: (owner: string, path: string) => void;
  /** The signed-in account: its vault is the root, every other owner a folder. */
  self?: string;
  hidePrefixes?: boolean;
}): React.JSX.Element {
  const { graph, onOpen, self, hidePrefixes = true } = props;
  const owners = useOwners();
  const labelOf = useCallback((owner: string): string => ownerLabel(owners, owner), [owners]);

  const [frameRef, { w: viewW, h: viewH }] = useContainerSize();

  const root = useMemo<FolderNode>(() => {
    const nodes: MapNode[] = graph.nodes.map((n) => ({
      owner: n.owner,
      path: n.path,
      title: n.title,
      folder: n.folder,
      links: n.links,
      updatedAt: n.updatedAt,
    }));
    return buildFolderTree(nodes, Date.now(), self);
  }, [graph.nodes, self]);

  const [zoom, setZoom] = useState<{ owner: string; path: string } | null>(null);
  const hover = useMemo(createHoverStore, []);

  const current = (zoom === null ? root : findFolder(root, zoom.path, zoom.owner)) ?? root;
  const cells = useMemo(
    () => layoutMap(current, viewW, viewH, hidePrefixes, labelOf),
    [current, viewW, viewH, hidePrefixes, labelOf],
  );

  // The latest `onOpen` without making every render of the parent a new
  // callback for the memoised cells.
  const openRef = useRef(onOpen);
  useEffect(() => {
    openRef.current = onOpen;
  }, [onOpen]);

  const onActivate = useCallback(
    (target: Target): void => {
      if (target.kind === 'open') {
        openRef.current(target.owner, target.path);
        return;
      }
      hover.set(null, false);
      setZoom({ owner: target.owner, path: target.path });
    },
    [hover],
  );

  const crumbs: FolderNode[] = [root];
  if (current !== root) {
    const vault = current.owner === root.owner ? null : findFolder(root, '', current.owner);
    if (vault) crumbs.push(vault);
    const segments = current.path === '' ? [] : current.path.split('/');
    for (let i = 0; i < segments.length; i += 1) {
      const found = findFolder(root, segments.slice(0, i + 1).join('/'), current.owner);
      if (found) crumbs.push(found);
    }
  }

  if (root.noteCount === 0) {
    return (
      <div className="network-view map-view">
        <p className="nv-empty">{copy.network.mapView.empty}</p>
      </div>
    );
  }

  return (
    <div className="network-view map-view">
      <nav className="nv-crumbs" aria-label={copy.network.mapView.breadcrumbLabel}>
        {crumbs.map((folder, i) => (
          <span key={folder.key}>
            {i > 0 && <span aria-hidden> › </span>}
            <button
              type="button"
              className="nv-crumb"
              aria-current={folder === current ? 'true' : undefined}
              disabled={folder === current}
              onClick={() => {
                hover.set(null, false);
                setZoom(folder === root ? null : { owner: folder.owner, path: folder.path });
              }}
            >
              {folderName(folder, hidePrefixes, labelOf)}
            </button>
          </span>
        ))}
      </nav>

      <div className="nv-map">
        <div className="nv-treemap-frame" ref={frameRef}>
          <svg viewBox={`0 0 ${viewW} ${viewH}`} role="group" aria-label={folderName(current, hidePrefixes, labelOf)}>
            <MapCells cells={cells} hover={hover} onActivate={onActivate} />
          </svg>
        </div>

        <HoverPanel store={hover} cells={cells} />
      </div>
    </div>
  );
}
