/**
 * Where a region's name is written.
 *
 * A name belongs at the edge of the brain *next to its own region*, joined to it
 * by a short swung leader — like the target picture, where "Knowledge
 * Management" sits beside the lobe it names. Placement happens in screen pixels,
 * once the camera is known, because every question it has to answer is a screen
 * question: how wide the text is, where the canvas ends, where the controls
 * laid over it are. The world only supplies, per region, the ways its name may
 * go (`regions.ts`).
 *
 * **The rule.** Regions are placed in order of how many notes they hold, so when
 * there is not room for everybody it is the smallest region's name that goes.
 * For each, every way it offers is tried at positions along its direction —
 * from a little inside the rim outward, fanned either side — and of all the
 * positions that keep every rule, the one with the **shortest leader** is
 * taken. The rules:
 *
 *  1. the whole text box is on the canvas — nothing is ever clipped;
 *  2. it covers no blocked area (legend, footer, controls: real DOM rectangles);
 *  3. it covers no note, and reaches at most a narrow band into the tissue;
 *  4. it is on its region's side of the fissure;
 *  5. it overlaps no name already written, its leader crosses no leader or
 *     name already written, and no earlier leader crosses it;
 *  6. its leader is short enough that the name still reads as its region's.
 *
 * **The second pass (2026-09-16).** A name left out by the first pass gets one
 * more try, after every other name is written, with a longer leader
 * (`fallbackReach`). Some regions lie deeper in the tissue than the first
 * pass's leader is long — on the real vault "Proxmox" sits between the
 * hemispheres, its nearest note 21 % of the brain's width from any rim — and
 * there the choice is a longer leader or no name at all. Because the second
 * pass runs last, it can only fill room the first pass left: it never moves or
 * displaces a name that fitted with the short leader.
 *
 * If no position keeps them all, the name is left out. A name in the wrong place
 * is worse than no name: the region is still there, and zooming in names its
 * notes.
 *
 * **Why a name may now reach into the tissue (2026-09-16).** The rule used to be
 * "never on the tissue", and it was kept — every name stood outside the outline.
 * But the outline is wide, a region's notes are often well inside it, and the
 * leaders grew long enough that the eye no longer joined a name to its notes.
 * Julian chose a name nearer its notes over a name clear of the tissue. So a
 * name may now sit up to a band's width inside the rim, never over a note, and
 * when it does it is written on a dark plaque, so the grain behind it cannot
 * make it harder to read.
 *
 * Nothing here depends on what a region is called or how many there are.
 */

import type { RegionAnchor } from './regions';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One way to place one region's name, ready to place: everything in screen pixels. */
export interface LabelCandidate {
  region: number;
  lines: readonly string[];
  /** The text box's size. */
  width: number;
  height: number;
  /** Which hemisphere the region is in: -1 left, 1 right. */
  side: -1 | 1;
  /** How many notes it holds: larger regions are placed first. */
  weight: number;
  /** Where the leader starts. */
  anchorX: number;
  anchorY: number;
  /** The rim point outward from the anchor. */
  rimX: number;
  rimY: number;
  /** The outward direction, a unit vector. */
  dirX: number;
  dirY: number;
  /** The longest the leader may be, in pixels. */
  reach: number;
  /** The longest the leader may be in the second pass, for a name the first left out. */
  fallbackReach?: number;
}

export interface PlacedLabel {
  region: number;
  lines: readonly string[];
  box: Rect;
  align: 'left' | 'right' | 'center';
  /** The leader: a quadratic from the anchor to where it meets the text. */
  fromX: number;
  fromY: number;
  cx: number;
  cy: number;
  toX: number;
  toY: number;
  /** True when the name reaches into the tissue and is drawn on a dark plaque. */
  plaque: boolean;
}

export interface NoteDisc {
  x: number;
  y: number;
  r: number;
}

/**
 * How far outside a name a click still counts, in CSS pixels.
 *
 * A name is thirteen-pixel text with no padding of its own; without a little
 * slack the top and bottom pixel rows of a word would be dead.
 */
export const NAME_GRAB = 4;

/**
 * The region whose name is under a screen point, or -1.
 *
 * The name is the handle for a whole knowledge area — the briefing's region
 * inspector — and it is the only part of a region that is drawn as itself: the
 * cells are not outlined and the notes are the notes. Picking by the name also
 * leaves "click the dark to deselect" alone, which picking by the cell would
 * have taken away.
 *
 * Names never overlap — the placement drops one rather than write it over
 * another — so the first box that contains the point is the answer.
 */
