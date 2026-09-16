/**
 * The list view's "2 days ago" cell and its tooltip, as pure functions.
 */

import { describe, expect, it } from 'vitest';

import { absoluteTime, relativeTime } from '../src/network/relativeTime';

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('relativeTime', () => {
  it('says "just now" for the present moment', () => {
    expect(relativeTime(NOW, NOW)).toBe('just now');
  });

  it('reads naturally for minutes, hours and days ago', () => {
    expect(relativeTime(NOW - 5 * MIN, NOW)).toBe('5 minutes ago');
    expect(relativeTime(NOW - 3 * HOUR, NOW)).toBe('3 hours ago');
    expect(relativeTime(NOW - 2 * DAY, NOW)).toBe('2 days ago');
  });

  it('says "yesterday" for one day ago', () => {
    expect(relativeTime(NOW - DAY, NOW)).toBe('yesterday');
  });

  it('handles weeks, months and years', () => {
    expect(relativeTime(NOW - 14 * DAY, NOW)).toBe('2 weeks ago');
    expect(relativeTime(NOW - 90 * DAY, NOW)).toBe('3 months ago');
    expect(relativeTime(NOW - 400 * DAY, NOW)).toBe('last year');
  });

  it('handles a future timestamp (clock skew) rather than a negative count', () => {
    expect(relativeTime(NOW + 2 * DAY, NOW)).toBe('in 2 days');
  });
});

describe('absoluteTime', () => {
  it('formats a fixed instant deterministically', () => {
    const formatted = absoluteTime(NOW);
    // Locale formatting is environment-dependent in its punctuation, but the
    // year and day must always appear somewhere in it.
    expect(formatted).toContain('2026');
    expect(formatted).toMatch(/16/);
  });
});
