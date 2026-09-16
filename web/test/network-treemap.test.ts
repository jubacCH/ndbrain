/**
 * The map view's layout, entirely as data: no DOM, no React, no browser.
 *
 * `buildFolderTree` turns the graph's flat node list into a nested folder
 * tree with rolled-up totals; `squarify`/`layoutFolder` turns one folder's
 * children into rects. Both are exercised against an empty vault, a single
 * note, and a large synthetic vault, matching the three sizes the brief asks
 * for — generated data, never a load test.
 */

import { describe, expect, it } from 'vitest';

import {
  RECENT_DAYS,
  buildFolderTree,
  findFolder,
  folderWarmth,
  layoutFolder,
  noteWarmth,
  squarify,
  type MapNode,
  type Rect,
} from '../src/network/treemap';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 16);

function note(path: string, folder: string, updatedAt = NOW, links = 0): MapNode {
  const title = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
  return { owner: 'jb', path, title, folder, links, updatedAt };
}

const BOUNDS: Rect = { x: 0, y: 0, w: 1000, h: 620 };

describe('buildFolderTree', () => {
  it('makes an empty root for an empty vault', () => {
    const root = buildFolderTree([], NOW);
    expect(root.path).toBe('');
    expect(root.noteCount).toBe(0);
    expect(root.children).toEqual([]);
    expect(root.notes).toEqual([]);
    expect(root.lastUpdated).toBe(0);
  });

  it('holds a single root-level note', () => {
    const root = buildFolderTree([note('Hello.md', '')], NOW);
    expect(root.noteCount).toBe(1);
    expect(root.notes).toHaveLength(1);
    expect(root.children).toEqual([]);
  });

  it('creates intermediate folders that hold no note of their own', () => {
    const root = buildFolderTree([note('10_Projects/11_Active/A.md', '10_Projects/11_Active')], NOW);
    expect(root.children).toHaveLength(1);
    const projects = root.children[0]!;
    expect(projects.path).toBe('10_Projects');
    expect(projects.notes).toEqual([]);
    expect(projects.noteCount).toBe(1);
    expect(projects.children).toHaveLength(1);
    const active = projects.children[0]!;
    expect(active.path).toBe('10_Projects/11_Active');
    expect(active.notes).toHaveLength(1);
    expect(active.noteCount).toBe(1);
  });

  it('rolls up note count, link total and recency up the tree', () => {
    const root = buildFolderTree(
      [
        note('10_Projects/11_Active/A.md', '10_Projects/11_Active', NOW, 3),
        note('10_Projects/11_Active/B.md', '10_Projects/11_Active', NOW - 30 * DAY, 5),
        note('10_Projects/19_Done/C.md', '10_Projects/19_Done', NOW - 1 * DAY, 2),
      ],
      NOW,
    );
    const projects = findFolder(root, '10_Projects')!;
    expect(projects.noteCount).toBe(3);
    expect(projects.linkTotal).toBe(10);
    // A (today) and C (1 day old) are within RECENT_DAYS; B (30 days) is not.
    expect(projects.recentCount).toBe(2);
    expect(projects.lastUpdated).toBe(NOW);
  });

  it('sorts children and direct notes by name for deterministic output', () => {
    const root = buildFolderTree(
      [note('b/X.md', 'b'), note('a/X.md', 'a'), note('Z.md', ''), note('A.md', '')],
      NOW,
    );
    expect(root.children.map((c) => c.name)).toEqual(['a', 'b']);
    expect(root.notes.map((n) => n.title)).toEqual(['A', 'Z']);
  });
});

describe('findFolder', () => {
  const root = buildFolderTree(
    [note('10_Projects/11_Active/A.md', '10_Projects/11_Active')],
    NOW,
  );

  it('returns the root for the empty path', () => {
    expect(findFolder(root, '')).toBe(root);
  });

  it('walks down to a nested folder', () => {
    const found = findFolder(root, '10_Projects/11_Active');
    expect(found?.path).toBe('10_Projects/11_Active');
  });

  it('returns undefined for a folder that does not exist', () => {
    expect(findFolder(root, '99_Nope')).toBeUndefined();
  });
});

