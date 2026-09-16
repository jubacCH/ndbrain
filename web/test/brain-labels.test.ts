/**
 * Region names: beside their own region, or not at all.
 *
 * Every test here checks a whole placement against the rules a wrong one breaks,
 * on the real vault's structure, in several canvas sizes — so a change to the
 * layout, a new region name or a different number of regions shows up as a
 * failing rule rather than as a screenshot somebody has to notice.
 *
 * Two rules changed on 2026-09-16, on purpose, after Julian saw names that kept
 * every rule and still did not read as their regions': a leader may be at most
 * 18 % of the brain's width (it was 28 %), and a name may reach a narrow band
 * into the tissue, never over a note, on a dark plaque (it was never on the
 * tissue at all). Of all the ways a region's name may go, the shortest leader
 * that keeps the rules wins.
 */

import { describe, expect, it } from 'vitest';

import { blockedAround } from '../src/brain/blocked';
import type { Camera } from '../src/brain/camera';
import { fit } from '../src/brain/camera';
import type { LabelCandidate, PlacedLabel, Placement, Rect } from '../src/brain/labels';
import {
  TISSUE_BAND,
  breakName,
  circleHitsRect,
  deepestPoint,
  overlaps,
  placeLabels,
  placeRegionNames,
  polylinesCross,
  sampleLeader,
} from '../src/brain/labels';
import { BrainLayout } from '../src/brain/layout';
import { buildGraph } from '../src/brain/model';
import type { RegionAnchor } from '../src/brain/regions';
import { largestCluster, regionAnchors, regionView } from '../src/brain/regions';
import { bodyRadius } from '../src/brain/scene';
import { paraVault } from './fixtures/para-vault';

