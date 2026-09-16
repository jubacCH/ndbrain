/**
 * Rules of the stylesheet that a screenshot shows only in one state.
 *
 *  - a disabled button does not glow on hover, and the destructive button is
 *    drawn in the critical tone rather than the accent
 *  - the small state marks (health dots, tree ticks, the save point) use their
 *    own brighter tones, far enough apart in hue to tell warn from crit on the
 *    light ground; text keeps the high-contrast tones
 *  - words live in `copy.ts`, not in the components that once held them
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (file: string): string => readFileSync(resolve(__dirname, '..', file), 'utf8');
const css = read('src/styles.css');

/** Every rule as [selector list, body], comments removed. */
function rules(source: string): Array<[string, string]> {
  const plain = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1]!.trim(), m[2]!]);
}

function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe('buttons', () => {
  it('never lights up a disabled button on hover', () => {
    for (const [selectors, body] of rules(css)) {
      for (const selector of selectors.split(',').map((s) => s.trim())) {
        if (!/\.btn(-solid|-danger)?:hover/.test(selector)) continue;
        if (!/box-shadow|opacity|background/.test(body)) continue;
        // Scoped variants (`.files-actions .btn:hover`) are older and out of reach here.
        if (!selector.startsWith('.btn')) continue;
        expect(selector, selector).toMatch(/:hover:not\(:disabled\)/);
      }
    }
  });

  it('has a destructive button in the critical tone', () => {
    const danger = rules(css).filter(([s]) => s.split(',').some((x) => x.trim() === '.btn-danger'));
    expect(danger.length).toBeGreaterThan(0);
    expect(danger.map(([, body]) => body).join()).toMatch(/color:\s*var\(--crit\)/);
    expect(danger.map(([, body]) => body).join()).not.toMatch(/--solid-bg|--accent/);
  });
});

describe('state marks', () => {
  it('draw from the mark tones, not the text tones', () => {
    const body = (selector: string): string =>
      rules(css)
        .filter(([s]) => s.split(',').some((x) => x.trim() === selector))
        .map(([, b]) => b)
        .join();
    for (const selector of ['.dot-warn', '.st-warn', '.saved.dirty i']) {
      expect(body(selector), selector).toMatch(/background:\s*var\(--warn-dot\)/);
    }
    for (const selector of ['.dot-crit', '.st-crit', '.saved.failed i']) {
      expect(body(selector), selector).toMatch(/background:\s*var\(--crit-dot\)/);
    }
  });

  it('are far apart in hue on the light ground', () => {
    const light = /:root\s*\{([^}]*)\}/.exec(css)![1]!;
    const token = (name: string): string => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(light)![1]!;
    expect(hue(token('warn-dot')) - hue(token('crit-dot'))).toBeGreaterThanOrEqual(30);
    // Hue alone did not do it: the text tones are 35° apart too, and at 7 px
    // both read as the same dark brown because they are equally dark. The
    // marks differ in luminance as well.
    expect(luminance(token('warn-dot')) - luminance(token('crit-dot'))).toBeGreaterThanOrEqual(0.15);
    expect(luminance(token('warn-dot'))).toBeGreaterThan(luminance(token('warn')));
    expect(luminance(token('crit-dot'))).toBeGreaterThan(luminance(token('crit')));
  });
});

describe('words in copy.ts', () => {
  it.each([
    ['src/App.tsx', [/Reading the vault/, /Pick a note on the left/, /No links yet/]],
    ['src/Sidebar.tsx', [/aria-label="Navigation"/]],
    ['src/Context.tsx', [/No links yet/]],
    ['src/network/relativeTime.ts', [/'just now'/, /Format\('en'/]],
    ['src/network/MapView.tsx', [/'—'/]],
    ['src/Views.tsx', [/Format\('en'/]],
  ])('%s holds no inline copy', (file, patterns) => {
    const source = read(file);
    for (const pattern of patterns) expect(source).not.toMatch(pattern);
  });
});
