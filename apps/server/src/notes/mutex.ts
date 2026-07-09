/** A minimal promise-chain mutex: serializes async tasks so each runs only after the
 *  previous one has settled. Shared between NoteService and VaultWatcher so that
 *  API-driven and external-change commits never interleave on the same git repo.
 *
 *  This is the single serialization seam for vault mutations; a future CRDT write-queue
 *  can replace it here without touching its callers. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  /** Queue `fn` to run after all previously queued tasks have settled; returns its result. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => fn());
    // Swallow settlement on the chain so one task's rejection cannot break the queue,
    // while callers still observe the real result/rejection via `result`.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
