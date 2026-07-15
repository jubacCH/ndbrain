/**
 * Moves a single local note (Task 4's `LocalNotesStore`) to the server —
 * the one and only code path that ever sends a local note's content over the
 * network (see `localStore.ts`'s isolation doc comment: nothing else in the
 * local-notes module tree calls `../api/*`).
 *
 * Order is strict read -> (existence check -> overwrite confirm) -> PUT ->
 * delete, never any other order:
 *
 *   1. `readLocal(rel)` — read the note's current content off disk.
 *   2. `client.getNote(rel)` — check whether a server note already exists at
 *      the same vault-relative path. A 404 (`ApiError` with `status === 404`)
 *      means "no conflict"; any other error (network failure, a non-404
 *      `ApiError`, `UnauthorizedError`, ...) propagates and aborts the move
 *      before anything is written or deleted, same as a `readLocal` failure.
 *   3. Only if a server note exists: `confirmOverwrite(...)` — a second,
 *      explicit confirmation (separate from the plain "move to server?" one
 *      in `LocalNotesView`) since proceeding will overwrite existing server
 *      content. Declining throws `MoveAbortedError` — no PUT, no delete, the
 *      local copy is left untouched.
 *   4. `client.putNote(rel, content)` — upload it to the server at the same
 *      vault-relative path.
 *   5. Only once the PUT has resolved successfully: `deleteLocal(rel)` —
 *      remove the local copy.
 *
 * Rollback semantics: if any step before the PUT throws (unreadable file,
 * network error, non-2xx from the server, declined overwrite confirmation),
 * the local file is left completely untouched and the error propagates to
 * the caller — no data loss, the note simply stays as an unmoved local draft
 * that can be retried. `deleteLocal` is never reached in that case.
 *
 * `LocalNotesStore.deleteLocal` collapses every failure (not just "the file
 * was already gone") to `false` rather than throwing (see its own doc
 * comment — Tauri IPC errors don't carry a reliable ENOENT code to tell the
 * two apart). So `localDeleted: false` in the result does NOT mean the move
 * as a whole failed: the note is already live on the server by that point,
 * only the local cleanup didn't confirm. Callers (see `LocalNotesView`) must
 * surface that case as "moved, but the local copy may still be on disk" —
 * not as an error — and must not retry the PUT.
 */
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { apiClient, ApiError } from "../api/client";
import { localNotesStore, type LocalNotesStore } from "./localStore";

export interface MoveToServerResult {
  /** The vault-relative path the note now lives at on the server (currently
   *  always the same as the local `rel` path passed in). */
  path: string;
  /** Whether the local copy was confirmed removed after the successful PUT.
   *  See the module doc comment above for what `false` does (and does not) mean. */
  localDeleted: boolean;
}

/** Thrown when a server note already exists at the target path and the user
 *  declines the overwrite confirmation. Not a failure in the "something went
 *  wrong" sense — the move was deliberately cancelled, the local copy is
 *  untouched, and nothing was sent to the server. Callers (see
 *  `LocalNotesView`) should treat this distinctly from other errors: no
 *  error banner, just leave the note exactly as it was. */
export class MoveAbortedError extends Error {
  constructor(message = "Move to server was cancelled: a server note already exists at this path.") {
    super(message);
    this.name = "MoveAbortedError";
  }
}

interface ReadClient {
  /** Only used to check existence; the resolved content is not read. Throws
   *  (via the real `ApiClient`) an `ApiError` with `status: 404` when no note
   *  exists at `path` yet. */
  getNote(path: string): Promise<unknown>;
}

export interface MoveToServerDeps {
  /** Injectable for tests; defaults to the shared `localNotesStore` singleton. */
  store?: Pick<LocalNotesStore, "readLocal" | "deleteLocal">;
  /** Injectable for tests; defaults to the shared `apiClient` singleton. */
  client?: ReadClient & { putNote(path: string, content: string): Promise<void> };
  /** Injectable for tests; defaults to `@tauri-apps/plugin-dialog`'s `confirm`.
   *  Only called when a server note already exists at the target path. */
  confirmOverwrite?: (message: string) => Promise<boolean>;
}

/** Resolves whether a server note already exists at `rel`. A 404 is the only
 *  outcome treated as "does not exist" — any other error (network failure, a
 *  different status, an auth error) propagates so the move aborts rather than
 *  silently proceeding to overwrite something we couldn't actually check. */
async function targetExistsOnServer(client: ReadClient, rel: string): Promise<boolean> {
  try {
    await client.getNote(rel);
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return false;
    throw err;
  }
}

export async function moveToServer(rel: string, deps: MoveToServerDeps = {}): Promise<MoveToServerResult> {
  const {
    store = localNotesStore,
    client = apiClient,
    confirmOverwrite = (message: string) =>
      confirmDialog(message, { title: "Overwrite server note?", kind: "warning" }),
  } = deps;

  const content = await store.readLocal(rel);

  if (await targetExistsOnServer(client, rel)) {
    const proceed = await confirmOverwrite(
      `A note already exists on the server at "${rel}". Overwrite it with the local version? This cannot be undone.`,
    );
    if (!proceed) throw new MoveAbortedError();
  }

  await client.putNote(rel, content);
  const localDeleted = await store.deleteLocal(rel);

  return { path: rel, localDeleted };
}