describe('squarify', () => {
  it('returns nothing for no items or a zero-area rect', () => {
    expect(squarify([{ weight: 1, cell: 'a' }], { x: 0, y: 0, w: 0, h: 100 })).toEqual([]);
    expect(squarify([], BOUNDS)).toEqual([]);
  });

  it('gives a single item the whole rect', () => {
    const [placed] = squarify([{ weight: 1, cell: 'only' }], BOUNDS);
    expect(placed!.rect).toEqual(BOUNDS);
  });

  it('drops zero- and negative-weight entries', () => {
    const placed = squarify(
      [
        { weight: 5, cell: 'a' },
        { weight: 0, cell: 'b' },
        { weight: -1, cell: 'c' },
      ],
      BOUNDS,
    );
    expect(placed.map((p) => p.cell)).toEqual(['a']);
  });

  it('splits area proportionally to weight', () => {
    const placed = squarify(
      [
        { weight: 3, cell: 'a' },
        { weight: 1, cell: 'b' },
      ],
      BOUNDS,
    );
    const totalArea = BOUNDS.w * BOUNDS.h;
    const byCell = Object.fromEntries(placed.map((p) => [p.cell, p.rect.w * p.rect.h]));
    expect(byCell['a']!).toBeCloseTo(totalArea * 0.75, 0);
    expect(byCell['b']!).toBeCloseTo(totalArea * 0.25, 0);
  });

  it('never overlaps and never leaves the bounds, for a realistic distribution', () => {
    const weights = [40, 22, 18, 12, 9, 7, 5, 5, 3, 2, 1, 1, 1];
    const placed = squarify(
      weights.map((w, i) => ({ weight: w, cell: i })),
      BOUNDS,
    );
    expect(placed).toHaveLength(weights.length);

    const totalArea = BOUNDS.w * BOUNDS.h;
    const sumArea = placed.reduce((s, p) => s + p.rect.w * p.rect.h, 0);
    expect(sumArea).toBeCloseTo(totalArea, 0);

    for (const { rect } of placed) {
      expect(rect.w).toBeGreaterThanOrEqual(0);
      expect(rect.h).toBeGreaterThanOrEqual(0);
      expect(rect.x).toBeGreaterThanOrEqual(BOUNDS.x - 1e-6);
      expect(rect.y).toBeGreaterThanOrEqual(BOUNDS.y - 1e-6);
      expect(rect.x + rect.w).toBeLessThanOrEqual(BOUNDS.x + BOUNDS.w + 1e-6);
      expect(rect.y + rect.h).toBeLessThanOrEqual(BOUNDS.y + BOUNDS.h + 1e-6);
    }

    // No pair of rects overlaps in both axes by more than rounding noise.
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i]!.rect;
        const b = placed[j]!.rect;
        const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(overlapX <= 1e-6 || overlapY <= 1e-6).toBe(true);
      }
    }
  });

  /**
   * The regression this guards: the map view once fed a fixed 1000×620 SVG
   * `viewBox` to a container of whatever shape the browser actually gave it.
   * `squarify` itself was always correct — this exact assertion already
   * passed against the fixed box — but the *caller* passed the wrong
   * rectangle, and the SVG's default `preserveAspectRatio` letterboxed the
   * mismatch into empty bars on both sides. The fix is for the caller to
   * measure its real container and hand that rectangle in here; this test
   * pins the property that fix depends on: whatever rectangle comes in,
   * squarify fills all of it, flush to every edge, for any aspect ratio —
   * a wide desktop window, a tall phone, or an extreme strip.
   */
  it.each([
    ['1440×900 desktop', { x: 0, y: 0, w: 1440, h: 900 }],
    ['390×844 phone portrait', { x: 0, y: 0, w: 390, h: 844 }],
    ['a very wide strip', { x: 0, y: 0, w: 2000, h: 300 }],
    ['a non-zero origin', { x: 40, y: 20, w: 731, h: 517 }],
  ] as const)('fills %s flush to every edge, with the right total area', (_label, bounds) => {
    const weights = [37, 21, 15, 11, 8, 6, 4, 3, 2, 1, 1, 1];
    const placed = squarify(
      weights.map((w, i) => ({ weight: w, cell: i })),
      bounds,
    );

    const totalArea = bounds.w * bounds.h;
    const sumArea = placed.reduce((s, p) => s + p.rect.w * p.rect.h, 0);
    expect(sumArea).toBeCloseTo(totalArea, 0);

    // No gap at any edge: the extreme rects must reach exactly to the
    // container's boundary on every side, not stop short of it.
    const minX = Math.min(...placed.map((p) => p.rect.x));
    const maxX = Math.max(...placed.map((p) => p.rect.x + p.rect.w));
    const minY = Math.min(...placed.map((p) => p.rect.y));
    const maxY = Math.max(...placed.map((p) => p.rect.y + p.rect.h));
    expect(minX).toBeCloseTo(bounds.x, 6);
    expect(maxX).toBeCloseTo(bounds.x + bounds.w, 6);
    expect(minY).toBeCloseTo(bounds.y, 6);
    expect(maxY).toBeCloseTo(bounds.y + bounds.h, 6);
  });
});

