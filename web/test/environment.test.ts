/**
 * The holes jsdom leaves, and that a test file must not be able to reopen.
 *
 * jsdom implements no `matchMedia`, so every file that renders the shell stubs
 * one — and eleven of them do. The stub is removed again with
 * `vi.unstubAllGlobals()` in the file's own `afterEach`, and Vitest runs those
 * in reverse registration order: a file's hook goes *before* Testing Library's
 * automatic unmount. For that moment the app is still on screen with no
 * `matchMedia` behind it, and anything that renders then throws.
 *
 * The error is charged to whichever test is running at the time, which is why
 * this showed up as a failure in a test about a failed tree request, in a file
 * that had nothing to do with the one that caused it, in one run out of four.
 *
 * `test/setup.ts` therefore defines `matchMedia` on the window rather than
 * stubbing it, so `unstubAllGlobals` falls back to a working implementation
 * instead of to `undefined`. This is that promise, checked rather than trusted.
 */

import { describe, expect, it, vi } from 'vitest';

describe('the test environment', () => {
  it('still has matchMedia after a file removes its own stub', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    expect(window.matchMedia('(prefers-color-scheme: dark)').matches).toBe(true);

    vi.unstubAllGlobals();

    // The hole this used to leave is what made a late render throw. A test that
    // asked only whether the stub was gone would pass either way.
    expect(typeof window.matchMedia).toBe('function');
    expect(window.matchMedia('(prefers-color-scheme: dark)').matches).toBe(false);
  });

  it('answers every media query the same way, since jsdom lays nothing out', () => {
    // `matches: false` is the honest default: there is no layout to measure, so
    // a query is true only where a test says so.
    for (const query of ['(max-width: 820px)', '(prefers-color-scheme: dark)', '(min-width: 1px)']) {
      expect(window.matchMedia(query).matches, query).toBe(false);
      expect(window.matchMedia(query).media, query).toBe(query);
    }
  });
});
