import type * as Y from "yjs";
import type { NoteService } from "../notes/service.js";
import { Vault } from "../vault/files.js";
import { applyExternalChange, readMarkdown, seedYText } from "./serialize.js";

/** The field name under which note content lives in every note's Y.Doc. */
export const CONTENT_FIELD = "content";

/** Default debounce window for `scheduleStore`: how long to wait after the
 *  last scheduled call for a path before actually persisting it. */
const DEFAULT_STORE_DELAY_MS = 1500;

/** Actor attributed to a store when no explicit actor is available (e.g. a
 *  debounced flush triggered by something other than a direct user edit).
 *  Must satisfy `VaultGit`'s actor pattern `/^[A-Za-z0-9._-]+$/`. */
const FALLBACK_ACTOR = "collab";

/** A debounced store waiting to run for a path. */
interface PendingStore {
  timer: ReturnType<typeof setTimeout>;
  ydoc: Y.Doc;
  actor: string;
}

// Reuse a Vault instance to access `assertSafePath` for path validation.
// The empty string `rootDir` is safe because `assertSafePath` is a pure string check:
// it validates format (.md suffix), rejects unsafe patterns (.., /../, /*, .git),
// and never calls `abs()` (which is the only method that touches `rootDir`).
// This avoids threading a `Vault` dependency through `DocumentManager`'s constructor.
const pathValidator = new Vault("");

/**
 * Owns the live Y.Doc registry for open notes, the load/unload lifecycle
 * around Hocuspocus's `onLoadDocument`/`afterUnloadDocument` hooks, and
 * persistence back to the vault (`store`/`scheduleStore`) plus rebasing
 * external file changes into live docs (`applyExternal`).
 */
export class DocumentManager {
  private readonly live = new Map<string, Y.Doc>();
  // Per-path actor of the most recent explicit store/scheduleStore call, used
  // as the attribution fallback when a later store runs without one.
  private readonly lastWriter = new Map<string, string>();
  // Per-path debounce state for scheduleStore; at most one pending timer per path.
  private readonly pending = new Map<string, PendingStore>();
  // Every currently-running store() promise, so flushAll can await commits
  // already underway (e.g. one a debounce timer just started) instead of
  // only seeing the (by-then-empty) `pending` map.
  private readonly inFlight = new Set<Promise<void>>();
  // Same promises, keyed by path, so flush(path) can await an in-flight
  // store for that specific path even when nothing is left in `pending`.
  private readonly inFlightByPath = new Map<string, Promise<void>>();

  constructor(private readonly deps: { notes: NoteService }) {}

  /** The shared content `Y.Text` for a note's `Y.Doc`. */
  getText(ydoc: Y.Doc): Y.Text {
    return ydoc.getText(CONTENT_FIELD);
  }

  /** Whether a `Y.Doc` is currently loaded/registered as live for `path`. */
  isLive(path: string): boolean {
    return this.live.has(path);
  }

  /**
   * Seeds `ydoc`'s content from the note at `path` and registers it as live.
   * A missing note (new note) seeds an empty text rather than failing.
   *
   * This method is idempotent: if `path` is already live, returns early without
   * re-reading the file or overwriting the registry. This guards against double-load
   * scenarios (e.g., Hocuspocus calling onLoadDocument more than once for the same
   * document) which would otherwise clobber unflushed in-memory edits.
   * Semantics: first-load-wins; a second load with a different ydoc is a no-op.
   */
  async load(path: string, ydoc: Y.Doc): Promise<void> {
    pathValidator.assertSafePath(path);
    // If this path is already live, return early without re-seeding or overwriting
    // the registry. This preserves in-memory edits and keeps the first-loaded ydoc.
    if (this.isLive(path)) return;
    const markdown = await this.deps.notes.read(path);
    seedYText(this.getText(ydoc), markdown ?? "");
    this.live.set(path, ydoc);
  }

  /** Removes the live registry entry for `path`. */
  unload(path: string): void {
    this.live.delete(path);
  }