const vault = paraVault();
const graph = buildGraph(vault.data, { tags: vault.tags });
const layout = new BrainLayout(graph, { arrangement: 'brain' });
layout.settle();
const view = regionView(layout);
const anchors = regionAnchors(view, layout.x, layout.y);
const brainWidth = layout.bounds.maxX - layout.bounds.minX;
/** The notes as the scene draws them: world centre and drawn radius. */
const notes = graph.nodes.map((n, i) => ({ x: layout.x[i]!, y: layout.y[i]!, r: bodyRadius(layout.r[i]!, n.depth) }));

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
  const names = placeRegionNames(
    from,
    camera,
    size.width,
    size.height,
    blocked,
    view.depthInside,
    measure,
    notes,
    brainWidth,
  );
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
  const screenWidth = brainWidth * camera.scale;
  const depth = (x: number, y: number): number =>
    view.depthInside((x - camera.x) / camera.scale, (y - camera.y) / camera.scale) * camera.scale;

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

    // Over no note, and at most the band into the tissue — on a plaque when in it.
    for (const n of notes) {
      const p = toScreen(camera, n.x, n.y);
      expect(circleHitsRect(p.x, p.y, n.r * camera.scale, box), `${name} covers a note`).toBe(false);
    }
    const deepest = deepestPoint(box, depth);
    expect(deepest, `${name} is too deep in the tissue`).toBeLessThanOrEqual(TISSUE_BAND * screenWidth + 1e-6);
    if (deepest > 0) expect(label.plaque, `${name} is on the tissue without a plaque`).toBe(true);

    // On its region's side of the fissure.
    expect((cx - fissure) * a.side, `${name} is on the other hemisphere`).toBeGreaterThan(0);

    // The leader starts at one of the region's ways, points outward along it,
    // and is at most 18 % of the brain's width long.
    const used = a.ways.find((w) => {
      const p = toScreen(camera, w.anchorX, w.anchorY);
      return Math.abs(label.fromX - p.x) < 1e-6 && Math.abs(label.fromY - p.y) < 1e-6;
    });
    expect(used, `${name}'s leader starts at none of its region's ways`).toBeDefined();
    const anchor = toScreen(camera, used!.anchorX, used!.anchorY);
    expect(
      (label.toX - anchor.x) * used!.dirX + (label.toY - anchor.y) * used!.dirY,
      `${name} points back into the brain`,
    ).toBeGreaterThan(-1e-6);
    expect(Math.hypot(label.toX - label.fromX, label.toY - label.fromY), `${name} is far from its region`).toBeLessThanOrEqual(
      0.18 * screenWidth + 1e-6,
    );
    void cy;
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

  it('names most regions when there is room', () => {
    const { names } = place(SIZES.wide);
    expect(names.length).toBeGreaterThanOrEqual(Math.ceil(anchors.length * 0.75));
  });

  it('offers a way from the middle of a region’s largest cluster', () => {
    let offered = 0;
    for (const a of anchors) {
      const region = view.regions.find((r) => r.id === a.region)!;
      const cluster = largestCluster(region.members, layout.x, layout.y);
      if (cluster === null) continue;
      if (a.ways.some((w) => Math.abs(w.anchorX - cluster.x) < 1e-9 && Math.abs(w.anchorY - cluster.y) < 1e-9)) {
        offered += 1;
      }
    }
    expect(offered).toBeGreaterThan(0);
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

describe('choosing among a region’s ways', () => {
  // Hand-built, so each way's length and room can be set outright.
  const base: Omit<LabelCandidate, 'anchorX' | 'anchorY' | 'reach'> = {
    region: 1,
    lines: ['Name'],
    width: 40,
    height: 17,
    side: 1,
    weight: 10,
    rimX: 600,
    rimY: 300,
    dirX: 1,
    dirY: 0,
  };
  const open: Placement = {
    width: 1000,
    height: 700,
    fissureX: 400,
    blocked: [],
    depth: () => -1,
    band: 20,
    notes: [],
  };

  it('takes the way with the shorter leader, not the first one offered', () => {
    const far = { ...base, anchorX: 450, anchorY: 300, reach: 400 };
    const near = { ...base, anchorX: 580, anchorY: 300, reach: 400 };
    const [placed] = placeLabels([far, near], open);
    expect(placed!.fromX).toBe(580);
    // And a region is written once, however many ways it offers.
    expect(placeLabels([far, near], open)).toHaveLength(1);
  });

  it('skips a way with no room, and leads from the one that has it', () => {
    const impossible = { ...base, anchorX: 590, anchorY: 300, reach: 0 };
    const possible = { ...base, anchorX: 570, anchorY: 320, reach: 400 };
    const [placed] = placeLabels([impossible, possible], open);
    expect(placed!.fromX).toBe(570);
    expect(placed!.fromY).toBe(320);
  });

  it('reaches into the tissue only a band deep, never over a note, and puts a plaque behind it', () => {
    // Everything left of x = 640 is tissue, one pixel deeper per pixel.
    const tissue: Placement = { ...open, depth: (x) => 640 - x, band: 20 };
    const way = { ...base, anchorX: 560, anchorY: 300, reach: 400 };
    const [placed] = placeLabels([way], tissue);
    expect(placed).toBeDefined();
    // Nearest to its anchor it can be: inside the rim, within the band, on a plaque.
    expect(deepestPoint(placed!.box, tissue.depth)).toBeLessThanOrEqual(20);
    expect(placed!.box.x).toBeLessThan(640);
    expect(placed!.plaque).toBe(true);

    // A note where that name would have gone pushes it elsewhere.
    const box = placed!.box;
    const crowded: Placement = { ...tissue, notes: [{ x: box.x + box.w / 2, y: box.y + box.h / 2, r: 6 }] };
    const [moved] = placeLabels([way], crowded);
    if (moved !== undefined) expect(circleHitsRect(box.x + box.w / 2, box.y + box.h / 2, 10, moved.box)).toBe(false);

    // Out of the tissue entirely, no plaque.
    const outside: Placement = { ...open, depth: () => -5 };
    expect(placeLabels([way], outside)[0]!.plaque).toBe(false);
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