export function labelAt(names: readonly PlacedLabel[], x: number, y: number): number {
  for (const label of names) {
    const { box } = label;
    if (
      x >= box.x - NAME_GRAB &&
      x <= box.x + box.w + NAME_GRAB &&
      y >= box.y - NAME_GRAB &&
      y <= box.y + box.h + NAME_GRAB
    ) {
      return label.region;
    }
  }
  return -1;
}

export interface Placement {
  width: number;
  height: number;
  /** Screen x of the fissure: which side a name is on is measured against it. */
  fissureX: number;
  /** Areas no name may cover, canvas-relative. */
  blocked: readonly Rect[];
  /** How far a screen point lies inside the silhouette, in pixels; negative outside. */
  depth: (x: number, y: number) => number;
  /** How far into the tissue a name may reach, in pixels. */
  band: number;
  /** The notes, which no name may cover. */
  notes: readonly NoteDisc[];
}

/** Room kept from the canvas edge and from blocked areas. */
const MARGIN = 8;
/** Room kept between two names. */
const SPACING = 6;
/** Room kept around a note. */
const NOTE_ROOM = 4;
/** Positions along a way: from this far inside its rim point to this far outside, in steps. */
const FIRST_OUT = -36;
const STEP_OUT = 9;
const MAX_OUT = 150;
/** Fan either side of the outward direction, in radians. */
const FAN = [0, 0.2, -0.2, 0.4, -0.4, 0.6, -0.6, 0.85, -0.85];
/** Below this horizontal share the name sits centred above or below its point. */
const CENTRED = 0.38;
/** Gap between the leader's end and the text. */
const TICK = 5;
/** Points a leader is sampled at for the crossing test. */
const LEADER_SAMPLES = 12;

/**
 * Places every name that can be placed well, and leaves out the rest.
 *
 * Deterministic: the same candidates and the same screen give the same answer,
 * so a name does not flicker between two equally good places from frame to frame.
 */
export function placeLabels(candidates: readonly LabelCandidate[], screen: Placement): PlacedLabel[] {
  const byRegion = new Map<number, LabelCandidate[]>();
  for (const c of candidates) {
    const list = byRegion.get(c.region);
    if (list === undefined) byRegion.set(c.region, [c]);
    else list.push(c);
  }
  const regions = [...byRegion.values()].sort((a, b) => b[0]!.weight - a[0]!.weight || a[0]!.region - b[0]!.region);

  const placed: PlacedLabel[] = [];
  const leaders: Array<Array<{ x: number; y: number }>> = [];
  const left: Array<readonly LabelCandidate[]> = [];
  for (const ways of regions) {
    const found = shortestFit(ways, screen, placed, leaders);
    if (found === null) {
      left.push(ways);
      continue;
    }
    placed.push(found);
    leaders.push(sampleLeader(found));
  }
  // Second pass: only into the room the first left, so no name placed above moves.
  for (const ways of left) {
    const longer = ways
      .filter((c) => c.fallbackReach !== undefined && c.fallbackReach > c.reach)
      .map((c) => ({ ...c, reach: c.fallbackReach! }));
    if (longer.length === 0) continue;
    const found = shortestFit(longer, screen, placed, leaders);
    if (found === null) continue;
    placed.push(found);
    leaders.push(sampleLeader(found));
  }
  return placed;
}

/** Of every position every way offers, the one with the shortest leader that keeps the rules. */
function shortestFit(
  ways: readonly LabelCandidate[],
  screen: Placement,
  placed: readonly PlacedLabel[],
  leaders: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>,
): PlacedLabel | null {
  const options: Array<{ label: PlacedLabel; way: LabelCandidate; length: number; order: number }> = [];
  let order = 0;
  for (const c of ways) {
    for (let out = FIRST_OUT; out <= MAX_OUT; out += STEP_OUT) {
      for (const turn of FAN) {
        const cos = Math.cos(turn);
        const sin = Math.sin(turn);
        const ux = c.dirX * cos - c.dirY * sin;
        const uy = c.dirX * sin + c.dirY * cos;
        const label = layout(c, c.rimX + ux * out, c.rimY + uy * out, ux, uy);
        const length = Math.hypot(label.toX - label.fromX, label.toY - label.fromY);
        if (length > c.reach) continue;
        options.push({ label, way: c, length, order: order++ });
      }
    }
  }
  // Shortest first; ties keep the order they were generated in, so the answer
  // does not depend on how the sort breaks them.
  options.sort((a, b) => a.length - b.length || a.order - b.order);
  for (const o of options) if (fits(o.label, o.way, screen, placed, leaders)) return o.label;
  return null;
}

