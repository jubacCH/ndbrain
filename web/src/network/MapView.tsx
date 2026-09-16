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
 * The layout itself (`./treemap`) is a pure function with no DOM in it, called
 * again for each folder's own children. What is here is the part that
 * genuinely needs React: measuring the real container, owning the zoom level,
 * drawing the rects it is handed, and turning pointer/keyboard input into a
 * zoom or an `onOpen`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { GraphData } from '../api';
import { copy } from '../copy';
import { displayName } from '../Tree';
import { absoluteTime } from './relativeTime';
import type { FolderNode, MapNode, Rect, TreemapCell } from './treemap';
import { buildFolderTree, findFolder, folderWarmth, layoutFolder, noteWarmth } from './treemap';
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
 * This is the fix for a treemap that used to leave empty bars on the left and
 * right: it laid its rects out into a fixed 1000×620 box and let the SVG's
 * `viewBox` scale that box into the container, which is a *uniform* scale — it
 * preserves the box's aspect ratio and, wherever the container's actual aspect
 * ratio differs (almost always), letterboxes the gap in as empty space rather
 * than distorting the picture. `squarify` itself was always correct for
 * whatever rectangle it was given (see `network-treemap.test.ts`); the bug was
 * that it was never given the real one. Measuring the container and using that
 * exact size as both the layout bounds and the `viewBox` removes the mismatch
 * instead of compensating for it.
 */
function useContainerSize(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState(FALLBACK_SIZE);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = (): void => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      // A test environment with no layout engine reports 0 for everything;
      // keeping the fallback then is better than laying out into nothing.
      if (w > 0 && h > 0) setSize({ w, h });
    };
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}

/**
 * A cool, faintly cyan-tinted surface at 0 warmth, shifting toward the warm
 * accent as warmth rises toward 1 — resolved from CSS custom properties at
 * paint time, so it follows the current theme automatically.
 *
 * Warmth is most often somewhere in the middle (a folder is rarely either
 * fully dormant or fully just-written), and a plain linear blend made that
 * middle ground read as a flat, uniform tan across the whole map — nothing
 * stood out as "hot". The curve pushes the middle back toward cool and saves
 * the strong warm tint for cells genuinely concentrated with recent work, and
 * the 55% cap keeps even a fully warm cell readable as a tinted surface
 * rather than a block of solid accent colour.
 */
function warmthColour(warmth: number): string {
  const t = Math.max(0, Math.min(1, warmth)) ** 1.6;
  const pct = Math.round(t * 55);
  return `color-mix(in srgb, var(--nv-warm) ${pct}%, color-mix(in srgb, var(--nv-cyan) 12%, var(--nv-surface-2)))`;
}

function folderName(folder: FolderNode): string {
  return folder.path === '' ? copy.network.mapView.root : displayName(folder.name);
}

function truncate(label: string, max = 24): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

interface HoverInfo {
  title: string;
  notes: number;
  links: number;
  lastUpdated: number;
}

function folderHover(folder: FolderNode): HoverInfo {
  return { title: folderName(folder), notes: folder.noteCount, links: folder.linkTotal, lastUpdated: folder.lastUpdated };
}

function noteHover(note: MapNode): HoverInfo {
  return { title: note.title, notes: 1, links: note.links, lastUpdated: note.updatedAt };
}

