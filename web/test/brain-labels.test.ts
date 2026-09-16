/**
 * Region names: next to their own region, or not at all.
 *
 * Every test here checks a whole placement against the rules a wrong one breaks,
 * on the real vault's structure, in several canvas sizes — so a change to the
 * layout, a new region name or a different number of regions shows up as a
 * failing rule rather than as a screenshot somebody has to notice.
 */

import { describe, expect, it } from 'vitest';

import { blockedAround } from '../src/brain/blocked';
import type { Camera } from '../src/brain/camera';
import { fit } from '../src/brain/camera';
import type { PlacedLabel, Rect } from '../src/brain/labels';
import { breakName, overlaps, placeRegionNames, polylinesCross, sampleLeader } from '../src/brain/labels';
import { BrainLayout } from '../src/brain/layout';
import { buildGraph } from '../src/brain/model';
import type { RegionAnchor } from '../src/brain/regions';
import { regionAnchors, regionView } from '../src/brain/regions';
import { paraVault } from './fixtures/para-vault';

const vault = paraVault();
const graph = buildGraph(vault.data, { tags: vault.tags });
const layout = new BrainLayout(graph, { arrangement: 'brain' });
layout.settle();
const view = regionView(layout);
const anchors = regionAnchors(view, layout.x, layout.y);

/** A stand-in for `measureText` at 13px: wide enough to be honest about room. */
const measure = (text: string): number => text.length * 7;

/** The same inset the full network view keeps for its controls. */
const INSET = { top: 20, right: 20, bottom: 56, left: 20 };

/** Canvas sizes of the three window widths the view is checked in, plus the side panel. */
const SIZES = {
  normal: { width: 1154, height: 833 },
  narrow: { width: 720, height: 833 },
  wide: { width: 1620, height: 833 },
  panel: { width: 340, height: 260 },
} as const;

/** The legend top right, the footer bottom centre, the decoration note bottom left. */
const controls = (width: number, height: number): Rect[] => [
  { x: width - 186, y: 12, w: 174, h: 80 },
  { x: width / 2 - 270, y: height - 48, w: 540, h: 36 },
  { x: 12, y: height - 36, w: 230, h: 22 },
];

function place(
  size: { width: number; height: number },
  blocked: readonly Rect[] = controls(size.width, size.height),
  from: readonly RegionAnchor[] = anchors,
): { names: PlacedLabel[]; camera: Camera } {
  const camera = fit(layout.bounds, size.width, size.height, INSET);
  const names = placeRegionNames(from, camera, size.width, size.height, blocked, view.inside, measure);
  return { names, camera };
}

const toScreen = (camera: Camera, x: number, y: number): { x: number; y: number } => ({
  x: x * camera.scale + camera.x,
  y: y * camera.scale + camera.y,
});

/** Every rule a placement must keep, checked one by one so a failure names the rule. */
function expectValid(
  names: readonly PlacedLabel[],
  camera: Camera,
  size: { width: number; height: number },
  blocked: readonly Rect[],
  from: readonly RegionAnchor[] = anchors,
): void {
  const byRegion = new Map(from.map((a) => [a.region, a]));
  const fissure = toScreen(camera, from[0]!.fissureX, 0).x;
  const brainWidth = (layout.bounds.maxX - layout.bounds.minX) * camera.scale;

  for (const label of names) {
    const a = byRegion.get(label.region)!;
    const name = a.text;
    const { box } = label;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;

    // Not clipped.
    expect(box.x, `${name} runs off the left`).toBeGreaterThanOrEqual(0);
    expect(box.y, `${name} runs off the top`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.w, `${name} runs off the right`).toBeLessThanOrEqual(size.width);
    expect(box.y + box.h, `${name} runs off the bottom`).toBeLessThanOrEqual(size.height);

    // Clear of every control.
    for (const b of blocked) expect(overlaps(box, b), `${name} is under a control`).toBe(false);

    // Off the tissue.
    for (let i = 0; i <= 6; i += 1) {
      for (let j = 0; j <= 3; j += 1) {
        const sx = box.x + (box.w * i) / 6;
        const sy = box.y + (box.h * j) / 3;
        const w = { x: (sx - camera.x) / camera.scale, y: (sy - camera.y) / camera.scale };
        expect(view.inside(w.x, w.y), `${name} is written on the tissue`).toBe(false);
      }
    }

    // On its region's side of the fissure.
    expect((cx - fissure) * a.side, `${name} is on the other hemisphere`).toBeGreaterThan(0);

    // Next to its region: outward from the note its leader starts at, and not
    // further than a third of the brain away from it.
    const anchor = toScreen(camera, a.anchorX, a.anchorY);
    expect((cx - anchor.x) * a.dirX + (cy - anchor.y) * a.dirY, `${name} points back into the brain`).toBeGreaterThan(0);
    expect(Math.hypot(label.toX - anchor.x, label.toY - anchor.y), `${name} is far from its region`).toBeLessThan(
      brainWidth / 3,
    );
    expect(label.fromX).toBeCloseTo(anchor.x, 6);
    expect(label.fromY).toBeCloseTo(anchor.y, 6);
  }

  // No two names overlap, and no two leaders cross.
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const a = names[i]!;
      const b = names[j]!;
      expect(overlaps(a.box, b.box), `names of regions ${a.region} and ${b.region} overlap`).toBe(false);
      expect(polylinesCross(sampleLeader(a), sampleLeader(b)), `leaders of ${a.region} and ${b.region} cross`).toBe(
        false,
      );
    }
  }
}

