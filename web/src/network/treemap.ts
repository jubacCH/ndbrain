/**
 * A squarified treemap, and the folder tree it lays out.
 *
 * No library: the treemap is one well-known algorithm (Bruls/Huizing/van Wijk,
 * "Squarified Treemaps") applied to a folder hierarchy built from the graph's
 * flat node list. Both halves are pure — no DOM, no React — so they can be
 * tested as data in, rects out.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A note in the graph, stripped to what the map needs. */
export interface MapNode {
  owner: string;
  path: string;
  title: string;
  folder: string;
  links: number;
  updatedAt: number;
}

/** One folder, with every note beneath it rolled up into its totals. */
export interface FolderNode {
  /** Whose vault the folder is in. */
  owner: string;
  /** Path inside that vault, `''` for a vault's root. */
  path: string;
  /** The last segment of `path`; at a vault's root, `''` for your own and the owner for another's. */
  name: string;
  /**
   * The identity across vaults — see `folderKey`. Two owners can each have a
   * `10_Projects`, and those are two folders, not one.
   */
  key: string;
  /** True for the root of somebody else's vault, shown as a folder of its own. */
  vault: boolean;
  children: FolderNode[];
  /** Notes directly in this folder — not in any child folder. */
  notes: MapNode[];
  /** Every note in this folder and everything beneath it. */
  noteCount: number;
  /** Sum of `links` over the same set — a coarse "how connected" per folder. */
  linkTotal: number;
  /** How many of those notes were touched in the last `RECENT_DAYS` days. */
  recentCount: number;
  /** The most recent `updatedAt` in the subtree, or 0 for an empty one. */
  lastUpdated: number;
}

/** Same window the brain view warms a note's halo over — see `brain/scene.ts`. */
export const RECENT_DAYS = 14;

/** A folder's identity: owner and path together, joined so that neither can forge the other. */
export function folderKey(owner: string, path: string): string {
  return JSON.stringify([owner, path]);
}

function emptyFolder(owner: string, path: string, vault = false): FolderNode {
  const cut = path.lastIndexOf('/');
  return {
    owner,
    path,
    name: vault ? owner : cut === -1 ? path : path.slice(cut + 1),
    key: folderKey(owner, path),
    vault,
    children: [],
    notes: [],
    noteCount: 0,
    linkTotal: 0,
    recentCount: 0,
    lastUpdated: 0,
  };
}

/**
 * The folder tree for a graph's nodes, with every folder's totals already
 * rolled up from its descendants.
 *
 * Intermediate folders that hold no note of their own but do hold a
 * subfolder — `10_Projects` above `10_Projects/11_Active` — are created too,
 * so the nesting in the map matches the nesting on disk rather than skipping
 * straight to the first folder with a note in it.
 *
 * `self` is the vault the root stands for. Every other owner's notes sit in a
 * folder of their own directly under the root, named after the owner, so a
 * shared `10_Projects` never merges with yours. Left out, a graph with a
 * single owner is that owner's vault, and one with several has no root vault
 * and shows every owner as a folder.
 */