/** The text box and leader for a name whose leader ends at (px, py), heading (ux, uy). */
function layout(c: LabelCandidate, px: number, py: number, ux: number, uy: number): PlacedLabel {
  let align: PlacedLabel['align'];
  let box: Rect;
  if (Math.abs(ux) < CENTRED) {
    align = 'center';
    const above = uy < 0;
    box = { x: px - c.width / 2, y: above ? py - TICK - c.height : py + TICK, w: c.width, h: c.height };
  } else if (ux > 0) {
    align = 'left';
    box = { x: px + TICK, y: py - c.height / 2, w: c.width, h: c.height };
  } else {
    align = 'right';
    box = { x: px - TICK - c.width, y: py - c.height / 2, w: c.width, h: c.height };
  }

  // One bow, away from the brain: the leader reads as a pointer, not a tract.
  const dx = px - c.anchorX;
  const dy = py - c.anchorY;
  const len = Math.hypot(dx, dy) || 1;
  const bow = 0.14 * len * (c.side * (dy < 0 ? -1 : 1));
  return {
    region: c.region,
    lines: c.lines,
    box,
    align,
    fromX: c.anchorX,
    fromY: c.anchorY,
    cx: (c.anchorX + px) / 2 - (dy / len) * bow,
    cy: (c.anchorY + py) / 2 + (dx / len) * bow,
    toX: px,
    toY: py,
    plaque: false,
  };
}

function fits(
  label: PlacedLabel,
  c: LabelCandidate,
  screen: Placement,
  placed: readonly PlacedLabel[],
  leaders: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>,
): boolean {
  const { box } = label;
  // 1. Wholly on the canvas.
  if (box.x < MARGIN || box.y < MARGIN || box.x + box.w > screen.width - MARGIN || box.y + box.h > screen.height - MARGIN) {
    return false;
  }
  // 2. Clear of every blocked area.
  const grown = inflate(box, MARGIN / 2);
  for (const b of screen.blocked) if (overlaps(grown, b)) return false;
  // 3. Over no note, and no deeper into the tissue than the band.
  for (const n of screen.notes) if (circleHitsRect(n.x, n.y, n.r + NOTE_ROOM, box)) return false;
  const deepest = deepestPoint(inflate(box, 3), screen.depth);
  if (deepest > screen.band) return false;
  label.plaque = deepest > 0;
  // 4. On its region's side of the fissure.
  if ((box.x + box.w / 2 - screen.fissureX) * c.side <= 0) return false;
  // 5. Clear of the names and leaders already written, both ways round.
  const spaced = inflate(box, SPACING);
  for (const p of placed) if (overlaps(spaced, p.box)) return false;
  const mine = sampleLeader(label);
  for (const other of leaders) if (polylinesCross(mine, other)) return false;
  for (const p of placed) if (polylineHitsRect(mine, inflate(p.box, 2))) return false;
  for (const other of leaders) if (polylineHitsRect(other, inflate(box, 2))) return false;
  return true;
}

function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function circleHitsRect(cx: number, cy: number, r: number, box: Rect): boolean {
  const nx = Math.max(box.x, Math.min(cx, box.x + box.w));
  const ny = Math.max(box.y, Math.min(cy, box.y + box.h));
  return (cx - nx) ** 2 + (cy - ny) ** 2 < r * r;
}

/** How far the deepest of a grid of points over the box lies inside the silhouette. */
export function deepestPoint(r: Rect, depth: (x: number, y: number) => number): number {
  // Fine enough that no fold narrower than a line of text can hide between two samples.
  const cols = Math.max(3, Math.ceil(r.w / 12));
  const rows = Math.max(3, Math.ceil(r.h / 8));
  let deepest = -Infinity;
  for (let i = 0; i <= cols; i += 1) {
    for (let j = 0; j <= rows; j += 1) {
      deepest = Math.max(deepest, depth(r.x + (r.w * i) / cols, r.y + (r.h * j) / rows));
    }
  }
  return deepest;
}

/** The leader as a polyline, for the crossing tests. */
export function sampleLeader(l: PlacedLabel): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  for (let k = 0; k <= LEADER_SAMPLES; k += 1) {
    const t = k / LEADER_SAMPLES;
    const it = 1 - t;
    pts.push({
      x: it * it * l.fromX + 2 * it * t * l.cx + t * t * l.toX,
      y: it * it * l.fromY + 2 * it * t * l.cy + t * t * l.toY,
    });
  }
  return pts;
}

