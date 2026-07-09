export interface ShutdownDeps {
  app: { close(): Promise<unknown> };
  watcher: { stop(): Promise<unknown> };
  db: { close(): unknown };
}

/**
 * Build an idempotent shutdown routine that releases resources in dependency order:
 * stop accepting HTTP requests, stop the file watcher, then close the database.
 * Running the git/index work to completion before exit avoids leaving a stale
 * .git/index.lock behind when the process is signalled (e.g. `docker stop`).
 * Safe to call more than once: only the first invocation has an effect.
 */
export function createShutdown(deps: ShutdownDeps): () => Promise<void> {
  let started = false;
  return async () => {
    if (started) return;
    started = true;
    await deps.app.close();
    await deps.watcher.stop();
    deps.db.close();
  };
}
