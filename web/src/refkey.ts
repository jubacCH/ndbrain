/**
 * A stable identity for a note, for React keys and selection sets.
 *
 * NUL cannot occur in a vault path, so no owner/path pair can be spelled two
 * ways — which matters, because a collision here would mean the wrong note
 * highlighted, or worse, deleted.
 *
 * In a module of its own, with no imports, rather than in `api.ts` where it
 * started. The brain's graph model needs this one function, and importing it
 * from the api module dragged zod and every server schema along behind it. That
 * is merely a heavier bundle on the main thread; in a worker, where the
 * simulation is headed, it is a second copy of the schema library for the sake
 * of one template string. `api.ts` re-exports it, so nothing else changes.
 */
export function refKey(owner: string, path: string): string {
  return `${owner}\u0000${path}`;
}