  /**
   * Rebases an out-of-band (external, e.g. Syncthing/Obsidian) file change
   * into `path`'s live Y.Doc, if any, so connected clients see the edit live
   * with cursors/relative positions preserved (Task 2's prefix/suffix diff).
   *
   * No-op if `path` isn't currently live: the vault watcher has already
   * reindexed the file, and there's no in-memory doc to rebase.
   */
  applyExternal(path: string, newMarkdown: string): void {
    const ydoc = this.live.get(path);
    if (!ydoc) return;
    applyExternalChange(ydoc, this.getText(ydoc), newMarkdown);
  }

  /** Returns the live doc's current markdown for `path`, or `undefined` if `path`
   *  isn't live. Used by `NoteService` so `editNote`/`appendNote` read the actually-
   *  displayed content of a live doc instead of a possibly-stale file. */
  getLiveMarkdown(path: string): string | undefined {
    const ydoc = this.live.get(path);
    return ydoc ? readMarkdown(this.getText(ydoc)) : undefined;
  }

  /**
   * Routes an MCP/REST-originated write from `NoteService` into `path`'s live
   * Y.Doc, if one is open, instead of letting it bypass the collab doc and write
   * the file directly — so connected clients see the agent's edit live, with
   * cursors/relative positions preserved (same prefix/suffix diff as `applyExternal`).
   *
   * Called from INSIDE `NoteService`'s `mutex.run` (its write/editNote/appendNote
   * critical section). This method stays a synchronous, in-memory-only mutation of
   * the Y.Doc plus a `lastWriter` bookkeeping update — it never calls back into
   * `NoteService` (no `store`/`write`/`writeDirect` here), so there is no
   * reentrancy or deadlock risk against the non-reentrant `Mutex`. The actual file
   * persistence happens later, out of band, whenever the doc's debounced store
   * (`scheduleStore`/`store`) next fires — which is exactly why `store` below calls
   * `notes.writeDirect` rather than `notes.write`: routing the doc's own persisting
   * write back through `write()` would re-enter this method (the path is still
   * live), no-op against the already-matching content, and skip the file write
   * forever.
   *
   * Returns `true` if `path` is live (the write landed in the doc; the caller must
   * NOT also write the file directly) or `false` if not live (the caller should run
   * its normal direct-write path).
   *
   * Awareness TODO (Task 8): the spec also asks for a transient awareness entry so
   * connected clients can render "<actor> edited". Not implemented here: awareness
   * in Hocuspocus lives on the per-connection `awareness` protocol object handed to
   * `onConnect`/`onLoadDocument` hooks, which `DocumentManager` has no handle on —
   * Task 8 is what wires the Hocuspocus connection context this needs. Faking it
   * (e.g. stashing a plain map here) wouldn't reach any connected client, so this is
   * left as a documented gap rather than a fake implementation.
   */
  applyAgentWrite(path: string, newMarkdown: string, actor: string): boolean {
    const ydoc = this.live.get(path);
    if (!ydoc) return false;
    applyExternalChange(ydoc, this.getText(ydoc), newMarkdown);
    this.lastWriter.set(path, actor);
    return true;
  }

  /**
   * Serializes `ydoc`'s content and persists it to `path` through `NoteService`
   * (git commit + index + shared mutex + watcher own-write suppression).
   *
   * Idempotent: if the serialized content already matches the file's current
   * content, this is a no-op — no write, no commit. `NoteService`/`VaultGit`
   * would themselves skip an empty commit, but checking here also avoids the
   * redundant filesystem write and index update.
   *
   * `actor` is optional: if omitted, falls back to the last explicit actor
   * seen for this path (via a prior `store`/`scheduleStore` call, or an
   * `applyAgentWrite` call attributing an agent write) — and to `"collab"`
   * if none is known yet.
   *
   * Persists via `notes.writeDirect` (not `notes.write`): `path` is live by
   * construction whenever a doc is being stored, so routing through `write`
   * would loop back into `applyAgentWrite` and never reach disk — see that
   * method's doc comment for the full explanation.
   */
  async store(path: string, ydoc: Y.Doc, actor?: string): Promise<void> {
    pathValidator.assertSafePath(path);
    const resolvedActor = this.resolveActor(path, actor);
    const markdown = readMarkdown(this.getText(ydoc));
    const current = await this.deps.notes.read(path);
    if (current === markdown) return;
    await this.deps.notes.writeDirect(path, markdown, resolvedActor);
  }

