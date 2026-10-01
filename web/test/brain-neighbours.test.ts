/**
 * The grid that decides which points are worth measuring against each other.
 *
 * `repel` applies no force past a cutoff but used to measure every pair anyway,
 * so a vault's growth cost the layout quadratically for a result that was
 * mostly zero. The grid is only allowed to skip pairs that could not have
 * mattered, and that is the one property everything else rests on: **every
 * point within the cutoff must come back**. If it does not, the brain is laid
 * out by a force that quietly stopped acting between two notes, which looks
 * like a layout decision rather than a defect.
 *
 * So the test for it is the brute-force answer. Not a sample of it — the whole
 * of it, over a spread that is deliberately awkward: points on cell edges, points
 * on top of each other, a single point, an empty list.
 */

import { describe, expect, it } from 'vitest';

import { Neighbourhood, RepelSpace } from '../src/brain/neighbours';

/** A deterministic sprinkle, so a failure is the same failure tomorrow. */
function scatter(n: number, spread: number): { x: Float64Array; y: Float64Array; list: Int32Array } {
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const list = new Int32Array(n);
  let seed = 12345;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < n; i += 1) {
    x[i] = next() * spread - spread / 2;
    y[i] = next() * spread - spread / 2;
    list[i] = i;
  }
  return { x, y, list };
}

/** Every position in `list` whose point is within `cutoff` of position `p`. */
function trueNeighbours(
  x: Float64Array,
  y: Float64Array,
  list: Int32Array,
  p: number,
  cutoff: number,
): number[] {
  const out: number[] = [];
  const i = list[p]!;
  for (let q = 0; q < list.length; q += 1) {
    const j = list[q]!;
    const dx = x[j]! - x[i]!;
    const dy = y[j]! - y[i]!;
    if (Math.sqrt(dx * dx + dy * dy) <= cutoff) out.push(q);
  }
  return out;
}

describe('what comes back', () => {
  it('holds every point within the cutoff, for every point', () => {
    const { x, y, list } = scatter(400, 900);
    const grid = new Neighbourhood();
    expect(grid.build(x, y, list, 45)).toBe(true);

    const out = new Int32Array(list.length);
    for (let p = 0; p < list.length; p += 1) {
      const found = new Set<number>();
      const n = grid.around(x[list[p]!]!, y[list[p]!]!, out);
      for (let k = 0; k < n; k += 1) found.add(out[k]!);

      for (const q of trueNeighbours(x, y, list, p, 45)) {
        expect(found.has(q), `position ${q} is within the cutoff of ${p} and was not offered`).toBe(true);
      }
    }
  });

  /**
   * Floating point addition is not associative, so the order is not cosmetic:
   * the simulation's frozen reference numbers hold to six decimal places over
   * four hundred steps, and they only hold because the forces are summed in the
   * order they were summed in before this existed.
   */
  it('is ascending, because the sums depend on it', () => {
    const { x, y, list } = scatter(300, 600);
    const grid = new Neighbourhood();
    grid.build(x, y, list, 60);

    const out = new Int32Array(list.length);
    for (let p = 0; p < list.length; p += 1) {
      const n = grid.around(x[list[p]!]!, y[list[p]!]!, out);
      for (let k = 1; k < n; k += 1) {
        expect(out[k]!, `candidate ${k} came before ${k - 1}`).toBeGreaterThan(out[k - 1]!);
      }
    }
  });

  it('is a saving, not merely a different way to visit everything', () => {
    const { x, y, list } = scatter(1500, 4000);
    const grid = new Neighbourhood();
    grid.build(x, y, list, 45);

    const out = new Int32Array(list.length);
    let visited = 0;
    for (let p = 0; p < list.length; p += 1) visited += grid.around(x[list[p]!]!, y[list[p]!]!, out);

    // The full scan is n² — this says the grid is in a different class, with
    // room to spare rather than a number tuned to today's sprinkle.
    expect(visited).toBeLessThan(list.length * list.length * 0.05);
  });
});

describe('the awkward shapes', () => {
  it('takes an empty list by refusing, so the caller scans nothing', () => {
    const grid = new Neighbourhood();
    expect(grid.build(new Float64Array(0), new Float64Array(0), new Int32Array(0), 45)).toBe(false);
    expect(grid.usable).toBe(false);
    expect(grid.around(0, 0, new Int32Array(4))).toBe(0);
  });

  it('takes one point, and offers it to itself', () => {
    const grid = new Neighbourhood();
    expect(grid.build(Float64Array.of(5), Float64Array.of(7), Int32Array.of(0), 45)).toBe(true);

    const out = new Int32Array(1);
    expect(grid.around(5, 7, out)).toBe(1);
    expect(out[0]).toBe(0);
  });

  it('takes points stacked on one another', () => {
    const x = Float64Array.of(0, 0, 0, 0);
    const y = Float64Array.of(0, 0, 0, 0);
    const grid = new Neighbourhood();
    grid.build(x, y, Int32Array.of(0, 1, 2, 3), 45);

    const out = new Int32Array(4);
    expect(grid.around(0, 0, out)).toBe(4);
    expect([...out]).toEqual([0, 1, 2, 3]);
  });

  /**
   * A point exactly on the far edge divides to one cell past the end, which
   * would be a read outside the grid — and in a typed array that is
   * `undefined`, not a crash, so it would have been a neighbour silently
   * missing rather than anything anybody noticed.
   */
  it('keeps a point on the far edge inside the grid', () => {
    const x = Float64Array.of(0, 90);
    const y = Float64Array.of(0, 90);
    const grid = new Neighbourhood();
    grid.build(x, y, Int32Array.of(0, 1), 45);

    const out = new Int32Array(2);
    expect(grid.around(90, 90, out)).toBeGreaterThan(0);
  });

  it('refuses a spread it would lose on, rather than asking for a cell per point', () => {
    const x = Float64Array.of(0, 1e12);
    const y = Float64Array.of(0, 1e12);
    const grid = new Neighbourhood();

    expect(grid.build(x, y, Int32Array.of(0, 1), 1)).toBe(false);
    expect(grid.usable).toBe(false);
  });

  it('refuses a point that is not a number, rather than filing it somewhere', () => {
    const grid = new Neighbourhood();
    expect(grid.build(Float64Array.of(0, NaN), Float64Array.of(0, 0), Int32Array.of(0, 1), 45)).toBe(false);
  });
});

describe('the workspace', () => {
  it('grows its scratch list and keeps it', () => {
    const space = new RepelSpace();
    const small = space.fit(10);
    expect(small.length).toBeGreaterThanOrEqual(10);

    const big = space.fit(1000);
    expect(big.length).toBeGreaterThanOrEqual(1000);
    // The same array back when it is already large enough: the point of it is
    // not allocating one per frame.
    expect(space.fit(10)).toBe(big);
  });
});
