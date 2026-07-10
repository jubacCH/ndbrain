import { Hocuspocus, type Configuration } from "@hocuspocus/server";
import type { AuthService } from "../http/auth.js";
import type { ApiKeyService } from "../keys/service.js";
import type { DocumentManager } from "./document-manager.js";
import { authenticateCollab, CollabAuthError } from "./auth.js";

export type CollabServerOptions = Partial<Configuration>;

/** Context Hocuspocus attaches to an authenticated connection (merged into
 *  `onAuthenticate`'s payload context) — the actor attributed to edits/stores
 *  made over that connection. See `authenticateCollab`. */
export interface CollabContext {
  actor: string;
}

export interface CollabServerDeps {
  auth: AuthService;
  apiKeys: ApiKeyService;
  documents: DocumentManager;
}

/**
 * The minimal duck-typed surface of a `Hocuspocus` instance that shutdown needs (see
 * `shutdown.ts`/`flushHocuspocusStores`). A real `Hocuspocus` instance structurally
 * satisfies this; kept separate from the concrete class so tests can pass a lightweight
 * fake instead of standing up a real one just to test shutdown's call ordering.
 */
export interface HocuspocusHandle {
  getDocumentsCount(): number;
  closeConnections(documentName?: string): void;
  flushPendingStores(): void;
  // Method-shorthand syntax (not a `afterUnloadDocument?: (payload) => unknown` property)
  // deliberately: TS checks method-shorthand parameters bivariantly, so a real
  // `Hocuspocus.configuration.extensions` (whose `afterUnloadDocument` takes the much
  // more specific `afterUnloadDocumentPayload`) stays structurally assignable here.
  configuration: { extensions: Array<{ afterUnloadDocument?(payload: unknown): unknown }> };
}

export interface FlushOptions {
  /** Timeout in milliseconds for the flush operation (default: 5000ms).
   *  If documents don't drain within this time, the promise resolves anyway
   *  with a warning logged, ensuring the shutdown sequence completes even if
   *  a document hangs. */
  timeoutMs?: number;
}

/**
 * Closes every live collab connection and forces any pending debounced
 * `onStoreDocument` calls to run immediately, then resolves once every currently-loaded
 * document has fully unloaded (i.e. every forced store has actually landed) - so a
 * caller (shutdown.ts, see C2) can safely proceed to `app.close()`/close the database
 * right after, instead of racing an in-flight debounced store.
 *
 * `hocuspocus.closeConnections()` is expected to already have been called by the caller
 * (a distinct, separately-observable step in the shutdown sequence); this only calls
 * `flushPendingStores()` itself. Both verified against the installed
 * `@hocuspocus/server@4.3.0` source (see `Server.destroy()`, the built-in HTTP-owning
 * wrapper class we don't use - we own our own `/collab` upgrade handling in
 * `http/server.ts` instead, but replicate its shutdown technique here):
 *
 * - `flushPendingStores()` immediately runs (`debouncer.executeNow`) every document's
 *   still-debounced `onStoreDocument` call - the only way to force a pending store to
 *   happen right now instead of waiting out its `debounce`/`maxDebounce` window.
 * - Neither `flushPendingStores()` nor `closeConnections()` return a promise for the
 *   triggered work - they fire the debounced/close callbacks synchronously but those
 *   callbacks' own bodies (our `onStoreDocument`/`afterUnloadDocument` hooks) resolve
 *   later, over one or more microtasks. The only after-the-fact signal that a forced
 *   store (and the unload that follows it once `shouldUnloadDocument` is satisfied)
 *   actually finished is `afterUnloadDocument` firing with `getDocumentsCount() === 0`.
 * - The extension is pushed, and `getDocumentsCount()` checked, before
 *   `flushPendingStores()` runs, so no `afterUnloadDocument` it (or the earlier
 *   `closeConnections()`) triggers can be missed - synchronous code between here and
 *   `flushPendingStores()` cannot itself be preempted by the microtask queue, so as long
 *   as nothing here `await`s, this ordering is safe regardless of how many microtask
 *   hops Hocuspocus's own debounce/save-mutex/unload chain takes internally.
 *
 * A bounded timeout ensures this promise always resolves within a reasonable time, even if
 * a document hangs (e.g., a store callback never completes, or unload is blocked). On timeout,
 * a warning is logged and the promise resolves anyway, allowing the shutdown sequence to
 * continue instead of hanging the process until SIGKILL. The timeout is cleared if documents
 * drain before the deadline, so normal completion doesn't incur unnecessary delay.
 */
export function flushHocuspocusStores(hocuspocus: HocuspocusHandle, opts: FlushOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise((resolve) => {
    let timeoutHandle: NodeJS.Timeout | undefined;

    // Set up the cleanup function that clears the timeout.
    const cleanup = () => {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
    };

    const resolveAndCleanup = () => {
      cleanup();
      resolve();
    };

    if (hocuspocus.getDocumentsCount() === 0) {
      resolveAndCleanup();
      return;
    }

    // Set the timeout immediately before adding the extension.
    // If documents don't drain by then, we resolve anyway and log a warning.
    timeoutHandle = setTimeout(() => {
      timeoutHandle = undefined;
      const pendingCount = hocuspocus.getDocumentsCount();
      console.warn(
        `[ndbrain] shutdown flush timed out after ${timeoutMs}ms with ${pendingCount} document(s) still pending, proceeding anyway`,
      );
      resolveAndCleanup();
    }, timeoutMs);

    hocuspocus.configuration.extensions.push({
      afterUnloadDocument: () => {
        if (hocuspocus.getDocumentsCount() === 0) {
          resolveAndCleanup();
        }
      },
    });
    hocuspocus.flushPendingStores();
  });
}

