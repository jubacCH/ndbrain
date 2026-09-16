/**
 * Where a region's name is written.
 *
 * A name belongs at the edge of the brain *next to its own region*, joined to it
 * by a short swung leader — like the target picture, where "Knowledge
 * Management" sits beside the lobe it names. The first version placed names in
 * world space and then clamped them into the canvas, which produced exactly the
 * failures it was meant to avoid: a name for the maps of content in the middle
 * of the fissure ended up on the far outer flank, a name pushed down a column
 * slid back over the tissue, and a name near the top right was written under
 * the legend.
 *
 * All of those are screen questions — how wide the text is, where the canvas
 * ends, where the controls laid over it are — so placement happens here, in
 * screen pixels, once the camera is known. The world only supplies, per region,
 * which way is outward and where its notes are (`regions.ts`).
 *
 * **The rule.** Regions are placed in order of how many notes they hold, so when
 * there is not room for everybody it is the smallest region's name that goes.
 * For each, positions are tried outward from the rim along the region's own
 * direction, then fanned a little either side of it, nearest first. A region
 * may offer more than one way out — a medial one first above or below the
 * brain, then outward — and those are tried in order. The first position that
 * passes every check is taken:
 *
 *  1. the whole text box is on the canvas — nothing is ever clipped;
 *  2. it covers no blocked area (legend, footer, controls: real DOM rectangles);
 *  3. it does not sit on the tissue;
 *  4. it is on its region's side of the fissure;
 *  5. it overlaps no name already written, and its leader crosses no leader or
 *     name already written, and no earlier leader crosses it;
 *  6. its leader is short enough that the name still reads as its region's.
 *
 * If no position passes, the name is left out. A name in the wrong place is
 * worse than no name: the region is still there, and zooming in names its notes.
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

/** One region's name, ready to place: everything in screen pixels. */
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
  /** Where the leader starts: the member nearest the rim. */
  anchorX: number;
  anchorY: number;
  /** The rim point outward from the region. */
  rimX: number;
  rimY: number;
  /** The outward direction, a unit vector. */
  dirX: number;
  dirY: number;
  /** The longest the leader may be, in pixels. */
  reach: number;
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
}

export interface Placement {
  width: number;
  height: number;
  /** Screen x of the fissure: which side a name is on is measured against it. */
  fissureX: number;
  /** Areas no name may cover, canvas-relative. */
  blocked: readonly Rect[];
  /** True when a screen point is on the tissue. */
  onTissue: (x: number, y: number) => boolean;
}

/** Room kept from the canvas edge and from blocked areas. */
const MARGIN = 8;
/** Room kept between two names. */
const SPACING = 6;
/** First try this far outside the rim, then step outward. */
const FIRST_OUT = 14;
const STEP_OUT = 12;
const MAX_OUT = 170;
/** Fan either side of the outward direction, in radians, nearest first. */
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
  // Grouped by region, keeping each region's own order of alternatives; the
  // regions themselves largest first.
  const byRegion = new Map<number, LabelCandidate[]>();
  for (const c of candidates) {
    const list = byRegion.get(c.region);
    if (list === undefined) byRegion.set(c.region, [c]);
    else list.push(c);
  }
  const regions = [...byRegion.values()].sort((a, b) => b[0]!.weight - a[0]!.weight || a[0]!.region - b[0]!.region);

  const placed: PlacedLabel[] = [];
  const leaders: Array<Array<{ x: number; y: number }>> = [];
  for (const ways of regions) {
    for (const c of ways) {
      const found = firstFit(c, screen, placed, leaders);
      if (found === null) continue;
      placed.push(found);
      leaders.push(sampleLeader(found));
      break;
    }
  }
  return placed;
}

