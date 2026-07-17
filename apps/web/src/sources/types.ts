/** The data model for a single ndBrain source. A source is either a remote
 *  `server` (an ndBrain server instance reachable over HTTP/WS) or a local
 *  `folder` (a directory on disk, only usable inside the Tauri desktop
 *  shell). Both kinds are entries in the same registry (see `registry.ts`)
 *  so the sidebar, search, and note editing can treat them uniformly while
 *  still keeping folder sources fully offline - see the plan's isolation
 *  guarantee: a folder source must never trigger a network call. */

import type { ApiClient } from "../api/client";
import type { LocalNotesStore } from "../local/localStore";

export type SourceKind = "server" | "folder";

export interface SourceDef {
  /** Stable identifier, assigned by the registry on creation. Never reused. */
  id: string;
  kind: SourceKind;
  /** User-facing name shown in the sidebar and source pickers. */
  label: string;
  /** Only set when `kind === "server"`: the normalized base URL of the
   *  ndBrain server (no trailing slash). */
  url?: string;
  /** Only set when `kind === "folder"`: the local filesystem path of the
   *  folder this source reads/writes. */
  path?: string;
}

/** Runtime connection state of a single source, independent of every other
 *  source (see `SourcesProvider`'s auth-isolation guarantee).
 *
 *  - `"connecting"`: the initial session probe (or a `retry()`) is in flight.
 *  - `"connected"`: the last probe/login succeeded.
 *  - `"needs-login"`: the server replied 401 (no/expired session) - only
 *    reachable for `kind: "server"` sources.
 *  - `"unreachable"`: the probe failed for any other reason (network error,
 *    DNS failure, TLS error, ...).
 *
 *  Folder sources never leave `"connected"` - they have no network path to
 *  fail on (see the plan's isolation guarantee). */
export type SourceState = "connecting" | "connected" | "needs-login" | "unreachable";

/** A `SourceDef` paired with its live runtime state and the object that
 *  actually talks to it: an `ApiClient` bound to this source's server URL,
 *  or a `LocalNotesStore` bound to this source's folder path. Built and
 *  owned by `SourcesProvider` - one instance per source, never shared across
 *  sources, so each source's auth/network state and connection object are
 *  fully independent of every other source's. */
export type SourceRuntime = { def: SourceDef; state: SourceState } & (
  | { kind: "server"; client: ApiClient }
  | { kind: "folder"; store: LocalNotesStore }
);

/** A note selection scoped to the source it lives in - the sidebar, editor,
 *  and right panels all key off this pair (never a bare path) now that more
 *  than one source can be registered (see `AppState`'s `selection`). */
export interface NoteSelection {
  sourceId: string;
  path: string;
}
