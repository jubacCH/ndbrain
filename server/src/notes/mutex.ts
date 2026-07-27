/**
 * A minimal per-key async lock.
 *
 * Writes to one note must not interleave: read-modify-write on the same file from
 * two requests otherwise loses one of them. v1 learned this the expensive way and
 * ended up retrofitting a shared mutex between the note service and the file
 * watcher, so it is here from the start.
 *
 * Keyed by `owner:path`, so two users writing notes with the same name never
 * queue behind each other.
 */
export class KeyedMutex {
  readonly #queues = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve();

    // Swallow the predecessor's rejection: one failed write must not cascade
    // into every write queued behind it.
    const next = previous.catch(() => undefined).then(fn);

    this.#queues.set(key, next);

    try {
      return await next;
    } finally {
      // Only clear when nothing else queued behind us, or we would drop a lock
      // that a later caller is still waiting on.
      if (this.#queues.get(key) === next) {
        this.#queues.delete(key);
      }
    }
  }

  /** Number of keys currently held — for tests and diagnostics. */
  get size(): number {
    return this.#queues.size;
  }
}