function firstFit(
  c: LabelCandidate,
  screen: Placement,
  placed: readonly PlacedLabel[],
  leaders: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>,
): PlacedLabel | null {
  for (let out = FIRST_OUT; out <= MAX_OUT; out += STEP_OUT) {
    for (const turn of FAN) {
      const cos = Math.cos(turn);
      const sin = Math.sin(turn);
      const ux = c.dirX * cos - c.dirY * sin;
      const uy = c.dirX * sin + c.dirY * cos;
      const px = c.rimX + ux * out;
      const py = c.rimY + uy * out;
      const label = layout(c, px, py, ux, uy);
      if (fits(label, c, screen, placed, leaders)) return label;
    }
  }
  return null;
}

/** The text box and leader for a name whose leader ends at (px, py), heading (ux, uy). */
function layout(c: LabelCandidate, px: number, py: number, ux: number, uy: number): PlacedLabel {
  let align: PlacedLabel['align'];
  let box: Rect;
  let toX = px;
  let toY = py;
  if (Math.abs(ux) < CENTRED) {
    align = 'center';
    const above = uy < 0;
    box = { x: px - c.width / 2, y: above ? py - TICK - c.height : py + TICK, w: c.width, h: c.height };
    toY = py;
  } else if (ux > 0) {
    align = 'left';
    box = { x: px + TICK, y: py - c.height / 2, w: c.width, h: c.height };
  } else {
    align = 'right';
    box = { x: px - TICK - c.width, y: py - c.height / 2, w: c.width, h: c.height };
  }

  // One bow, away from the brain: the leader reads as a pointer, not a tract.
  const dx = toX - c.anchorX;
  const dy = toY - c.anchorY;
  const len = Math.hypot(dx, dy) || 1;
  const bow = 0.14 * len * (c.side * (dy < 0 ? -1 : 1));
  return {
    region: c.region,
    lines: c.lines,
    box,
    align,
    fromX: c.anchorX,
    fromY: c.anchorY,
    cx: (c.anchorX + toX) / 2 - (dy / len) * bow,
    cy: (c.anchorY + toY) / 2 + (dx / len) * bow,
    toX,
    toY,
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
  // 6. Near enough to its notes. Checked first: it is the cheapest.
  if (Math.hypot(label.toX - label.fromX, label.toY - label.fromY) > c.reach) return false;
  // 1. Wholly on the canvas.
  if (box.x < MARGIN || box.y < MARGIN || box.x + box.w > screen.width - MARGIN || box.y + box.h > screen.height - MARGIN) {
    return false;
  }
  // 2. Clear of every blocked area.
  const grown = inflate(box, MARGIN / 2);
  for (const b of screen.blocked) if (overlaps(grown, b)) return false;
  // 3. Off the tissue: the box and a thin ring around it.
  if (touchesTissue(inflate(box, 3), screen.onTissue)) return false;
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

function touchesTissue(r: Rect, onTissue: (x: number, y: number) => boolean): boolean {
  // A grid over the box, fine enough that no fold narrower than a line of text
  // can hide between two samples.
  const cols = Math.max(3, Math.ceil(r.w / 12));
  const rows = Math.max(3, Math.ceil(r.h / 8));
  for (let i = 0; i <= cols; i += 1) {
    for (let j = 0; j <= rows; j += 1) {
      if (onTissue(r.x + (r.w * i) / cols, r.y + (r.h * j) / rows)) return true;
    }
  }
  return false;
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
  inside: (x: number, y: number) => boolean,
  measure: (text: string) => number,
): PlacedLabel[] {
  if (anchors.length === 0) return [];
  const sx = (x: number): number => x * camera.scale + camera.x;
  const sy = (y: number): number => y * camera.scale + camera.y;
  const candidates: LabelCandidate[] = anchors.flatMap((a) => {
    const lines = breakName(a.text, measure, SINGLE_LINE);
    const ways = a.alternate === null ? [a] : [a, a.alternate];
    return ways.map((w) => ({
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
      reach: w.reach * camera.scale,
    }));
  });
  return placeLabels(candidates, {
    width,
    height,
    fissureX: sx(anchors[0]!.fissureX),
    blocked,
    onTissue: (x, y) => inside((x - camera.x) / camera.scale, (y - camera.y) / camera.scale),
  });
}
