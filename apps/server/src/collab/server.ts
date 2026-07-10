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