/**
 * Builds the real Hocuspocus collaboration server, wired to the actual
 * auth/persistence services: `onAuthenticate` -> `authenticateCollab` (T6),
 * `onLoadDocument`/`onStoreDocument`/`afterUnloadDocument` -> `DocumentManager`
 * (T3-5,7).
 *
 * Still owns no HTTP/WebSocket listener of its own — it has no port. A host
 * process (Fastify, see `http/server.ts`'s `/collab` upgrade handling) forwards
 * its own WebSocket upgrades into `instance.handleConnection(ws, request,
 * context)`.
 *
 * ## Hook wiring decisions (verified against the installed
 * `@hocuspocus/server@4.3.0` API, see `.superpowers/sdd/p3-task-1-report.md`
 * and the Task 8 report for the full trace)
 *
 * - **onAuthenticate**: `authenticateCollab` returns the *canonical* (normalized)
 *   documentName. Hocuspocus itself already parsed `documentName` from the
 *   client's first wire message before this hook runs. If the two differ (a
 *   traversal segment, a `.` segment, anything `assertSafePath` normalizes
 *   away), we throw rather than silently opening the canonical doc under the
 *   name the client asked for — the client would otherwise believe it opened
 *   one document while actually syncing a different (if equivalent) one.
 *   `readOnly` is wired by *mutating* `connectionConfig.readOnly` (verified in
 *   the installed source: `onAuthenticatePayload.connectionConfig` is the same
 *   object reference Hocuspocus later reads to build the `Connection` and to
 *   enforce read-only at the sync-message layer — it is NOT a value read from
 *   this hook's return value). The hook's return value instead becomes the
 *   connection `context` (merged/spread), which is how `actor` reaches
 *   `onStoreDocument`'s `lastContext`.
 * - **onLoadDocument**: seeds the live doc from the vault via
 *   `DocumentManager.load`, mutating the real `document` (a `Y.Doc` subclass)
 *   Hocuspocus already constructed. Nothing is returned: returning the
 *   `document` itself would be treated as "loaded content" and re-applied onto
 *   itself via `Y.applyUpdate(document, Y.encodeStateAsUpdate(document))` —
 *   harmless (idempotent) but pure overhead, since `DocumentManager.load`
 *   already mutates the live doc in place.
 * - **onStoreDocument only** (NOT `onChange` + `scheduleStore`): Hocuspocus
 *   already debounces `onStoreDocument` per document itself (`debounce`/
 *   `maxDebounce` config, default 2s/10s — verified in `defaultConfiguration`).
 *   Wiring `onChange` (fires undebounced, once per raw update) into
 *   `DocumentManager.scheduleStore` on top of that would stack two independent
 *   debounce timers racing to persist the same path — double-persist risk for
 *   no benefit. `onStoreDocument` fires for every document mutation regardless
 *   of origin (client edit, `DocumentManager.applyAgentWrite`, or
 *   `applyExternal` rebase — verified via `shouldSkipStoreHooks`, which only
 *   special-cases redis/local-with-flag origins, not plain/undefined ones), so
 *   this single hook already covers every write path `DocumentManager` needs.
 *   `lastContext.actor` is the connecting client's actor for real edits; for
 *   origin-less mutations (agent writes, external rebases) it's `undefined`,
 *   and `DocumentManager.store` already falls back to its own `lastWriter`
 *   bookkeeping (populated by `applyAgentWrite`) in that case.
 * - **afterUnloadDocument**: unregisters the path from `DocumentManager`'s live
 *   registry once Hocuspocus has fully unloaded the document (after its own
 *   debounced store settles — see `unloadImmediately`/`shouldUnloadDocument`).
 *
 * `opts` can still override/extend any of the above (e.g. `debounce`/
 * `maxDebounce` for tests) — spread last so callers win.
 */
export function createCollabServer(deps: CollabServerDeps, opts: CollabServerOptions = {}): Hocuspocus {
  return new Hocuspocus<CollabContext>({
    async onAuthenticate({ token, documentName, connectionConfig }) {
      const result = await authenticateCollab(
        { auth: deps.auth, apiKeys: deps.apiKeys },
        { token, documentName },
      );
      if (result.documentName !== documentName) {
        throw new CollabAuthError(`non-canonical document name: ${documentName}`);
      }
      // Mutates the same object Hocuspocus later reads to build the
      // Connection and to enforce read-only at the sync-message layer.
      connectionConfig.readOnly = result.readOnly;
      return { actor: result.actor };
    },
    async onLoadDocument({ documentName, document }) {
      await deps.documents.load(documentName, document);
    },
    async onStoreDocument({ documentName, document, lastContext }) {
      await deps.documents.store(documentName, document, lastContext?.actor);
    },
    async afterUnloadDocument({ documentName }) {
      deps.documents.unload(documentName);
    },
    ...opts,
  });
}