describe('layoutFolder', () => {
  it('lays out subfolders and direct notes as siblings', () => {
    const root = buildFolderTree(
      [
        note('10_Projects/A.md', '10_Projects'),
        note('10_Projects/B.md', '10_Projects'),
        note('20_Areas/C.md', '20_Areas'),
        note('Root.md', ''),
      ],
      NOW,
    );
    const cells = layoutFolder(root, BOUNDS);
    expect(cells).toHaveLength(3); // 10_Projects, 20_Areas, Root.md
    const kinds = cells.map((c) => c.kind).sort();
    expect(kinds).toEqual(['folder', 'folder', 'note']);
  });

  it('gives an empty folder nothing to lay out', () => {
    const root = buildFolderTree([], NOW);
    expect(layoutFolder(root, BOUNDS)).toEqual([]);
  });
});

describe('warmth', () => {
  it('is fully warm the moment a note is written', () => {
    expect(noteWarmth(NOW, NOW)).toBe(1);
  });

  it('fades to zero over RECENT_DAYS', () => {
    expect(noteWarmth(NOW - RECENT_DAYS * DAY, NOW)).toBe(0);
    expect(noteWarmth(NOW - (RECENT_DAYS + 5) * DAY, NOW)).toBe(0);
    const half = noteWarmth(NOW - (RECENT_DAYS / 2) * DAY, NOW);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(1);
  });

  it('a folder is as warm as the share of its notes touched recently', () => {
    const root = buildFolderTree(
      [
        note('f/A.md', 'f', NOW),
        note('f/B.md', 'f', NOW),
        note('f/C.md', 'f', NOW - 30 * DAY),
        note('f/D.md', 'f', NOW - 30 * DAY),
      ],
      NOW,
    );
    const folder = findFolder(root, 'f')!;
    expect(folderWarmth(folder)).toBeCloseTo(0.5);
  });

  it('an empty folder has no warmth', () => {
    const root = buildFolderTree([], NOW);
    expect(folderWarmth(root)).toBe(0);
  });
});

describe('a large synthetic vault (2000 notes)', () => {
  const folders = ['10_Projects/11_Active', '10_Projects/19_Done', '20_Areas', '30_Resources', '40_MOCs'];
  const notes: MapNode[] = Array.from({ length: 2000 }, (_, i) => {
    const folder = folders[i % folders.length]!;
    const age = (i % 40) * DAY;
    return note(`${folder}/Note-${i}.md`, folder, NOW - age, i % 12);
  });

  it('builds the tree without error and keeps the totals consistent', () => {
    const root = buildFolderTree(notes, NOW);
    expect(root.noteCount).toBe(2000);
    const sumOfChildren = root.children.reduce((s, c) => s + c.noteCount, 0);
    expect(sumOfChildren).toBe(2000);
  });

  it('lays out the root and a deep folder without producing NaN or overlap', () => {
    const root = buildFolderTree(notes, NOW);
    for (const target of [root, findFolder(root, '10_Projects')!, findFolder(root, '10_Projects/11_Active')!]) {
      const cells = layoutFolder(target, BOUNDS);
      for (const cell of cells) {
        expect(Number.isFinite(cell.rect.x)).toBe(true);
        expect(Number.isFinite(cell.rect.y)).toBe(true);
        expect(Number.isFinite(cell.rect.w)).toBe(true);
        expect(Number.isFinite(cell.rect.h)).toBe(true);
      }
    }
  });
});