export function buildFolderTree(nodes: readonly MapNode[], now: number = Date.now(), self?: string): FolderNode {
  const owners = new Set(nodes.map((n) => n.owner));
  const me = self ?? (owners.size === 1 ? [...owners][0]! : '');
  const root = emptyFolder(me, '');
  const byKey = new Map<string, FolderNode>([[root.key, root]]);

  const vaultOf = (owner: string): FolderNode => {
    if (owner === me) return root;
    const existing = byKey.get(folderKey(owner, ''));
    if (existing) return existing;
    const node = emptyFolder(owner, '', true);
    root.children.push(node);
    byKey.set(node.key, node);
    return node;
  };

  const folderOf = (owner: string, path: string): FolderNode => {
    if (path === '') return vaultOf(owner);
    const existing = byKey.get(folderKey(owner, path));
    if (existing) return existing;
    const cut = path.lastIndexOf('/');
    const parent = folderOf(owner, cut === -1 ? '' : path.slice(0, cut));
    const node = emptyFolder(owner, path);
    parent.children.push(node);
    byKey.set(node.key, node);
    return node;
  };

  for (const note of nodes) {
    folderOf(note.owner, note.folder).notes.push(note);
  }

  const rollUp = (folder: FolderNode): void => {
    // Your own folders first, then the other vaults; each group by name.
    folder.children.sort((a, b) => Number(a.vault) - Number(b.vault) || a.name.localeCompare(b.name));
    folder.notes.sort((a, b) => a.title.localeCompare(b.title));
    let count = folder.notes.length;
    let links = folder.notes.reduce((sum, n) => sum + n.links, 0);
    let recent = folder.notes.filter((n) => now - n.updatedAt <= RECENT_DAYS * 86_400_000).length;
    let last = folder.notes.reduce((max, n) => Math.max(max, n.updatedAt), 0);
    for (const child of folder.children) {
      rollUp(child);
      count += child.noteCount;
      links += child.linkTotal;
      recent += child.recentCount;
      last = Math.max(last, child.lastUpdated);
    }
    folder.noteCount = count;
    folder.linkTotal = links;
    folder.recentCount = recent;
    folder.lastUpdated = last;
  };
  rollUp(root);
  return root;
}

/**
 * A folder by path and owner, walking down from the root.
 *
 * `owner` defaults to the root's own vault; another owner's folders are found
 * under that owner's vault folder.
 */
export function findFolder(root: FolderNode, path: string, owner: string = root.owner): FolderNode | undefined {
  let node: FolderNode | undefined =
    owner === root.owner ? root : root.children.find((c) => c.vault && c.owner === owner);
  if (node === undefined || path === '') return node;
  const segments = path.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const want = segments.slice(0, i + 1).join('/');
    const next: FolderNode | undefined = node.children.find((c) => !c.vault && c.path === want);
    if (!next) return undefined;
    node = next;
  }
  return node;
}

/** One cell of a laid-out treemap: either a subfolder or a single note. */
export type TreemapCell =
  | { kind: 'folder'; folder: FolderNode; weight: number; rect: Rect }
  | { kind: 'note'; note: MapNode; weight: number; rect: Rect };

/**
 * The immediate children of `folder` — its subfolders and its own direct
 * notes, as siblings — squarified into `bounds`.
 *
 * A subfolder's weight is its total note count so the map's area rule ("area
 * proportional to note count") holds at every level, not only at the leaves. A
 * loose note directly in the folder weighs 1, the same as a folder holding
 * exactly one note — visually consistent, since that is what it is.
 */
export function layoutFolder(folder: FolderNode, bounds: Rect): TreemapCell[] {
  const entries: Array<{ weight: number; cell: Omit<TreemapCell, 'rect'> }> = [
    ...folder.children.map((child) => ({
      weight: child.noteCount,
      cell: { kind: 'folder' as const, folder: child, weight: child.noteCount },
    })),
    ...folder.notes.map((note) => ({
      weight: 1,
      cell: { kind: 'note' as const, note, weight: 1 },
    })),
  ];
  const placed = squarify(entries, bounds);
  return placed.map(({ cell, rect }) => ({ ...cell, rect }) as TreemapCell);
}

/* ---- the squarify algorithm, generic over the payload ------------------- */

interface Weighted<T> {
  weight: number;
  cell: T;
}

/**
 * Lays weighted items out into `bounds` so that, row by row, each row's boxes
 * stay as close to square as the remaining space allows — the "squarified"
 * refinement over a plain slice-and-dice treemap, which degenerates into thin
 * slivers once there are more than a handful of items.
 */
