/**
 * The line that says which bundle is running.
 *
 * Checked as a unit rather than through the settings page: the page needs a
 * signed-in user, preferences and four callbacks to render, and none of that
 * says anything about this line. What the page owes is a heading, and that is
 * pinned in `settings-radios.test.tsx` alongside the rest of its sections.
 *
 * Its whole purpose is to be visible when a tab is stale, so the two things
 * worth pinning are that it renders a real build time in the reader's own
 * zone, and that it says something honest when there is no build time at all
 * rather than printing "Invalid Date" at somebody.
 */

import { describe, expect, it } from 'vitest';

import { builtAtLocal } from '../src/build';

describe('the build stamp', () => {
  it('reads as a moment in the reader’s own zone', () => {
    // Their zone, not UTC: the question behind the line is "is this before or
    // after I deployed", and the deploy happened where the person was.
    const shown = builtAtLocal('de-CH', '2026-09-30T12:34:56Z');

    expect(shown).not.toBeNull();
    expect(shown).toMatch(/2026/);
    // Some hour is named, whatever the runner's zone turns 12:34 UTC into.
    expect(shown).toMatch(/\d{1,2}:\d{2}/);
  });

  it('says nothing rather than something wrong when there was no build', () => {
    // `vite dev` and the test environment have no replacement to make, and a
    // stamp that reads "Invalid Date" is worse than an absent one.
    expect(builtAtLocal('de-CH', null)).toBeNull();
    expect(builtAtLocal('de-CH', 'irgendwas')).toBeNull();
  });
});
