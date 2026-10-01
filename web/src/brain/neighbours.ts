/**
 * Which points are close enough to push on each other.
 *
 * The repulsion in `layout.ts` is zero past a cutoff — `REPULSION / d²` applied
 * only while `d <= cutoff` — and it found that out by measuring every pair.
 * The test was after the arithmetic, so the arithmetic was the cheap part and
 * the scan was the whole cost: at a few thousand notes, every simulation step
 * walked millions of pairs to apply a force to a few thousand of them. In the
 * brain arrangement the cutoff is 45 units across a plane hundreds wide, so
 * nearly every pair visited contributed exactly nothing.
 *
 * So the points are filed into square cells one cutoff wide, and a point's
 * candidates are the nine cells around it. Nothing outside them can be within
 * the cutoff, so nothing that mattered is skipped. **This is not an
 * approximation.** Barnes-Hut, which the comment on `repel` has been promising
 * and which `quadtree.ts` was written towards, treats a distant cluster as one
 * mass and changes the result; this changes which pairs are looked at and
 * nothing else.
 *
 * That is why it can be held to the simulation's frozen reference numbers to
 * six decimal places rather than to a tolerance invented for it — the forces
 * are summed over the same pairs in the same order, so the sums are the same
 * sums. `around` returns its answer ascending for exactly that reason: floating
 * point addition is not associative, and a reordered sum is a different number
 * in the last digits, which over four hundred steps is no longer the last
 * digits.
 */

/**
 * Beyond this many cells the grid is refused and the caller scans everything.
 *
 * A guard against the shape, not against the size: points spread over a plane
 * enormously wider than the cutoff would ask for a row of cells per point and
 * spend more on bookkeeping than the scan it is saving. Falling back is a
 * slower answer, never a wrong one.
 */
const MAX_CELLS = 1 << 22;

export class Neighbourhood {
  #cell = 1;
  #cols = 0;
  #rows = 0;
  #minX = 0;
  #minY = 0;
  /** `start[c] … start[c + 1]` is cell `c`'s slice of `items`. */
  #start = new Int32Array(0);
  /** Positions in the list this was built from, ascending inside each cell. */
  #items = new Int32Array(0);
  #built = false;

  /** Whether `around` may be asked. False means: scan the whole list instead. */
  get usable(): boolean {
    return this.#built;
  }

  /**
   * Files every point of `list` by where it is.
   *
   * `list` holds indices into `x` and `y`; what comes back out of `around` is a
   * **position in `list`**, not the index it holds, because the caller's loops
   * are written over positions — the moving half only looks at pairs whose
   * second position is the greater, and it can only say that about positions.
   */
  build(x: Float64Array, y: Float64Array, list: Int32Array, cutoff: number): boolean {
    this.#built = false;
    const n = list.length;
    if (n === 0 || !(cutoff > 0)) return false;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let p = 0; p < n; p += 1) {
      const i = list[p]!;
      const px = x[i]!;
      const py = y[i]!;
      if (!Number.isFinite(px) || !Number.isFinite(py)) return false;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }

    const cols = Math.floor((maxX - minX) / cutoff) + 1;
    const rows = Math.floor((maxY - minY) / cutoff) + 1;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols * rows > MAX_CELLS) return false;

    this.#cell = cutoff;
    this.#cols = cols;
    this.#rows = rows;
    this.#minX = minX;
    this.#minY = minY;

    const cells = cols * rows;
    if (this.#start.length < cells + 1) this.#start = new Int32Array(cells + 1);
    else this.#start.fill(0, 0, cells + 1);
    if (this.#items.length < n) this.#items = new Int32Array(n);

    // Counting sort, in three passes over the list and none over the cells'
    // contents: counts, then running offsets, then the fill. Filling in
    // ascending `p` leaves each cell's slice ascending, which is half of what
    // keeps the sums identical.
    const start = this.#start;
    for (let p = 0; p < n; p += 1) {
      const c = this.#cellOf(x, y, list[p]!) + 1;
      start[c] = start[c]! + 1;
    }
    for (let c = 0; c < cells; c += 1) start[c + 1] = start[c + 1]! + start[c]!;

    // `start` is now the beginning of each cell; the fill walks a copy of it so
    // the starts survive. Reusing the tail of `items` would be shorter and
    // would alias when `n` is small.
    const at = start.slice(0, cells);
    for (let p = 0; p < n; p += 1) {
      const c = this.#cellOf(x, y, list[p]!);
      this.#items[at[c]!] = p;
      at[c] = at[c]! + 1;
    }

    this.#built = true;
    return true;
  }

  /**
   * The positions whose point could be within the cutoff of `(px, py)`.
   *
   * Written into `out` in ascending order and returned as a count. "Could":
   * the nine cells hold everything within the cutoff and some that is further,
   * so the caller still measures. That is deliberate — the measurement is the
   * cheap part, and a grid that tried to be exact would have to measure too.
   */
  around(px: number, py: number, out: Int32Array): number {
    if (!this.#built) return 0;

    const cx = this.#clamp(Math.floor((px - this.#minX) / this.#cell), this.#cols);
    const cy = this.#clamp(Math.floor((py - this.#minY) / this.#cell), this.#rows);

    let n = 0;
    for (let gy = Math.max(0, cy - 1); gy <= Math.min(this.#rows - 1, cy + 1); gy += 1) {
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(this.#cols - 1, cx + 1); gx += 1) {
        const c = gy * this.#cols + gx;
        const from = this.#start[c]!;
        const to = this.#start[c + 1]!;
        for (let k = from; k < to; k += 1) {
          if (n >= out.length) return -1;
          out[n] = this.#items[k]!;
          n += 1;
        }
      }
    }

    // Each cell's run was already ascending; across nine of them they
    // interleave. Sorted rather than merged by hand: the lists are short by
    // construction — that is the whole point of the grid — and a nine-way merge
    // is thirty lines that have to be right for a saving nobody can measure.
    if (n > 1) out.subarray(0, n).sort();
    return n;
  }

  #cellOf(x: Float64Array, y: Float64Array, i: number): number {
    const cx = this.#clamp(Math.floor((x[i]! - this.#minX) / this.#cell), this.#cols);
    const cy = this.#clamp(Math.floor((y[i]! - this.#minY) / this.#cell), this.#rows);
    return cy * this.#cols + cx;
  }

  /** A point exactly on the far edge lands one cell past the end without this. */
  #clamp(v: number, length: number): number {
    return v < 0 ? 0 : v >= length ? length - 1 : v;
  }
}

/**
 * The two grids and the scratch list one repulsion pass needs.
 *
 * Owned by the layout and reused, like its other flat arrays: a grid rebuilt
 * from scratch every frame is three passes over the points, which is nothing
 * beside what it saves, but three new typed arrays sixty times a second is work
 * for the collector and nothing else.
 */
export class RepelSpace {
  readonly moving = new Neighbourhood();
  readonly still = new Neighbourhood();
  #candidates = new Int32Array(0);

  /** A scratch list long enough that `around` can never run out of room. */
  fit(n: number): Int32Array {
    if (this.#candidates.length < n) this.#candidates = new Int32Array(n);
    return this.#candidates;
  }
}
