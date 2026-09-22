/**
 * The interface speaks one language, and `copy.ts` is where it speaks it.
 *
 * This is the cheapest of the tests here and the one with the worst failure to
 * prevent. German survived two translation passes in two whole views because
 * nothing could enumerate "every string": the words sat in JSX and in attributes
 * where a reviewer reading a diff about layout has no reason to look, and one of
 * them — a `window.confirm` about giving up access to somebody's vault — ended
 * up half in each language, because its two branches were written in two places
 * and only one of them was ever translated.
 *
 * Two rules, both read off the source rather than off the rendered page:
 *
 *  - nothing a person can read is written as a literal in a component. Attributes
 *    are checked rather than JSX text, because an attribute is the half nobody
 *    sees: a placeholder and an `aria-label` are invisible on a screenshot and
 *    only an `aria-label` is read out loud.
 *  - no German anywhere under `src/`, comments included. The list below is what
 *    the translation pass actually found; add to it when something new slips in.
 *
 * `copy.ts` itself is exempt from the second rule, and deliberately: a few of
 * its lines quote the vault rather than the interface. The notes are written in
 * German, so the daily note's own "Notizen" heading and the German word the
 * palette also finds today's note by are content, not copy.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../src');

/** Every source file under `web/src`, as [path relative to src, text]. */
function sources(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = resolve(dir, entry);
      const name = prefix === '' ? entry : `${prefix}/${entry}`;
      if (statSync(full).isDirectory()) walk(full, name);
      else if (/\.(tsx?|css)$/.test(entry)) out.push([name, readFileSync(full, 'utf8')]);
    }
  };
  walk(SRC, '');
  return out;
}

const files = sources();

/**
 * German words that have actually been found in this tree.
 *
 * Whole words only, and chosen to be words no identifier or English sentence
 * contains: `dir` is a folder here and `die` is nothing at all.
 */
const GERMAN =
  /\b(anlegen|aufgeben|benutzername|durchsuchen|entziehen|erledigt|freigeben|freigegeben|ganzer|geteilt|kontext|nachbarn|offen|unterordnern|volltext|weitere|zugriff|und|oder|nicht|keine|auch|schon|noch|wurde|beim|eine|einen|diese|dieser|wichtig|leer|konto|recht)\b/i;

describe('one language', () => {
  it('writes no word a person can read into an attribute', () => {
    const offences: string[] = [];
    for (const [name, text] of files) {
      if (!name.endsWith('.tsx') && !name.endsWith('.ts')) continue;
      for (const match of text.matchAll(/\b(placeholder|aria-label|title|alt)="([^"]*)"/g)) {
        // An empty `alt` is the correct way to say "decorative", not a word.
        if (match[1] === 'alt' && match[2] === '') continue;
        offences.push(`${name}: ${match[0]}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('asks every question in a prompt through copy.ts', () => {
    const offences: string[] = [];
    for (const [name, text] of files) {
      for (const match of text.matchAll(/window\.(confirm|prompt|alert)\(\s*(.)/g)) {
        // A question assembled from literals is how the half-German one happened.
        if (match[2] === "'" || match[2] === '"' || match[2] === '`') offences.push(`${name}: ${match[0]}…`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('holds no German under src/', () => {
    const offences: string[] = [];
    for (const [name, text] of files) {
      // See the header: a few lines of the catalogue quote the German vault.
      if (name === 'copy.ts') continue;
      text.split('\n').forEach((line, index) => {
        if (GERMAN.test(line)) offences.push(`${name}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offences).toEqual([]);
  });

  it('declares the same language in the manifest as in the document', () => {
    const manifest = JSON.parse(readFileSync(resolve(__dirname, '../public/manifest.webmanifest'), 'utf8')) as {
      lang: string;
      description: string;
    };
    const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
    // An installed PWA introduces itself with the manifest, not with the page.
    expect(html).toContain(`<html lang="${manifest.lang}">`);
    expect(manifest.lang).toBe('en');
    expect(manifest.description).not.toMatch(GERMAN);
  });
});
