/**
 * The colours the platform paints before and around the app.
 *
 * `index.html` and the manifest cannot import `prefs.ts`, so they hold copies
 * of its theme colours — and after the redesign both still carried the old
 * palette. This keeps every copy on the same values.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { THEME_COLOR } from '../src/prefs';

const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(__dirname, '../public/manifest.webmanifest'), 'utf8')) as {
  background_color: string;
  theme_color: string;
};

describe('the PWA colours', () => {
  it('index.html names the theme colour of each scheme', () => {
    expect(html).toContain(`media="(prefers-color-scheme: light)" content="${THEME_COLOR.light}"`);
    expect(html).toContain(`media="(prefers-color-scheme: dark)" content="${THEME_COLOR.dark}"`);
  });

  it('carries no other colour literal than the theme colours', () => {
    const literals = new Set(html.match(/#[0-9a-f]{6}\b/gi)?.map((c) => c.toLowerCase()));
    expect([...literals].sort()).toEqual([THEME_COLOR.dark, THEME_COLOR.light].sort());
  });

  it('lets iOS colour the status bar from the theme rather than forcing white text', () => {
    // Read once at launch, so it cannot follow a theme switch; `default` takes
    // its background from theme-color and picks a legible text colour.
    expect(html).toMatch(/name="apple-mobile-web-app-status-bar-style" content="default"/);
  });

  it('the manifest launches on the dark ground', () => {
    expect(manifest.theme_color).toBe(THEME_COLOR.dark);
    expect(manifest.background_color).toBe(THEME_COLOR.dark);
  });
});
