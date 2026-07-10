import type * as Y from "yjs";
import type { NoteService } from "../notes/service.js";
import { Vault } from "../vault/files.js";
import { readMarkdown, seedYText } from "./serialize.js";

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
 * Owns the live Y.Doc registry for open notes and the load/unload lifecycle
 * around Hocuspocus's `onLoadDocument`/`afterUnloadDocument` hooks.
 *
 * Persistence back to the vault (Task 4) and external-change rebase (Task 5)
 * are deliberately out of scope here — this is load + registry only.
 */
export class DocumentManager {
  private readonly live = new Map<string, Y.Doc>();
  // Per-path actor of the most recent explicit store/scheduleStore call, used
  // as the attribution fallback when a later store runs without one.
  private readonly lastWriter = new Map<string, string>();
  // Per-path debounce state for scheduleStore; at most one pending timer per path.
  private readonly pending = new Map<string, PendingStore>();

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
   * Serializes `ydoc`'s content and persists it to `path` through `NoteService`
   * (git commit + index + shared mutex + watcher own-write suppression).
   *
   * Idempotent: if the serialized content already matches the file's current
   * content, this is a no-op — no write, no commit. `NoteService`/`VaultGit`
   * would themselves skip an empty commit, but checking here also avoids the
   * redundant filesystem write and index update.
   *
   * `actor` is optional: if omitted, falls back to the last explicit actor
   * seen for this path (via a prior `store`/`scheduleStore` call), and to
   * `"collab"` if none is known yet.
   */
  async store(path: string, ydoc: Y.Doc, actor?: string): Promise<void> {
    pathValidator.assertSafePath(path);
    const resolvedActor = this.resolveActor(path, actor);
    const markdown = readMarkdown(this.getText(ydoc));
    const current = await this.deps.notes.read(path);
    if (current === markdown) return;
    await this.deps.notes.write(path, markdown, resolvedActor);
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
      this.store(path, ydoc, resolvedActor).catch((err) => {
        console.error("[ndbrain] debounced store failed for %s:", path, err);
      });
    }, delayMs);
    this.pending.set(path, { timer, ydoc, actor: resolvedActor });
  }

  /**
   * Immediately runs the pending debounced store for `path`, if any,
   * cancelling its timer first so it doesn't also fire later. A no-op if
   * nothing is pending for `path`.
   */
  async flush(path: string): Promise<void> {
    const pending = this.pending.get(path);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(path);
    await this.store(path, pending.ydoc, pending.actor);
  }

  /** Flushes every path with a pending debounced store. For use on shutdown. */
  async flushAll(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((path) => this.flush(path)));
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