export function squarify<T>(
  entries: ReadonlyArray<Weighted<T>>,
  bounds: Rect,
): Array<{ cell: T; rect: Rect }> {
  const items = entries.filter((e) => e.weight > 0).sort((a, b) => b.weight - a.weight);
  if (items.length === 0 || bounds.w <= 0 || bounds.h <= 0) return [];

  const totalWeight = items.reduce((sum, e) => sum + e.weight, 0);
  const totalArea = bounds.w * bounds.h;
  const scaled = items.map((e) => ({ cell: e.cell, area: (e.weight / totalWeight) * totalArea }));

  const out: Array<{ cell: T; rect: Rect }> = [];
  layoutRow(scaled, bounds, out);
  return out;
}

interface Scaled<T> {
  cell: T;
  area: number;
}

function layoutRow<T>(items: Array<Scaled<T>>, bounds: Rect, out: Array<{ cell: T; rect: Rect }>): void {
  if (items.length === 0 || bounds.w <= 0 || bounds.h <= 0) return;

  const side = Math.min(bounds.w, bounds.h);
  let row = [items[0]!];
  let i = 1;
  while (i < items.length) {
    const candidate = [...row, items[i]!];
    // Growing the row is worth it only while it keeps boxes closer to square.
    if (worst(candidate, side) <= worst(row, side)) {
      row = candidate;
      i += 1;
    } else {
      break;
    }
  }

  const remainder = placeRow(row, bounds, out);
  layoutRow(items.slice(row.length), remainder, out);
}

/** The worst (largest) aspect ratio any box in `row` would have at this `side`. */
function worst<T>(row: Array<Scaled<T>>, side: number): number {
  const sum = row.reduce((s, r) => s + r.area, 0);
  if (sum <= 0) return Infinity;
  let max = -Infinity;
  let min = Infinity;
  for (const r of row) {
    if (r.area > max) max = r.area;
    if (r.area < min) min = r.area;
  }
  const sideSq = side * side;
  const sumSq = sum * sum;
  return Math.max((sideSq * max) / sumSq, sumSq / (sideSq * min));
}

/** Places one row along the shorter side of `bounds`; returns what is left over. */
function placeRow<T>(row: Array<Scaled<T>>, bounds: Rect, out: Array<{ cell: T; rect: Rect }>): Rect {
  const rowArea = row.reduce((s, r) => s + r.area, 0);
  const layDown = bounds.w >= bounds.h;

  if (layDown) {
    const colWidth = rowArea / bounds.h;
    let y = bounds.y;
    for (const r of row) {
      const h = r.area / colWidth;
      out.push({ cell: r.cell, rect: { x: bounds.x, y, w: colWidth, h } });
      y += h;
    }
    return { x: bounds.x + colWidth, y: bounds.y, w: Math.max(0, bounds.w - colWidth), h: bounds.h };
  }

  const rowHeight = rowArea / bounds.w;
  let x = bounds.x;
  for (const r of row) {
    const w = r.area / rowHeight;
    out.push({ cell: r.cell, rect: { x, y: bounds.y, w, h: rowHeight } });
    x += w;
  }
  return { x: bounds.x, y: bounds.y + rowHeight, w: bounds.w, h: Math.max(0, bounds.h - rowHeight) };
}

/**
 * A 0..1 warmth for a single note's age — 1 the day it was last touched,
 * fading to 0 by `RECENT_DAYS` later. The same shape as the brain view's
 * accent (`brain/scene.ts`), reimplemented locally rather than imported so
 * this module stays free of the canvas renderer's own concerns.
 */
export function noteWarmth(updatedAt: number, now: number = Date.now()): number {
  const days = (now - updatedAt) / 86_400_000;
  if (days <= 0) return 1;
  if (days >= RECENT_DAYS) return 0;
  return 1 - days / RECENT_DAYS;
}

/** A folder's warmth: the share of its notes touched in the last `RECENT_DAYS`. */
export function folderWarmth(folder: FolderNode): number {
  if (folder.noteCount === 0) return 0;
  return folder.recentCount / folder.noteCount;
}
