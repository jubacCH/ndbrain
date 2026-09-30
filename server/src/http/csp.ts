/**
 * The content security policy, written for this application rather than copied.
 *
 * Why it matters here more than on an ordinary site: this origin serves a
 * single-page app that renders Markdown somebody else may have written and
 * embeds pictures out of a vault, and the same origin holds the session cookie.
 * Without a policy, one escape anywhere in the rendering path is not a broken
 * paragraph — it is script running as the signed-in person, with the whole API
 * in reach and a cookie it never has to read to use.
 *
 * Every directive below is what the built page was measured to need, which is
 * the only reason a policy survives: one that blocks the application gets
 * switched off, and a switched-off policy protects nothing. What the page loads,
 * checked against `web/dist` as the bundler leaves it:
 *
 *  - **One module bundle and one stylesheet**, both same-origin under
 *    `/assets/`, both content-hashed. `'self'` covers them.
 *  - **One inline script**: the theme bootstrap in `web/index.html`, which has
 *    to run before the first paint or a dark-mode launch flashes white. It is
 *    named by digest rather than waved through with `'unsafe-inline'` — see
 *    `inlineScriptHashes`.
 *  - **No `eval` and no `new Function`** anywhere in the bundle, verified
 *    against the built assets, so `script-src` needs no `'unsafe-eval'`.
 *  - **Images from this origin only**: an embed resolves to
 *    `/api/v1/files/…?owner=…` (see `web/src/editor/livePreview.ts`), and the
 *    icons are files in `web/public`. No `data:` and no `blob:` anywhere.
 *  - **Inline styles, unavoidably.** CodeMirror puts its theme into a `<style>`
 *    element it builds at runtime, and React `style={{…}}` props become style
 *    attributes. Both are inline as far as CSP is concerned, and neither has a
 *    digest that survives a version bump. `style-src` therefore keeps
 *    `'unsafe-inline'`, and this is stated rather than hidden: CSS injection is
 *    not what this policy is here to stop.
 *  - **A service worker and a manifest**, both same-origin files.
 *  - **No frames, no plugins, no external form target.**
 */

import { createHash } from 'node:crypto';

/**
 * A `<script>` element carrying its code inline.
 *
 * The lookahead rejects anything with a `src` attribute; `[^>]*` cannot cross
 * the closing bracket, so it only ever inspects that one element's attributes.
 */
const INLINE_SCRIPT = /<script(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi;

/**
 * `'sha256-…'` for each inline script in a page.
 *
 * Read from the page the server is about to serve, not written down beside it.
 * A digest pasted into the source is a digest that goes stale the first time
 * somebody edits the bootstrap or the bundler reformats it, and the symptom —
 * the theme script silently blocked, a white flash on a dark phone — is exactly
 * the kind of thing nobody connects back to a header. Computed from the file,
 * it cannot disagree with the file.
 *
 * The bytes hashed are those between the tags, unchanged, because that is what
 * the browser hashes.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(INLINE_SCRIPT)) {
    const code = match[1] ?? '';
    hashes.push(`'sha256-${createHash('sha256').update(code, 'utf8').digest('base64')}'`);
  }
  return hashes;
}

/**
 * The policy, with the page's own inline scripts allowed by digest.
 *
 * Called with no hashes when there is no web UI to serve — API-only development
 * and every test that does not set `webRoot`. That is the strict case, not a
 * degraded one: with no page there is no inline script that may run.
 */
export function contentSecurityPolicy(scriptHashes: readonly string[] = []): string {
  return [
    // Everything not named below: this origin, nothing else.
    "default-src 'self'",
    // The bundle, plus the bootstrap by digest. No `'unsafe-inline'`, which
    // would be ignored beside a hash in modern browsers and honoured in old
    // ones — the worst of both.
    ['script-src', "'self'", ...scriptHashes].join(' '),
    // See the note above: CodeMirror and React both need this.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self'",
    "font-src 'self'",
    // Every request the app makes is same-origin; there is no CORS setup and no
    // API base URL for exactly that reason.
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    // Nothing is embedded and nothing embeds this. `frame-ancestors` is the
    // header-level replacement for `X-Frame-Options`, which is still sent
    // alongside for the browsers that only read that one.
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    // No `<base>` tag exists, and an injected one would silently repoint every
    // relative URL on the page.
    "base-uri 'none'",
    // Every form here is handled in JavaScript and posts nowhere. `'self'`
    // rather than `'none'` so that a missed `preventDefault` reloads the page
    // instead of leaving a dead button; what it stops is the case that matters,
    // a form injected to post a session's contents somewhere else.
    "form-action 'self'",
  ].join('; ');
}

/**
 * How long a browser is told to stay on HTTPS.
 *
 * A year, with subdomains, without `preload`. Preloading is a commitment for a
 * whole domain baked into browser binaries and removed slowly; it is the host's
 * decision to make for `b8n.ch`, not this application's to make for it.
 */
export const HSTS = 'max-age=31536000; includeSubDomains';
