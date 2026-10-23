/**
 * Checks the built assets against what `server/src/http/csp.ts` promises.
 *
 * That file says `script-src` needs no `'unsafe-eval'` because nothing in the
 * bundle evaluates strings, and called it "verified against the built assets".
 * Nothing verified it. `server/test/headers.test.ts` checks that the *policy* has
 * no `'unsafe-eval'`, which is a different statement — and the bundle had drifted
 * underneath it: Zod 4 probes for a JIT with `try { Function("") } catch {}` on
 * first use, and the probe was being blocked and caught on every single load.
 *
 * Run after `npm run build`; `npm run build` runs it.
 *
 * What it enforces, and why the two are not the same rule:
 *
 *  - **No `eval(` anywhere.** There is no legitimate use of it here, and one
 *    appearing means a dependency changed its mind about how it works.
 *  - **`new Function` only where it is known and never reached.** Zod's probe
 *    stays in the bundle as dead code under `jitless` — tree-shaking cannot
 *    remove it, because the switch is read at runtime. CodeMirror's Pug mode
 *    compiles attribute values that way; it is loaded only when somebody writes
 *    a `pug` code block, and under this policy its attribute highlighting
 *    quietly does less. Both are listed below. Anything else fails.
 *
 * The list is the point. A new entry is a decision somebody has to make, not a
 * line that slips in with a dependency bump.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'assets');

/**
 * Files allowed to contain `new Function`, with the reason.
 *
 * Matched on the part of the name before the content hash, since that changes on
 * every build.
 */
const ALLOWED = new Map([
  ['index', 'Zod 4 probes for a JIT and catches the failure; dead code under `jitless`'],
  ['pug', "CodeMirror's Pug mode compiles attribute values; lazy-loaded, degrades under CSP"],
  // Mermaid, lazy-loaded for a ```mermaid block. All three are lodash's way of
  // finding the global object, `freeGlobal || freeSelf || Function('return this')()`:
  // in a browser `self` is always there, so the call is never reached.
  ['chunk-FOHPRMQF', "Mermaid's bundled lodash: global lookup fallback, never reached in a browser"],
  ['cytoscape.esm', "Mermaid's cytoscape: the same lodash global lookup, never reached"],
  ['graphlib', "Mermaid's graphlib: the same lodash global lookup, never reached"],
]);

/**
 * The name without its content hash.
 *
 * Exactly the eight characters Vite appends, and nothing before them: a looser
 * pattern turned `chunk-FOHPRMQF-<hash>.js` into `chunk`, and an entry of that
 * would have waved through every chunk ever built.
 */
const stem = (name) => name.replace(/-[A-Za-z0-9_-]{8}\.js$/, '').replace(/\.js$/, '');

let failed = false;
const say = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) failed = true;
};

let files;
try {
  files = readdirSync(ASSETS).filter((name) => name.endsWith('.js'));
} catch {
  console.error(`no built assets in ${ASSETS} — run \`npm run build\` first`);
  process.exit(2);
}
if (files.length === 0) {
  console.error('no built assets to check');
  process.exit(2);
}

const evals = [];
const functions = [];
for (const name of files) {
  const source = readFileSync(join(ASSETS, name), 'utf8');
  // Word boundary, so `someEval(` and `.eval(` on an object do not count.
  if (/\beval\(/.test(source)) evals.push(name);
  if (/\bFunction\(/.test(source)) functions.push(name);
}

say(evals.length === 0, `no \`eval(\` in ${files.length} built files${evals.length === 0 ? '' : `: ${evals.join(', ')}`}`);

const unexpected = functions.filter((name) => !ALLOWED.has(stem(name)));
say(
  unexpected.length === 0,
  unexpected.length === 0
    ? `\`new Function\` only where allowed (${functions.map(stem).join(', ') || 'nowhere'})`
    : `\`new Function\` somewhere new: ${unexpected.join(', ')} — decide whether it may stay, then list it in check-csp.mjs`,
);

// An entry that stops being true is worth knowing about too: it means the reason
// for it is gone, and the list should shrink rather than grow stale.
for (const [allowed, why] of ALLOWED) {
  if (!functions.some((name) => stem(name) === allowed)) {
    console.log(`note  \`${allowed}\` no longer contains \`new Function\` — the entry can go ("${why}")`);
  }
}

process.exit(failed ? 1 : 0);
