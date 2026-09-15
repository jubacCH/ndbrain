/**
 * The hit index.
 *
 * The only thing that matters about it is that it answers exactly what the
 * linear scan it replaces answered — a faster wrong answer is worse than a slow
 * right one, and "the click landed on the neighbouring note" is the kind of bug
 * nobody reports because it looks like a slip of the hand.
 *
 * So the test is a comparison against brute force over a lot of random points,
 * with the awkward cases named separately.
 */

import { describe, expect, it } from 'vitest';

import { Quadtree } from '../src/brain/quadtree';

/** A repeatable generator, so a failure can be run again. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function brute(
  points: Array<[number, number]>,
  x: number,
  y: number,
  radius: number,
): number {
  let best = -1;
  let bestSq = radius * radius;
  for (let i = 0; i < points.length; i += 1) {
    const dx = points[i]![0] - x;
    const dy = points[i]![1] - y;
    const d = dx * dx + dy * dy;
    if (d < bestSq) {
      bestSq = d;
      best = i;
    }
  }
  return best;
}

describe('nearest point', () => {
  it('agrees with a linear scan over a vault-sized cloud', () => {
    const random = rng(20260911);
    const points: Array<[number, number]> = [];
    for (let i = 0; i < 900; i += 1) points.push([random() * 1200, random() * 700]);

    const tree = new Quadtree(0, 0, 1200, 700);
    points.forEach(([x, y], i) => tree.insert(i, x, y));

    for (let q = 0; q < 400; q += 1) {
      const x = random() * 1300 - 50;
      const y = random() * 800 - 50;
      const radius = 4 + random() * 60;
      expect(tree.nearest(x, y, radius)).toBe(brute(points, x, y, radius));
    }
  });

  it('finds nothing when nothing is close enough', () => {
    const tree = new Quadtree(0, 0, 400, 400);
    tree.insert(0, 200, 200);
    expect(tree.nearest(10, 10, 20)).toBe(-1);
    expect(tree.nearest(200, 215, 20)).toBe(0);
  });

  it('still finds a node that has been dragged outside the world', () => {
    const tree = new Quadtree(0, 0, 400, 400);
    tree.insert(7, -60, 470);
    expect(tree.nearest(-58, 468, 10)).toBe(7);
  });

  it('survives a pile of points on the same spot', () => {
    // A degenerate cluster is what would send a naive subdivision into an
    // endless split: every child gets all the points and nothing gets smaller.
    const tree = new Quadtree(0, 0, 500, 500);
    for (let i = 0; i < 64; i += 1) tree.insert(i, 250, 250);
    expect(tree.nearest(250, 250, 1)).toBeGreaterThanOrEqual(0);
  });

  it('copes with a box that has no area', () => {
    const tree = new Quadtree(0, 0, 0, 0);
    tree.insert(3, 0, 0);
    expect(tree.nearest(0, 0, 5)).toBe(3);
  });

  it('is empty when nothing was inserted', () => {
    expect(new Quadtree(0, 0, 100, 100).nearest(50, 50, 1000)).toBe(-1);
  });
});
