/** Resolves the REST/WebSocket base URL for the running app.
 *
 *  In a plain browser, everything stays same-origin exactly as before this
 *  module existed: `getApiBaseUrl()` returns `""` (so `${base}/api/v1/...` in
 *  `client.ts` is the same relative URL it always sent) and `getCollabWsUrl()`
 *  derives `wss`/`ws` from `window.location`, same as the original
 *  `deriveCollabWsUrl` in `collab.ts` did.
 *
 *  In the Tauri desktop shell there is no same-origin page to derive from -
 *  the webview loads local app assets, not the ndBrain server - so both
 *  functions instead read the user-configured server URL (persisted via
 *  `platform/tauri.ts`) and build absolute URLs from it.
 *
 *  Cross-origin implication (flagged, not solved here): once a Tauri client
 *  points at a remote server, `client.ts`'s `credentials: "include"` cookie
 *  is no longer same-site. The server must opt in with CORS
 *  (`Access-Control-Allow-Origin`/`-Credentials`) and the cookie must be
 *  `SameSite=None; Secure` for the session to work cross-origin - that's a
 *  server-side concern for a later task (CORS/cookie handling), not this one.
 */

import { getStoredServerUrl, isTauri, setStoredServerUrl } from "../platform/tauri";

/** Strips a trailing slash so a configured server URL composes cleanly with
 *  the fixed `/api/v1` and `/collab` suffixes (never a doubled `//`). */
function normalize(url: string): string {
  return url.replace(/\/+$/, "");
}

/** The persisted, user-configured server URL (Tauri only). `null` in the
 *  browser (nothing is ever stored there) or before the user has configured
 *  one in Tauri. */
export function getServerUrl(): string | null {
  const stored = getStoredServerUrl();
  return stored ? normalize(stored) : null;
}

/** Persists the server URL (Tauri only), normalizing a trailing slash first. */
export function setServerUrl(url: string): void {
  setStoredServerUrl(normalize(url));
}

/** REST base URL to prefix every `client.ts` request with.
 *
 *  Browser: `""` - `${base}/api/v1/...` stays the exact same relative URL
 *  as before, so `fetch` keeps sending the request to the current origin
 *  with `credentials: "include"` working as it always did (no regression).
 *
 *  Tauri: the configured server's origin (e.g. `"https://brain.b8n.ch"`), so
 *  requests become absolute. `""` if the user hasn't configured a server yet
 *  (fails as a relative request against the local asset server rather than
 *  silently guessing a host). */
export function getApiBaseUrl(): string {
  if (!isTauri()) return "";
  return getServerUrl() ?? "";
}

/** Derives the `/collab` WebSocket URL from an explicit HTTP(S) origin:
 *  `https:` -> `wss:`, anything else -> `ws:`, same host. Exported for
 *  `shell/EditorPane.tsx`, which needs the ws URL of a *specific* server
 *  source (derived from that source's `SourceDef.url`) rather than the
 *  page's own location - one server source's provider must never leak
 *  another source's origin. */
export function deriveWsUrlFromOrigin(origin: string): string {
  const url = new URL(origin);
  const scheme = url.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${url.host}/collab`;
}

/** Derives the `/collab` WebSocket URL from the page's own location: `wss://`
 *  when the page itself is served over `https:`, `ws://` otherwise, same host -
 *  both the dev Vite proxy (`vite.config.ts`) and prod's same-origin static
 *  serving forward `/collab` to the real Hocuspocus server, so a relative,
 *  location-derived URL is correct in both environments without configuration.
 *
 *  Kept here (rather than only in `collab.ts`) so `getCollabWsUrl` can share
 *  it as the browser/unconfigured-Tauri fallback; `collab.ts` re-exports this
 *  for its existing callers/tests. */
export function deriveCollabWsUrl(loc: Pick<Location, "protocol" | "host">): string {
  const scheme = loc.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${loc.host}/collab`;
}

/** Collab WebSocket base URL.
 *
 *  Browser: today's `window.location`-derived logic, unchanged.
 *
 *  Tauri: derived from the configured server URL instead, since there is no
 *  meaningful `window.location` to read (the desktop shell loads local app
 *  assets, not the server). Falls back to the location-derived URL if the
 *  user hasn't configured a server yet.
 *
 *  `notePath` is accepted for interface symmetry with the REST base URL (a
 *  future per-document URL shape would need it) but the current server
 *  serves `/collab` as a single Hocuspocus endpoint regardless of document,
 *  so it is unused today. */
export function getCollabWsUrl(notePath?: string): string {
  void notePath;
  if (!isTauri()) return deriveCollabWsUrl(window.location);
  const configured = getServerUrl();
  return configured ? deriveWsUrlFromOrigin(configured) : deriveCollabWsUrl(window.location);
}
