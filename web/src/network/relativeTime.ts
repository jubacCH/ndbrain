/**
 * Relative and absolute time for the network views.
 *
 * The list shows "2 days ago" in the cell and the exact instant in a tooltip —
 * the same split every other timestamp in the app makes, except this is the
 * first place that needed a *relative* rendering rather than a fixed date.
 * `Intl.RelativeTimeFormat` and `Intl.DateTimeFormat` are built into every
 * browser this app targets, so neither needs a dependency.
 */

import { copy } from '../copy';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

const relFormatter = new Intl.RelativeTimeFormat(copy.locale, { numeric: 'auto' });

/**
 * "2 days ago", "just now", "in 3 hours" (clock skew is possible, so the
 * future case is handled rather than shown as a negative number of days ago).
 */
export function relativeTime(ms: number, now: number = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);

  if (abs < MINUTE) return diff <= 0 ? copy.network.justNow : relFormatter.format(1, 'minute');

  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [YEAR, 'year'],
    [MONTH, 'month'],
    [WEEK, 'week'],
    [DAY, 'day'],
    [HOUR, 'hour'],
    [MINUTE, 'minute'],
  ];
  for (const [size, unit] of units) {
    if (abs >= size || unit === 'minute') {
      const value = Math.round(diff / size);
      // Round-to-zero at a unit boundary (e.g. 59 minutes rounding to "0
      // hours ago") would read as nonsense; fall through to the next unit.
      if (value !== 0) return relFormatter.format(value, unit);
    }
  }
  return copy.network.justNow;
}

const absFormatter = new Intl.DateTimeFormat(copy.locale, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** The exact instant, for a tooltip next to a relative label. */
export function absoluteTime(ms: number): string {
  return absFormatter.format(new Date(ms));
}
