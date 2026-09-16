/**
 * The network as a treemap of the folder structure.
 *
 * Where the graph shows shape and the list shows facts, this shows scale: which
 * parts of the vault are big, and which of them have been alive lately. Area is
 * note count, nested by folder (`10_Projects` → `11_Active` → …); warmth is the
 * share of a folder's notes touched in the last two weeks, the same window the
 * brain view warms a note's halo over.
 *
 * The layout itself (`./treemap`) is a pure function with no DOM in it. What is
 * here is the part that genuinely needs React: owning the zoom level, drawing
 * the rects it is handed, and turning pointer/keyboard input into a zoom or an
 * `onOpen`.
 */

import { useMemo, useState } from 'react';

import type { GraphData } from '../api';
import { copy } from '../copy';
import { displayName } from '../Tree';
import { absoluteTime } from './relativeTime';
import type { FolderNode, MapNode, Rect, TreemapCell } from './treemap';
import { buildFolderTree, findFolder, folderWarmth, layoutFolder, noteWarmth } from './treemap';
import './network.css';

/** The viewBox the treemap is laid out into; SVG scales it to the container. */
const VIEW_W = 1000;
const VIEW_H = 620;
const GAP = 3;

function shrink(rect: Rect, by: number): Rect {
  const w = Math.max(0, rect.w - by * 2);
  const h = Math.max(0, rect.h - by * 2);
  return { x: rect.x + by, y: rect.y + by, w, h };
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
 * the strong warm tint for folders genuinely concentrated with recent work,
 * and the 55% cap keeps even a fully warm cell readable as a tinted surface
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

interface HoverInfo {
  title: string;
  notes: number;
  links: number;
  lastUpdated: number;
}

export function MapView(props: { graph: GraphData; onOpen: (owner: string, path: string) => void }): React.JSX.Element {
  const { graph, onOpen } = props;

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
  const bounds: Rect = { x: 0, y: 0, w: VIEW_W, h: VIEW_H };
  // `bounds` is a fresh object every render but a fixed value, so only the
  // folder actually shown needs to trigger a relayout.
  const cells = useMemo(
    () => layoutFolder(current, bounds).map((cell) => ({ ...cell, rect: shrink(cell.rect, GAP / 2) })),
    [current],
  );

  const crumbs: FolderNode[] = [root];
  if (zoomPath !== '') {
    const segments = zoomPath.split('/');
    for (let i = 0; i < segments.length; i += 1) {
      const found = findFolder(root, segments.slice(0, i + 1).join('/'));
      if (found) crumbs.push(found);
    }
  }

  const showHover = (cell: TreemapCell): void => {
    if (cell.kind === 'folder') {
      setHover({
        title: folderName(cell.folder),
        notes: cell.folder.noteCount,
        links: cell.folder.linkTotal,
        lastUpdated: cell.folder.lastUpdated,
      });
    } else {
      setHover({
        title: cell.note.title,
        notes: 1,
        links: cell.note.links,
        lastUpdated: cell.note.updatedAt,
      });
    }
  };

  const activate = (cell: TreemapCell): void => {
    if (cell.kind === 'folder') setZoomPath(cell.folder.path);
    else onOpen(cell.note.owner, cell.note.path);
  };

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
        <div className="nv-treemap-frame">
          <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="group" aria-label={folderName(current)}>
            {cells.map((cell) => {
              const key = cell.kind === 'folder' ? `f:${cell.folder.path}` : `n:${cell.note.owner}/${cell.note.path}`;
              const warmth = cell.kind === 'folder' ? folderWarmth(cell.folder) : noteWarmth(cell.note.updatedAt);
              const label = cell.kind === 'folder' ? folderName(cell.folder) : cell.note.title;
              const subLabel = cell.kind === 'folder' ? copy.network.mapView.notes(cell.folder.noteCount) : null;
              const showLabel = cell.rect.w > 42 && cell.rect.h > 20;
              const showSub = subLabel !== null && cell.rect.w > 42 && cell.rect.h > 34;
              const a11yLabel =
                cell.kind === 'folder'
                  ? copy.network.mapView.folderLabel(folderName(cell.folder), cell.folder.noteCount)
                  : copy.network.mapView.noteLabel(cell.note.title);
              return (
                <g
                  key={key}
                  tabIndex={0}
                  role="button"
                  aria-label={a11yLabel}
                  onMouseEnter={() => showHover(cell)}
                  onFocus={() => showHover(cell)}
                  onMouseLeave={() => setHover(null)}
                  onBlur={() => setHover(null)}
                  onClick={() => activate(cell)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      activate(cell);
                    }
                  }}
                >
                  <rect
                    className="nv-cell-rect"
                    data-kind={cell.kind}
                    x={cell.rect.x}
                    y={cell.rect.y}
                    width={cell.rect.w}
                    height={cell.rect.h}
                    style={{ fill: warmthColour(warmth) }}
                  />
                  {showLabel && (
                    <text className="nv-cell-label" x={cell.rect.x + 6} y={cell.rect.y + 14}>
                      {label.length > 24 ? `${label.slice(0, 23)}…` : label}
                    </text>
                  )}
                  {showSub && subLabel !== null && (
                    <text className="nv-cell-sub" x={cell.rect.x + 6} y={cell.rect.y + 27}>
                      {subLabel}
                    </text>
                  )}
                </g>
              );
            })}
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
