/**
 * A point quadtree, for finding the node under the pointer.
 *
 * The hit test used to walk every node on every pointer event and keep the
 * closest. At 109 notes that is invisible; at the few thousand this view is
 * being built for it is a linear scan per mouse move, on the same thread as the
 * editor.
 *
 * A quadtree rather than a grid, although a grid would be shorter, because the
 * next phase needs this exact structure again: Barnes-Hut approximates distant
 * repulsion by treating a whole quadrant as one mass, and that is a quadtree
 * with a centre of mass per cell. Building the hit index on something throwaway
 * would mean building it twice.
 *
 * Nothing here knows what a node is. It stores indices and coordinates, which is
 * all the layout hands out.
 */

/** Points per cell before it splits. Small enough to prune, large enough that a
 *  tight cluster of notes does not build a tower of near-empty cells. */
const CAPACITY = 8;

interface Cell {
  /** The cell's share of the plane. Fixed at birth; decides where a point goes. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /**
   * The box the points below this cell actually occupy.
   *
   * Kept separately from the cell's own rectangle, and it is the one the search
   * prunes against. A point may lie outside the rectangle it was filed under —
   * see `insert` — and pruning on the rectangle would then skip a subtree that
   * holds the answer. That failure is silent: the click simply lands on nothing.
   */
  hasX: number;
  hasY: number;
  hasX2: number;
  hasY2: number;
  /** Point indices held directly; empty once this cell has split. */
  items: number[];
  xs: number[];
  ys: number[];
  /** Four children, or null while this is a leaf. */
  kids: [Cell, Cell, Cell, Cell] | null;
}

function cell(minX: number, minY: number, maxX: number, maxY: number): Cell {
  return {
    minX,
    minY,
    maxX,
    maxY,
    hasX: Infinity,
    hasY: Infinity,
    hasX2: -Infinity,
    hasY2: -Infinity,
    items: [],
    xs: [],
    ys: [],
    kids: null,
  };
}

function cover(c: Cell, x: number, y: number): void {
  if (x < c.hasX) c.hasX = x;
  if (y < c.hasY) c.hasY = y;
  if (x > c.hasX2) c.hasX2 = x;
  if (y > c.hasY2) c.hasY2 = y;
}

export class Quadtree {
  #root: Cell;

  constructor(minX: number, minY: number, maxX: number, maxY: number) {
    // A degenerate box — one node, or a panel that has not been measured yet —
    // would divide by zero forever on the first split.
    this.#root = cell(minX, minY, Math.max(maxX, minX + 1), Math.max(maxY, minY + 1));
  }

  /**
   * Files a point.
   *
   * Points outside the tree's box are kept, not dropped: a node dragged past the
   * rim must stay clickable, and the layout is not the only thing that decides
   * where a node is. They land in whichever edge cell the midpoint comparisons
   * lead to, which is why every cell also remembers the box its points really
   * occupy.
   */
  insert(item: number, x: number, y: number): void {
    let c = this.#root;
    for (;;) {
      cover(c, x, y);
      if (c.kids === null) {
        // Stop splitting once a cell is a pixel across: a pile of points on the
        // exact same spot would otherwise subdivide forever, since every child
        // inherits all of them.
        if (c.items.length < CAPACITY || c.maxX - c.minX < 1) {
          c.items.push(item);
          c.xs.push(x);
          c.ys.push(y);
          return;
        }
        this.#split(c);
      }
      c = this.#pick(c, x, y);
    }
  }

  #split(c: Cell): void {
    const mx = (c.minX + c.maxX) / 2;
    const my = (c.minY + c.maxY) / 2;
    c.kids = [
      cell(c.minX, c.minY, mx, my),
      cell(mx, c.minY, c.maxX, my),
      cell(c.minX, my, mx, c.maxY),
      cell(mx, my, c.maxX, c.maxY),
    ];
    const { items, xs, ys } = c;
    c.items = [];
    c.xs = [];
    c.ys = [];
    for (let i = 0; i < items.length; i += 1) {
      const kid = this.#pick(c, xs[i]!, ys[i]!);
      cover(kid, xs[i]!, ys[i]!);
      kid.items.push(items[i]!);
      kid.xs.push(xs[i]!);
      kid.ys.push(ys[i]!);
    }
  }

  #pick(c: Cell, x: number, y: number): Cell {
    const kids = c.kids!;
    const mx = (c.minX + c.maxX) / 2;
    const my = (c.minY + c.maxY) / 2;
    return kids[(x < mx ? 0 : 1) + (y < my ? 0 : 2)]!;
  }

  /**
   * The nearest stored point within `radius`, or -1.
   *
   * Depth first with a shrinking bound: once something has been found at
   * distance d, any cell whose points all lie further away than d cannot hold
   * anything closer, and the whole subtree is skipped.
   */
  nearest(x: number, y: number, radius: number): number {
    let best = -1;
    let bestSq = radius * radius;
    const stack: Cell[] = [this.#root];

    while (stack.length > 0) {
      const c = stack.pop()!;
      if (c.hasX2 < c.hasX) continue;
      const dx = x < c.hasX ? c.hasX - x : x > c.hasX2 ? x - c.hasX2 : 0;
      const dy = y < c.hasY ? c.hasY - y : y > c.hasY2 ? y - c.hasY2 : 0;
      if (dx * dx + dy * dy > bestSq) continue;

      for (let i = 0; i < c.items.length; i += 1) {
        const ex = c.xs[i]! - x;
        const ey = c.ys[i]! - y;
        const d = ex * ex + ey * ey;
        // Strictly closer, so a cell being visited later cannot displace an
        // equally distant hit that is already held.
        if (d < bestSq) {
          bestSq = d;
          best = c.items[i]!;
        }
      }
      if (c.kids !== null) stack.push(c.kids[0], c.kids[1], c.kids[2], c.kids[3]);
    }
    return best;
  }
}
