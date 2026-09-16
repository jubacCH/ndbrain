/**
 * How one laid-out map cell is painted: its warmth, whether its label is dark,
 * whether a label fits at all, and the label's text.
 *
 * Pure and in its own module. The map's cells are memoised, and what they must
 * not do is run again for a parent render that changed nothing; a function every
 * drawn cell calls exactly once per render is where a test can see that.
 */

/** Above this warmth a cell is bright enough that its label turns dark. */
export const HOT = 0.55;

export function truncate(label: string, max = 24): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

export interface PaintableCell {
  kind: 'frame' | 'leaf';
  rect: { w: number; h: number };
  label: string;
  warmth: number;
  small: boolean;
}

export interface Paint {
  /** Warmth clamped to 0…1; 0 draws the cool surface. */
  t: number;
  hot: boolean;
  showLabel: boolean;
  text: string;
}

export function paintCell(cell: PaintableCell): Paint {
  const { rect } = cell;
  const t = Math.max(0, Math.min(1, cell.warmth));
  if (cell.kind === 'frame') return { t: 0, hot: false, showLabel: true, text: cell.label };
  return {
    t,
    hot: t >= HOT,
    showLabel: cell.small ? rect.w > 30 && rect.h > 14 : rect.w > 42 && rect.h > 20,
    text: truncate(cell.label, cell.small ? 16 : 24),
  };
}
