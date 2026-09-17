/**
 * The brain health score: the formula in `src/health.ts`, pinned to numbers a
 * person can recompute by hand.
 */

import { describe, expect, it } from 'vitest';

import { HEALTH_WEIGHTS, brainHealth } from '../src/health';

const clean = { notes: 100, orphans: 0, broken: 0, untagged: 0, conflicts: 0 };

describe('brain health', () => {
  it('is 100 with nothing to find', () => {
    expect(brainHealth(clean).score).toBe(100);
  });

  it('has no score for an empty vault rather than a perfect one', () => {
    expect(brainHealth({ ...clean, notes: 0 }).score).toBeNull();
  });

  it('weighs each finding by its share of the notes', () => {
    // 10 orphans in 100 notes: share 0.1 × weight 0.3 → 3 points.
    expect(brainHealth({ ...clean, orphans: 10 }).score).toBe(97);
    // 10 untagged: 0.1 × 0.2 → 2 points.
    expect(brainHealth({ ...clean, untagged: 10 }).score).toBe(98);
  });

  it('recomputes a real vault by hand: 118 notes, 5 orphaned, 29 broken, 10 untagged, 1 conflict', () => {
    const health = brainHealth({ notes: 118, orphans: 5, broken: 29, untagged: 10, conflicts: 1 });
    const lost = 100 * (0.3 * 5 / 118 + 0.3 * 29 / 118 + 0.2 * 10 / 118 + 0.2 * 1 / 118);
    expect(health.score).toBe(Math.round(100 - lost));
    expect(health.score).toBe(89);
    expect(health.parts.reduce((sum, p) => sum + p.cost, 0)).toBeCloseTo(lost, 10);
  });

  it('is relative: the same findings weigh less in a larger vault', () => {
    const small = brainHealth({ ...clean, notes: 50, orphans: 10 }).score!;
    const large = brainHealth({ ...clean, notes: 500, orphans: 10 }).score!;
    expect(large).toBeGreaterThan(small);
  });

  it('lets one category take its whole weight, never more', () => {
    // More broken links than notes: the share caps at 1, so at most 30 points.
    const health = brainHealth({ ...clean, notes: 10, broken: 400 });
    expect(health.score).toBe(70);
    expect(health.parts.find((p) => p.key === 'broken')!.share).toBe(1);
  });

  it('never leaves 0–100, even with everything broken', () => {
    expect(brainHealth({ notes: 3, orphans: 99, broken: 99, untagged: 99, conflicts: 99 }).score).toBe(0);
  });

  it('gives the same score whether or not tagging is known to be unused', () => {
    // The server reports zero untagged where tags are not a convention, so both
    // views must land on the same number from the same findings.
    const known = brainHealth({ ...clean, untagged: null, orphans: 10 });
    const unknown = brainHealth({ ...clean, untagged: 0, orphans: 10 });
    expect(known.score).toBe(unknown.score);
    expect(known.score).toBe(97);
    expect(known.parts.find((p) => p.key === 'untagged')!.applies).toBe(false);
    expect(unknown.parts.find((p) => p.key === 'untagged')!.applies).toBe(true);
  });

  it('keeps the base weights summing to one', () => {
    expect(Object.values(HEALTH_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('treats nonsense counts as nothing rather than as a negative finding', () => {
    expect(brainHealth({ ...clean, orphans: -4, broken: Number.NaN }).score).toBe(100);
  });

  it('only ever falls when a finding grows', () => {
    let previous = 101;
    for (let orphans = 0; orphans <= 120; orphans += 5) {
      const score = brainHealth({ ...clean, orphans }).score!;
      expect(score).toBeLessThanOrEqual(previous);
      previous = score;
    }
  });
});