function segmentsCross(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function polylinesCross(
  a: ReadonlyArray<{ x: number; y: number }>,
  b: ReadonlyArray<{ x: number; y: number }>,
): boolean {
  for (let i = 0; i + 1 < a.length; i += 1) {
    for (let j = 0; j + 1 < b.length; j += 1) {
      if (segmentsCross(a[i]!.x, a[i]!.y, a[i + 1]!.x, a[i + 1]!.y, b[j]!.x, b[j]!.y, b[j + 1]!.x, b[j + 1]!.y)) {
        return true;
      }
    }
  }
  return false;
}

function polylineHitsRect(line: ReadonlyArray<{ x: number; y: number }>, r: Rect): boolean {
  for (const p of line) if (p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) return true;
  const corners = [
    [r.x, r.y, r.x + r.w, r.y],
    [r.x + r.w, r.y, r.x + r.w, r.y + r.h],
    [r.x + r.w, r.y + r.h, r.x, r.y + r.h],
    [r.x, r.y + r.h, r.x, r.y],
  ] as const;
  for (let i = 0; i + 1 < line.length; i += 1) {
    for (const [x1, y1, x2, y2] of corners) {
      if (segmentsCross(line[i]!.x, line[i]!.y, line[i + 1]!.x, line[i + 1]!.y, x1, y1, x2, y2)) return true;
    }
  }
  return false;
}

/**
 * Breaks a name over two lines where a person would.
 *
 * One line when it is short enough. Otherwise before an ampersand if there is
 * one — "Knowledge & / Management" reads badly, "Knowledge / & Management" does
 * not — and else at the space that makes the two lines most even. Never right
 * after a colon, which would leave the qualifier dangling on its own line.
 */
export function breakName(text: string, measure: (s: string) => number, singleLine: number): string[] {
  if (measure(text) <= singleLine || !text.includes(' ')) return [text];
  const amp = text.indexOf(' & ');
  if (amp > 0) return [text.slice(0, amp), text.slice(amp + 1)];

  let best: string[] | null = null;
  let bestWidth = Infinity;
  for (let i = text.indexOf(' '); i > 0; i = text.indexOf(' ', i + 1)) {
    const first = text.slice(0, i);
    const second = text.slice(i + 1);
    if (first.endsWith(':')) continue;
    const widest = Math.max(measure(first), measure(second));
    if (widest < bestWidth) {
      bestWidth = widest;
      best = [first, second];
    }
  }
  return best ?? [text];
}

/** Line height of a region name, CSS pixels. */
export const LINE_HEIGHT = 17;
/** A name wider than this on one line is broken over two. */
export const SINGLE_LINE = 118;
/**
 * How far into the tissue a name may reach, as a share of the brain's width.
 * Enough for a name to sit beside notes near the rim; far too little for a name
 * to wander into the middle of a hemisphere.
 */
export const TISSUE_BAND = 0.045;

/**
 * Everything the placement needs, from the world anchors and the camera.
 *
 * `measure` is the one thing only a canvas can answer; a test passes an
 * approximation, the renderer passes `measureText`.
 */
export function placeRegionNames(
  anchors: readonly RegionAnchor[],
  camera: { scale: number; x: number; y: number },
  width: number,
  height: number,
  blocked: readonly Rect[],
  depthInside: (x: number, y: number) => number,
  measure: (text: string) => number,
  notes: readonly NoteDisc[],
  brainWidth: number,
): PlacedLabel[] {
  if (anchors.length === 0) return [];
  const sx = (x: number): number => x * camera.scale + camera.x;
  const sy = (y: number): number => y * camera.scale + camera.y;
  const candidates: LabelCandidate[] = anchors.flatMap((a) => {
    const lines = breakName(a.text, measure, SINGLE_LINE);
    return a.ways.map((w) => ({
      region: a.region,
      lines,
      width: Math.ceil(Math.max(...lines.map(measure))),
      height: lines.length * LINE_HEIGHT,
      side: a.side,
      weight: a.weight,
      anchorX: sx(w.anchorX),
      anchorY: sy(w.anchorY),
      rimX: sx(w.rimX),
      rimY: sy(w.rimY),
      dirX: w.dirX,
      dirY: w.dirY,
      reach: a.reach * camera.scale,
      fallbackReach: a.fallbackReach * camera.scale,
    }));
  });
  return placeLabels(candidates, {
    width,
    height,
    fissureX: sx(anchors[0]!.fissureX),
    blocked,
    depth: (x, y) => depthInside((x - camera.x) / camera.scale, (y - camera.y) / camera.scale) * camera.scale,
    band: TISSUE_BAND * brainWidth * camera.scale,
    notes: notes.map((n) => ({ x: sx(n.x), y: sy(n.y), r: n.r * camera.scale })),
  });
}