describe('where a region is named', () => {
  for (const [label, size] of Object.entries(SIZES)) {
    it(`keeps every rule in a ${label} canvas (${size.width} × ${size.height})`, () => {
      const blocked = controls(size.width, size.height);
      const { names, camera } = place(size, blocked);
      expectValid(names, camera, size, blocked);
    });
  }

  it('names every region when there is room for it', () => {
    const { names } = place(SIZES.wide);
    expect(names.length).toBe(anchors.length);
  });

  it('names a region against the fissure above or below the brain, not on the far flank', () => {
    const medial = anchors.filter((a) => a.medial);
    expect(medial.length).toBeGreaterThan(0);
    const { names, camera } = place(SIZES.wide);
    for (const a of medial) {
      const label = names.find((n) => n.region === a.region);
      if (label === undefined) continue;
      const region = view.regions.find((r) => r.id === a.region)!;
      let top = Infinity;
      let bottom = -Infinity;
      for (const i of region.members) {
        top = Math.min(top, toScreen(camera, 0, layout.y[i]!).y);
        bottom = Math.max(bottom, toScreen(camera, 0, layout.y[i]!).y);
      }
      const box = label.box;
      expect(box.y + box.h <= top || box.y >= bottom, `${a.text} is beside its notes, not above or below`).toBe(true);
    }
  });

  it('moves a name out of a control laid where it would have gone', () => {
    const size = SIZES.normal;
    const open = place(size, []);
    const first = open.names[0]!;
    // A control exactly where that name was written, a little larger.
    const control = { x: first.box.x - 10, y: first.box.y - 10, w: first.box.w + 20, h: first.box.h + 20 };
    const blocked = [control];
    const { names, camera } = place(size, blocked);
    expectValid(names, camera, size, blocked);
    const moved = names.find((n) => n.region === first.region);
    if (moved !== undefined) expect(overlaps(moved.box, control)).toBe(false);
  });

  it('leaves a name out rather than squeeze it into a canvas with no room for it', () => {
    const size = SIZES.panel;
    const blocked = controls(size.width, size.height);
    const { names, camera } = place(size, blocked);
    expect(names.length).toBeLessThan(anchors.length);
    expectValid(names, camera, size, blocked);
  });

  it('does not depend on what the regions are called or how many there are', () => {
    const renamed = anchors
      .filter((_, k) => k % 2 === 0)
      .map((a, k) => ({ ...a, text: ['A', 'Rather Long Region Name', 'Mid Name', 'X Y Z W'][k % 4]! }));
    for (const size of [SIZES.normal, SIZES.narrow]) {
      const blocked = controls(size.width, size.height);
      const { names, camera } = place(size, blocked, renamed);
      expectValid(names, camera, size, blocked, renamed);
    }
  });

  it('gives the same answer every time', () => {
    const a = place(SIZES.normal).names.map((n) => [n.region, n.box.x, n.box.y]);
    const b = place(SIZES.normal).names.map((n) => [n.region, n.box.x, n.box.y]);
    expect(b).toEqual(a);
  });
});

describe('breaking a name over two lines', () => {
  const wide = (s: string): number => s.length * 7;

  it('keeps a short name on one line', () => {
    expect(breakName('Homelab', wide, 118)).toEqual(['Homelab']);
  });

  it('breaks where a person would, into two lines of about equal width', () => {
    expect(breakName('Knowledge Management', wide, 118)).toEqual(['Knowledge', 'Management']);
    // The most even split by the wider line: 10 and 18 characters beats 19 and 9.
    expect(breakName('Selfhosted Services and Tools', wide, 118)).toEqual(['Selfhosted', 'Services and Tools']);
  });

  it('breaks before an ampersand, not after it', () => {
    expect(breakName('Ideas & Concepts', wide, 60)).toEqual(['Ideas', '& Concepts']);
  });

  it('never leaves a colon at the end of the first line', () => {
    const lines = breakName('Selfhosted Services: Homelab', wide, 118);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.endsWith(':')).toBe(false);
  });

  it('keeps a single long word whole', () => {
    expect(breakName('Selbstverwaltungsdienste', wide, 60)).toEqual(['Selbstverwaltungsdienste']);
  });
});

describe('the areas controls take up', () => {
  it('measures every element laid over the canvas, relative to it, and nothing else', () => {
    const host = document.createElement('div');
    const canvas = document.createElement('canvas');
    const legend = document.createElement('div');
    const card = document.createElement('div');
    card.className = 'braincard';
    const heading = document.createElement('div');
    host.append(canvas, legend, card, heading);
    document.body.append(host);

    const rect = (left: number, top: number, width: number, height: number): DOMRect =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    canvas.getBoundingClientRect = () => rect(100, 50, 800, 600);
    legend.getBoundingClientRect = () => rect(700, 60, 180, 80);
    card.getBoundingClientRect = () => rect(300, 300, 260, 200);
    // Above the canvas, not over it: a panel heading.
    heading.getBoundingClientRect = () => rect(100, 10, 800, 30);

    expect(blockedAround(canvas)).toEqual([{ x: 600, y: 10, w: 180, h: 80 }]);

    // The window gets narrower and the legend moves with it.
    canvas.getBoundingClientRect = () => rect(100, 50, 500, 600);
    legend.getBoundingClientRect = () => rect(400, 60, 180, 80);
    expect(blockedAround(canvas)).toEqual([{ x: 300, y: 10, w: 180, h: 80 }]);
    host.remove();
  });
});
