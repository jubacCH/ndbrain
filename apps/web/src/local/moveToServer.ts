/**
 * Moves a single local note (Task 4's `LocalNotesStore`) to the server —
 * the one and only code path that ever sends a local note's content over the
 * network (see `localStore.ts`'s isolation doc comment: nothing else in the
 * local-notes module tree calls `../api/*`).
 *
 * Order is strict PUT-then-delete, never the reverse:
 *
 *   1. `readLocal(rel)` — read the note's current content off disk.
 *   2. `client.putNote(rel, content)` — upload it to the server at the same
 *      vault-relative path.
 *   3. Only once the PUT has resolved successfully: `deleteLocal(rel)` —
 *      remove the local copy.
 *
 * Rollback semantics: if step 1 or step 2 throws (unreadable file, network
 * error, non-2xx from the server), the local file is left completely
 * untouched and the error propagates to the caller — no data loss, the note
 * simply stays as an unmoved local draft that can be retried. `deleteLocal`
 * is never reached in that case.
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
import { apiClient } from "../api/client";
import { localNotesStore, type LocalNotesStore } from "./localStore";

export interface MoveToServerResult {
  /** The vault-relative path the note now lives at on the server (currently
   *  always the same as the local `rel` path passed in). */
  path: string;
  /** Whether the local copy was confirmed removed after the successful PUT.
   *  See the module doc comment above for what `false` does (and does not) mean. */
  localDeleted: boolean;
}

export interface MoveToServerDeps {
  /** Injectable for tests; defaults to the shared `localNotesStore` singleton. */
  store?: Pick<LocalNotesStore, "readLocal" | "deleteLocal">;
  /** Injectable for tests; defaults to the shared `apiClient` singleton. */
  client?: { putNote(path: string, content: string): Promise<void> };
}

export async function moveToServer(rel: string, deps: MoveToServerDeps = {}): Promise<MoveToServerResult> {
  const { store = localNotesStore, client = apiClient } = deps;

  const content = await store.readLocal(rel);
  await client.putNote(rel, content);
  const localDeleted = await store.deleteLocal(rel);

  return { path: rel, localDeleted };
}
