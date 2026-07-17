/** The data model for a single ndBrain source. A source is either a remote
 *  `server` (an ndBrain server instance reachable over HTTP/WS) or a local
 *  `folder` (a directory on disk, only usable inside the Tauri desktop
 *  shell). Both kinds are entries in the same registry (see `registry.ts`)
 *  so the sidebar, search, and note editing can treat them uniformly while
 *  still keeping folder sources fully offline - see the plan's isolation
 *  guarantee: a folder source must never trigger a network call. */

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