export function MapView(props: { graph: GraphData; onOpen: (owner: string, path: string) => void }): React.JSX.Element {
  const { graph, onOpen } = props;

  const frameRef = useRef<HTMLDivElement>(null);
  const { w: viewW, h: viewH } = useContainerSize(frameRef);

  const root = useMemo<FolderNode>(() => {
    const nodes: MapNode[] = graph.nodes.map((n) => ({
      owner: n.owner,
      path: n.path,
      title: n.title,
      folder: n.folder,
      links: n.links,
      updatedAt: n.updatedAt,
    }));
    return buildFolderTree(nodes);
  }, [graph.nodes]);

  const [zoomPath, setZoomPath] = useState('');
  const [hover, setHover] = useState<HoverInfo | null>(null);

  const current = findFolder(root, zoomPath) ?? root;
  const bounds: Rect = { x: 0, y: 0, w: viewW, h: viewH };
  const cells = useMemo(
    () => layoutFolder(current, bounds).map((cell) => ({ ...cell, rect: shrink(cell.rect, GAP / 2) })),
    [current, viewW, viewH],
  );

  const crumbs: FolderNode[] = [root];
  if (zoomPath !== '') {
    const segments = zoomPath.split('/');
    for (let i = 0; i < segments.length; i += 1) {
      const found = findFolder(root, segments.slice(0, i + 1).join('/'));
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

  /** A single warmth-coloured leaf: a note, or a folder too small to nest into. */
  function leafCell(
    key: string,
    rect: Rect,
    label: string,
    warmth: number,
    a11yLabel: string,
    onHover: () => void,
    onActivate: () => void,
    small: boolean,
  ): React.JSX.Element {
    const showLabel = small ? rect.w > 30 && rect.h > 14 : rect.w > 42 && rect.h > 20;
    return (
      <g
        key={key}
        tabIndex={0}
        role="button"
        aria-label={a11yLabel}
        onMouseEnter={onHover}
        onFocus={onHover}
        onMouseLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onClick={onActivate}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onActivate();
          }
        }}
      >
        <rect
          className="nv-cell-rect"
          x={rect.x}
          y={rect.y}
          width={rect.w}
          height={rect.h}
          rx={3}
          style={{ fill: warmthColour(warmth) }}
        />
        {showLabel && (
          <text className="nv-cell-label" x={rect.x + 6} y={rect.y + 14}>
            {truncate(label, small ? 16 : 24)}
          </text>
        )}
      </g>
    );
  }

  /** A note cell — always a leaf, at either level. */
  function renderNote(note: MapNode, rect: Rect, small: boolean): React.JSX.Element {
    return leafCell(
      `n:${note.owner}/${note.path}`,
      rect,
      note.title,
      noteWarmth(note.updatedAt),
      copy.network.mapView.noteLabel(note.title),
      () => setHover(noteHover(note)),
      () => onOpen(note.owner, note.path),
      small,
    );
  }

  /**
   * A folder cell. Big enough, it gets a frame, a header naming it, and its
   * own children laid out again beneath — a second level, never a third: a
   * grandchild folder previewed this way is always drawn as a plain leaf, so
   * the map stays exactly two levels deep regardless of how far the vault
   * actually nests. Every folder cell, at either level, zooms straight to
   * itself on click; the two levels sit as siblings in the SVG, not one
   * inside the other's click target, so a click on a nested preview never
   * also fires its parent's.
   */
  function renderFolder(folder: FolderNode, rect: Rect, depth: 0 | 1): React.JSX.Element {
    const a11yLabel = copy.network.mapView.folderLabel(folderName(folder), folder.noteCount);
    const activate = (): void => setZoomPath(folder.path);
    const showFolderHover = (): void => setHover(folderHover(folder));

    const canNest =
      depth === 0 && rect.w >= MIN_NEST_W && rect.h >= MIN_NEST_H && folder.children.length + folder.notes.length > 0;

    if (!canNest) {
      return leafCell(
        `f:${folder.path}`,
        rect,
        folderName(folder),
        folderWarmth(folder),
        a11yLabel,
        showFolderHover,
        activate,
        depth === 1,
      );
    }

    const innerBounds: Rect = {
      x: rect.x + INNER_PAD,
      y: rect.y + HEADER_H,
      w: Math.max(0, rect.w - INNER_PAD * 2),
      h: Math.max(0, rect.h - HEADER_H - INNER_PAD),
    };
    const innerCells = layoutFolder(folder, innerBounds).map((cell) => ({ ...cell, rect: shrink(cell.rect, GAP / 2) }));

    return (
      <g key={`f:${folder.path}`}>
        <g
          tabIndex={0}
          role="button"
          aria-label={a11yLabel}
          onMouseEnter={showFolderHover}
          onFocus={showFolderHover}
          onMouseLeave={() => setHover(null)}
          onBlur={() => setHover(null)}
          onClick={activate}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              activate();
            }
          }}
        >
          <rect className="nv-cell-frame" x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={4} />
          <text className="nv-cell-header-label" x={rect.x + 8} y={rect.y + 14}>
            {truncate(folderName(folder), 30)} · {folder.noteCount}
          </text>
        </g>
        {innerCells.map((cell) =>
          cell.kind === 'folder' ? renderFolder(cell.folder, cell.rect, 1) : renderNote(cell.note, cell.rect, true),
        )}
      </g>
    );
  }

  function renderTop(cell: TreemapCell): React.JSX.Element {
    return cell.kind === 'folder' ? renderFolder(cell.folder, cell.rect, 0) : renderNote(cell.note, cell.rect, false);
  }

  return (
    <div className="network-view map-view">
      <nav className="nv-crumbs" aria-label={copy.network.mapView.breadcrumbLabel}>
        {crumbs.map((folder, i) => (
          <span key={folder.path}>
            {i > 0 && <span aria-hidden> › </span>}
            <button
              type="button"
              className="nv-crumb"
              aria-current={folder.path === current.path ? 'true' : undefined}
              disabled={folder.path === current.path}
              onClick={() => setZoomPath(folder.path)}
            >
              {folderName(folder)}
            </button>
          </span>
        ))}
      </nav>

      <div className="nv-map">
        <div className="nv-treemap-frame" ref={frameRef}>
          <svg viewBox={`0 0 ${viewW} ${viewH}`} role="group" aria-label={folderName(current)}>
            {cells.map((cell) => renderTop(cell))}
          </svg>
        </div>

        <div className="nv-hover-panel" aria-live="polite">
          {hover ? (
            <>
              <span className="nv-hover-title">{hover.title}</span>
              <span className="nv-hover-stats">
                <span>{copy.network.mapView.notes(hover.notes)}</span>
                <span>{copy.network.mapView.links(hover.links)}</span>
                <span>
                  {copy.network.mapView.updated}: {hover.lastUpdated > 0 ? absoluteTime(hover.lastUpdated) : '—'}
                </span>
              </span>
            </>
          ) : (
            <span>{copy.network.mapView.hoverHint}</span>
          )}
        </div>
      </div>
    </div>
  );
}
