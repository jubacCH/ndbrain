export interface ShutdownDeps {
  app: { close(): Promise<unknown> };
  watcher: { stop(): Promise<unknown> };
  db: { close(): unknown };
  /** Optional: flushes any debounced collab-doc stores (see `DocumentManager`)
   *  before the db closes, so a pending edit isn't lost on shutdown. Omitted
   *  in tests/setups that don't wire collab. */
  documents?: { flushAll(): Promise<void> };
}

/**
 * Build an idempotent shutdown routine that releases resources in dependency order:
 * stop accepting HTTP requests (which also stops new collab connections/edits from
 * arriving), flush any pending collab-doc stores, stop the file watcher, then close
 * the database. Running the git/index work to completion before exit avoids leaving
 * a stale .git/index.lock behind when the process is signalled (e.g. `docker stop`).
 * Safe to call more than once: only the first invocation has an effect.
 */
export function createShutdown(deps: ShutdownDeps): () => Promise<void> {
  let started = false;
  return async () => {
    if (started) return;
    started = true;
    await deps.app.close();
    await deps.documents?.flushAll();
    await deps.watcher.stop();
    deps.db.close();
  };
}
