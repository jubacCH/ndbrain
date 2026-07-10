import { flushHocuspocusStores, type HocuspocusHandle } from "./collab/server.js";

export interface ShutdownDeps {
  app: { close(): Promise<unknown> };
  watcher: { stop(): Promise<unknown> };
  db: { close(): unknown };
  /** Optional: flushes any debounced collab-doc stores (see `DocumentManager`)
   *  before the db closes, so a pending edit isn't lost on shutdown. Omitted
   *  in tests/setups that don't wire collab. */
  documents?: { flushAll(): Promise<void> };
  /**
   * Optional: the live Hocuspocus collab server (see C2). Fastify 5's `app.close()`
   * does NOT resolve while an upgraded WebSocket is still open (`forceCloseConnections`
   * defaults to `'idle'`), so a single connected collab client would otherwise hang
   * this whole routine until the process's SIGKILL grace period expires - the exact
   * SIGKILL / stale `.git/index.lock` scenario this routine exists to prevent, on top
   * of losing whatever edit was still inside the debounce window. When wired, every
   * client is disconnected and any pending debounced store is forced and awaited
   * BEFORE `app.close()` runs. Omitted in tests/setups that don't wire collab.
   */
  hocuspocus?: HocuspocusHandle;
  /**
   * Optional: force-closes every raw `/collab` WebSocket (see `http/server.ts`'s
   * `closeCollabSockets`). Needed alongside `hocuspocus` above because Hocuspocus's own
   * `closeConnections()`/`flushHocuspocusStores` only ever touch its *logical*,
   * per-document `Connection` objects — verified against the installed
   * `@hocuspocus/server@4.3.0` source, `Connection.close()` merely sends a wire "close"
   * message over the socket and drops the document's reference to it, it never calls
   * `websocket.close()`. The only thing that does is `ClientConnection`'s `terminate()`,
   * which is TS-`private` and unreachable from `http/server.ts`'s own upgrade wiring
   * anyway (it holds the raw `ws`, never the `ClientConnection` `handleConnection()`
   * returns). Node's own `server.closeAllConnections()` was tried and empirically does
   * NOT reach a socket that went through an 'upgrade' event (verified: it stays
   * reported as an open connection indefinitely) — hence this dedicated hook instead,
   * closing the exact sockets `http/server.ts` itself tracks. Without this,
   * `app.close()` below hangs on the still-open raw socket even after every Hocuspocus-
   * level connection/store has been cleanly flushed and unloaded.
   */
  closeCollabSockets?: () => void;
}

/**
 * Build an idempotent shutdown routine that releases resources in dependency order:
 * disconnect collab clients and flush any pending Hocuspocus-debounced stores, force-
 * close the raw collab sockets (so `app.close()` below never blocks on an open
 * WebSocket and never races an in-flight commit), stop accepting HTTP requests, flush
 * any still-pending collab-doc stores of our own (`DocumentManager.flushAll`), stop the
 * file watcher, then close the database. Running the git/index work to completion
 * before exit avoids leaving a stale `.git/index.lock` behind when the process is
 * signalled (e.g. `docker stop`). Safe to call more than once: only the first
 * invocation has an effect.
 */
export function createShutdown(deps: ShutdownDeps): () => Promise<void> {
  let started = false;
  return async () => {
    if (started) return;
    started = true;
    if (deps.hocuspocus) {
      deps.hocuspocus.closeConnections();
      await flushHocuspocusStores(deps.hocuspocus);
    }
    deps.closeCollabSockets?.();
    await deps.app.close();
    await deps.documents?.flushAll();
    await deps.watcher.stop();
    deps.db.close();
  };
}
