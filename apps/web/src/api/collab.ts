/** Connects a note's live Y.Doc to the server's `/collab` Hocuspocus endpoint.
 *
 *  Real API of `@hocuspocus/provider@4.3.0` (verified against the installed
 *  package's source, `HocuspocusProvider.ts`/`types.ts` - this is the v4
 *  "unbundled" shape, not the older v2/v3 one memory tends to reach for):
 *
 *  - `new HocuspocusProvider({ url, name, token, document, awareness })`. Passing
 *    no explicit `websocketProvider` makes the provider manage its own
 *    `HocuspocusProviderWebsocket` internally (`manageSocket = true`) and connect
 *    immediately on construction - there is no separate `.connect()` call needed
 *    (calling it is actually a deprecated no-op on the provider itself once a
 *    socket is managed for it).
 *  - `token` is typed `string | (() => string) | (() => Promise<string>) | null`;
 *    a plain string (or `""`) is valid - `null` would skip sending an auth
 *    message entirely (`getToken()` returns `null`, `sendToken` still sends an
 *    `AuthenticationMessage` with `token: token ?? ""`), so an explicit `""` is
 *    used here for "no token" to keep the wire behavior identical either way and
 *    avoid a nullable field the server's `authenticateCollab` has to special-case.
 *  - `provider.document` (getter) is the `Y.Doc` passed in (or one it creates);
 *    `provider.awareness` (getter) is a `y-protocols` `Awareness` bound to that
 *    doc unless `awareness: null` was passed - not the case here, so it is always
 *    present.
 *  - Connection lifecycle is observed via `provider.on("status", ({ status }) =>
 *    ...)`, where `status` is `@hocuspocus/provider`'s `WebSocketStatus` enum
 *    value as a string: `"connecting" | "connected" | "disconnected"` (see
 *    `Editor.tsx`, which maps `"disconnected"` to the UI's "offline").
 *  - `provider.destroy()` tears down the socket, the awareness instance, and all
 *    listeners; it does NOT destroy the `Y.Doc` (a caller-owned object), hence
 *    `destroy()` below also calls `ydoc.destroy()`.
 */

import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { deriveCollabWsUrl, getCollabWsUrl } from "./base-url";

/** Re-exported for existing callers/tests that import it from here - the
 *  implementation now lives in `base-url.ts` so `getCollabWsUrl` (which is
 *  Tauri-aware) can share it as the browser/unconfigured-Tauri fallback. */
export { deriveCollabWsUrl };

/** Must match the server's `CONTENT_FIELD` constant (`apps/server/src/collab/
 *  document-manager.ts`) - the Y.Text field a note's markdown lives under. */
export const CONTENT_FIELD = "content";

export interface CollabProviderHandle {
  provider: HocuspocusProvider;
  ydoc: Y.Doc;
  ytext: Y.Text;
  /** Disconnects the provider and destroys the Y.Doc. Safe to call once per
   *  handle (e.g. on unmount/path change in `Editor.tsx`). */
  destroy(): void;
}

export interface CreateCollabProviderOptions {
  /** Vault-relative note path, e.g. "myai/deploy.md". Normalized via
   *  `normalizeNotePath` before becoming the Hocuspocus `documentName` - the
   *  server rejects a connection whose documentName isn't already canonical
   *  (see `collab/auth.ts`'s `assertSafePath` check), so a client-side leading
   *  slash or doubled separator must never reach the wire. */
  path: string;
  /** The collab auth token from `ApiClient.getCollabToken()` (a human session
   *  token) - or an agent API key. `null` while not yet logged in. */
  token: string | null;
  /** Override for tests/non-browser callers; defaults to deriving from
   *  `window.location` (see `deriveCollabWsUrl`). */
  wsUrl?: string;
}

/** Normalizes a note path into the canonical form the server's `assertSafePath`
 *  expects as a Hocuspocus `documentName`: no leading slash, no doubled
 *  separators. Callers already pass a clean vault-relative path in practice
 *  (the note tree/API surface never produces anything else) - this is a client-
 *  side safety net, not a general path-sanitizer (it does not touch `.`/`..`
 *  segments; those are rejected server-side regardless). */
export function normalizeNotePath(path: string): string {
  return path.replace(/\/{2,}/g, "/").replace(/^\/+/, "");
}

/** Builds a fresh `Y.Doc` + Hocuspocus provider for `path`, bound to the
 *  note's `content` Y.Text. The provider connects immediately (see the API
 *  notes above) - callers observe `provider.on("status"/"awarenessUpdate"/...)`
 *  themselves (see `Editor.tsx`) rather than this factory exposing its own
 *  wrapped events, so it stays a thin, easily-fakeable construction seam for
 *  tests (`Editor`'s `providerFactory` prop).
 *
 *  Defaults `wsUrl` via `getCollabWsUrl` (`base-url.ts`): in the browser this
 *  is exactly the old `deriveCollabWsUrl(window.location)` (no regression);
 *  in Tauri it derives from the configured server URL instead. */
export function createCollabProvider(opts: CreateCollabProviderOptions): CollabProviderHandle {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText(CONTENT_FIELD);
  const url = opts.wsUrl ?? getCollabWsUrl(opts.path);

  const provider = new HocuspocusProvider({
    url,
    name: normalizeNotePath(opts.path),
    token: opts.token ?? "",
    document: ydoc,
  });

  return {
    provider,
    ydoc,
    ytext,
    destroy() {
      provider.destroy();
      ydoc.destroy();
    },
  };
}