  /**
   * Debounced `store`: rapid, repeated calls for the same `path` collapse
   * into a single store, `delayMs` after the last call. Intended for
   * Hocuspocus's `onStoreDocument`/`onChange` hooks, which fire far more
   * often than we want to hit the vault/git.
   *
   * Only one pending store per path is tracked; a new call replaces the
   * previous timer (and adopts its ydoc/actor) rather than stacking timers.
   */
  scheduleStore(path: string, ydoc: Y.Doc, actor?: string, delayMs = DEFAULT_STORE_DELAY_MS): void {
    pathValidator.assertSafePath(path);
    const resolvedActor = this.resolveActor(path, actor);
    const existing = this.pending.get(path);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.pending.delete(path);
      this.runStore(path, ydoc, resolvedActor).catch((err) => {
        console.error("[ndbrain] debounced store failed for %s:", path, err);
      });
    }, delayMs);
    this.pending.set(path, { timer, ydoc, actor: resolvedActor });
  }

  /**
   * Runs `store` and tracks the resulting promise as in-flight for `path`
   * until it settles. This closes the shutdown data-loss window where a
   * debounce timer fires (removing its `pending` entry and starting the
   * store as fire-and-forget) and `flushAll`/`flush` is then called before
   * that store lands: both now find and await this promise instead of
   * seeing an empty `pending` map and returning early.
   */
  private runStore(path: string, ydoc: Y.Doc, actor: string): Promise<void> {
    const promise = this.store(path, ydoc, actor).finally(() => {
      this.inFlight.delete(promise);
      if (this.inFlightByPath.get(path) === promise) this.inFlightByPath.delete(path);
    });
    this.inFlight.add(promise);
    this.inFlightByPath.set(path, promise);
    return promise;
  }

  /**
   * Immediately runs the pending debounced store for `path`, if any,
   * cancelling its timer first so it doesn't also fire later. If nothing is
   * pending, awaits an in-flight store for `path` instead (one a debounce
   * timer already started just before this call), if any; otherwise a no-op.
   */
  async flush(path: string): Promise<void> {
    const pending = this.pending.get(path);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(path);
      await this.runStore(path, pending.ydoc, pending.actor);
      return;
    }
    await this.inFlightByPath.get(path);
  }

  /**
   * Flushes every path with a pending debounced store, then awaits every
   * store still in flight (including ones a timer already started, whose
   * `pending` entry is already gone) — repeating until both are drained, in
   * case awaiting settles triggers new stores. For use on shutdown: this is
   * what guarantees a caller exiting right after `flushAll()` resolves can't
   * lose a commit that was already underway when it was called.
   */
  async flushAll(): Promise<void> {
    for (;;) {
      const pendingPaths = [...this.pending.keys()];
      if (pendingPaths.length > 0) {
        await Promise.allSettled(pendingPaths.map((path) => this.flush(path)));
      }
      if (this.inFlight.size > 0) {
        await Promise.allSettled([...this.inFlight]);
      }
      if (this.pending.size === 0 && this.inFlight.size === 0) break;
    }
  }

  /** Resolves the actor to attribute a store to: an explicit `actor` also
   *  becomes the new last-writer for `path`; omitting it falls back to the
   *  last known writer, then to `FALLBACK_ACTOR`. */
  private resolveActor(path: string, actor?: string): string {
    if (actor) {
      this.lastWriter.set(path, actor);
      return actor;
    }
    return this.lastWriter.get(path) ?? FALLBACK_ACTOR;
  }
}
