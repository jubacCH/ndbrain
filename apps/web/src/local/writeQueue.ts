/**
 * Per-path write serializer for local notes.
 *
 * `LocalNotesView` used to call `store.writeLocal(path, content)` directly on
 * every CodeMirror keystroke. Because each call is an independent async
 * Tauri IPC round-trip, nothing guaranteed they settled in the order they
 * were issued — a slow write for an *older* keystroke could resolve after a
 * fast write for a *newer* one, leaving the stale content as the last thing
 * actually persisted to disk (silent data loss).
 *
 * This module guarantees, per path:
 *   - at most one `write()` call in flight at a time — the next enqueued
 *     write always waits for the current one to settle before starting;
 *   - whichever content was most recently enqueued when a write starts is
 *     the content that gets written — intermediate values enqueued while a
 *     write was already in flight are coalesced away rather than each
 *     triggering their own write.
 *
 * Debouncing (delaying when a write is enqueued at all) is the caller's
 * concern (see `LocalNotesView`'s `handleChange`) — this module only cares
 * about ordering and overlap once a write has been requested.
 */

interface PathState {
  /** Content waiting to be written once the current write (if any) settles.
   *  `null` once nothing is queued for this path. */
  pending: string | null;
  /** The in-flight drain loop for this path, or `null` when idle. */
  running: Promise<void> | null;
}

export interface WriteQueue {
  /** Enqueues `content` to be written to `path`. Returns immediately — the
   *  actual write happens on the queue's own schedule (see module doc). */
  enqueue(path: string, content: string): void;
  /** Resolves once every write enqueued for `path` so far has settled.
   *  No-op (resolves immediately) if nothing is pending or in flight for
   *  `path`. */
  flush(path: string): Promise<void>;
  /** `flush`es every path that currently has pending or in-flight work —
   *  used on unmount so no buffered edit is ever silently dropped. */
  flushAll(): Promise<void>;
}

export function createWriteQueue(write: (path: string, content: string) => Promise<void>): WriteQueue {
  const states = new Map<string, PathState>();

  function drain(path: string, state: PathState): void {
    state.running = (async () => {
      while (state.pending !== null) {
        const content = state.pending;
        state.pending = null;
        await write(path, content);
      }
      state.running = null;
    })();
  }

  return {
    enqueue(path, content) {
      let state = states.get(path);
      if (!state) {
        state = { pending: null, running: null };
        states.set(path, state);
      }
      state.pending = content;
      if (!state.running) drain(path, state);
    },

    async flush(path) {
      const state = states.get(path);
      if (!state) return;
      if (state.running) await state.running;
    },

    async flushAll() {
      await Promise.all(Array.from(states.values(), (state) => state.running ?? Promise.resolve()));
    },
  };
}
