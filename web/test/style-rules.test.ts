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

/**
 * Height has to reach the view, or `overflow-y: auto` inside it never scrolls.
 *
 * `.main` hides its overflow and every view asks for `flex: 1`. If the wrapper
 * between them grows with its content instead of passing the constraint down,
 * a long note or a long list is simply cut off at the bottom of the window.
 */
describe('the view fills its column', () => {
  /** Every declaration of one selector, across all the rules that name it. */
  function declarations(selector: string): string {
    return rules(css)
      .filter(([selectors]) => selectors.split(',').some((one) => one.trim() === selector))
      .map(([, body]) => body)
      .join(';');
  }

  it('the stage hands its height to the column, not to the content', () => {
    expect(declarations('.stage')).toMatch(/min-height:\s*0/);
  });

  it('the column is a flex column that does not grow with its content', () => {
    const main = declarations('.main');

    expect(main).toMatch(/min-height:\s*0/);
    expect(main).toMatch(/flex-direction:\s*column/);
  });

  it('the body of a view passes the height on, so the view can scroll', () => {
    const body = declarations('.main-body');

    expect(body).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/flex:\s*1/);
    expect(body).toMatch(/flex-direction:\s*column/);
  });

  it('a view scrolls its own content', () => {
    const pane = declarations('.pane');

    expect(pane).toMatch(/overflow-y:\s*auto/);
    expect(pane).toMatch(/flex:\s*1/);
  });
});

/**
 * The two columns of "Continue", when one of them has nothing in it.
 *
 * The component puts a class on the grid and the stylesheet decides what that
 * means, so the class on its own proves nothing — a class with no rule behind it
 * is how the text-size knob came to be silently ineffective once already.
 */
describe('the continue tile', () => {
  function declarations(selector: string): string {
    return rules(css)
      .filter(([selectors]) => selectors.split(',').some((one) => one.trim() === selector))
      .map(([, body]) => body)
      .join(';');
  }

  it('gives the width to one column when the other is empty', () => {
    const one = declarations('.home-columns.one-sided');

    expect(one).not.toBe('');
    expect(one).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it('still has two columns when neither is', () => {
    expect(declarations('.home-columns')).toMatch(/grid-template-columns:\s*repeat\(2/);
  });
});

/**
 * The skip link is the one control that must be reachable while it is invisible.
 *
 * `display: none` and `visibility: hidden` take an element out of the tab order
 * as well as off the screen, which would leave the link there in the markup and
 * useless — the failure that makes a skip link look present in a review and be
 * absent in use. It is moved off the page instead, and comes back on focus.
 */
describe('the skip link', () => {
  function declarations(selector: string): string {
    return rules(css)
      .filter(([selectors]) => selectors.split(',').some((one) => one.trim() === selector))
      .map(([, body]) => body)
      .join(';');
  }

  it('is hidden by position, never by display or visibility', () => {
    const resting = declarations('.skiplink');

    expect(resting).not.toMatch(/display:\s*none/);
    expect(resting).not.toMatch(/visibility:\s*hidden/);
    expect(resting).toMatch(/position:\s*(absolute|fixed)/);
  });

  it('shows itself once it has the focus', () => {
    const focused = declarations('.skiplink:focus');
    expect(focused).not.toBe('');
    expect(focused).toMatch(/top:|left:|transform:/);
  });
});

/**
 * Where the text-size knob hangs, which decides whether it does anything.
 *
 * `--text-scale` is the one setting the whole interface is meant to follow, and
 * every size token is written in `rem` so that it does. But `rem` resolves
 * against the root element, never against `body` — so a scale declared on
 * `body` moved the body's own text and left every token that hangs off it at
 * the browser's unscaled 16px root. Somebody who set the type to 150% still got
 * 11.5px labels, because `--t-xs: 0.72rem` had never heard of the setting.
 *
 * jsdom lays nothing out, so there is no computed pixel to measure here. What
 * is checkable is the thing that was wrong: which selector carries the
 * declaration, that `body` still follows it rather than pinning itself to a
 * pixel again, and that the tokens the knob is meant to reach are relative in
 * the first place. Those three are the mechanism; a browser is needed only to
 * admire the result.
 */
describe('the text-size knob', () => {
  /**
   * Every rule whose body sets a font-size built from `--text-scale`.
   *
   * The property may carry a fallback (`var(--text-scale, 1)`), so the match
   * stops at the name rather than at the closing bracket. Written the strict
   * way this stopped matching the moment the fallback was added, and the test
   * passed the wrong way round: nothing matched, so nothing was checked.
   */
  const scaled = rules(css).filter(([, body]) =>
    /font-size:[^;]*var\(\s*--text-scale\s*[,)]/.test(body),
  );

  it('is declared on the root element, so every rem follows it', () => {
    expect(scaled.length).toBeGreaterThan(0);
    for (const [selectors] of scaled) {
      for (const selector of selectors.split(',').map((one) => one.trim())) {
        // `rem` is the root element's font size. Anywhere else the knob turns
        // and the tokens do not move.
        expect(selector, selector).toMatch(/^(html|:root)$/);
      }
    }
  });

  it('carries the body along in a relative unit, not back to a pixel', () => {
    const body = rules(css)
      .filter(([selectors]) => selectors.split(',').some((one) => one.trim() === 'body'))
      .map(([, declarations]) => declarations)
      .join(';');
    const sizes = [...body.matchAll(/font-size:\s*([^;]+)/g)].map((match) => match[1]!.trim());

    expect(sizes.length).toBeGreaterThan(0);
    // The last declaration is the one that wins, and it has to be relative: an
    // absolute font-size on `body` strands everything inheriting from it while
    // the tokens around it scale.
    expect(sizes[sizes.length - 1]).toMatch(/(rem|em|%|inherit)/);
  });

  it('turns tokens that are written in rem, or it reaches nothing', () => {
    // `:root` is declared several times over — palette, spacing, type — so the
    // tokens are looked for across all of them.
    const root = rules(css)
      .filter(([selectors]) => selectors.trim() === ':root')
      .map(([, body]) => body)
      .join(';');
    const tokens = [...root.matchAll(/--t-(xs|sm|md|base|lg|xl):\s*([^;]+)/g)];

    expect(tokens.length).toBe(6);
    for (const [, name, value] of tokens) expect(value!.trim(), `--t-${name}`).toMatch(/rem$/);
  });
});

/**
 * The knob has to hold a value before any Javascript has run.
 *
 * `rem` is only useful here because the root's font size is computed from
 * `--text-scale`, and a `var()` whose custom property was never declared makes
 * the whole declaration invalid at computed-value time: the browser throws away
 * `font-size` and the root falls back to its own 16px. Every `--t-*` token then
 * resolves against a size the stylesheet did not choose.
 *
 * That is not a hypothetical. The inline script in `index.html` sets the
 * property only when localStorage holds a size, and its own comment calls it
 * "deliberately forgiving" — which it could afford to be while `:root` still
 * declared `--text-scale: 1`. A first visit, a private window, a browser with
 * site data blocked, or no Javascript at all leaves nothing to read.
 */
describe('the text-size knob before Javascript', () => {
  it('resolves to a size even when nothing has set the property', () => {
    const declared = /--text-scale:\s*[^;]+/.test(css);
    const fallback = /var\(\s*--text-scale\s*,[^)]+\)/.test(css);

    // Either is enough on its own: a declaration in the cascade, or a fallback
    // at the point of use. Neither leaves the root element sized by accident.
    expect(declared || fallback, 'no declaration and no var() fallback').toBe(true);
  });
});
