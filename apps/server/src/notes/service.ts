import type { Vault } from "../vault/files.js";
import type { VaultGit } from "../vault/git.js";
import type { Indexer } from "../index/indexer.js";
import {
  EditAmbiguousError,
  EditTargetNotFoundError,
  NoteBusyError,
  NoteExistsError,
  NoteNotFoundError,
} from "./errors.js";
import { Mutex } from "./mutex.js";

/**
 * The hook `NoteService` uses to route content-mutating writes into a live
 * collaboration doc instead of the file, when one is open for the note's path.
 * `DocumentManager` satisfies this structurally (duck-typed) — `NoteService`
 * never imports it, which keeps this dependency one-directional at the type
 * level even though the two collaborate at runtime.
 */
export interface DocManagerHook {
  /** Returns the live doc's current markdown for `path`, or `undefined` if `path` isn't live. */
  getLiveMarkdown(path: string): string | undefined;
  /** Applies an agent-originated write into the live doc for `path`. Returns `true` if
   *  `path` is live (the write landed in the doc; the caller must NOT also write the file
   *  directly) or `false` if not live (the caller should fall back to a direct write). */
  applyAgentWrite(path: string, newMarkdown: string, actor: string): boolean;
  /** Whether `path` currently has an open live collaboration doc. Used by `move`/`remove`
   *  to refuse mutating a note out from under a live doc (see `NoteBusyError`). */
  isLive(path: string): boolean;
}

/**
 * The hook `NoteService` uses to fire-and-forget embedding work after a content
 * mutation. Deliberately a minimal, locally-defined shape (not the concrete
 * `EmbeddingIndexer` type) so this module stays decoupled from the embedding
 * stack and trivially fakeable in tests. Both methods are contractually
 * non-blocking and non-throwing (see `EmbeddingIndexer`); `NoteService` still
 * guards every call site defensively (see `#notifyEmbedder`) so a misbehaving
 * implementation can never break a write.
 */
export interface EmbedderHook {
  /** Schedules `path` for (re-)embedding with `markdown` as its latest content. */
  enqueue(path: string, markdown: string): void;
  /** Deletes a note's embeddings and drops any not-yet-started job for it. */
  removeNote(path: string): void;
}

/** The single write path for all vault mutations: filesystem -> git commit -> index.
 *
 * Note: each mutation is a three-step sequence (filesystem write -> git commit ->
 * index update) and is NOT atomic. A git failure can leave the on-disk file and the
 * search index diverged from the committed history. This is self-healing: the next
 * successful write of the same path re-runs `git add -A -- <path>` + `indexNote`,
 * reconciling disk, git and index to the latest content.
 *
 * ## Live-doc routing (optional `docManager` hook)
 *
 * When a `docManager` is wired (constructor param or `setDocManager`), every
 * content-mutating path (`write`/`editNote`/`appendNote`) first asks it whether the
 * note's path is live (has an open collaboration doc). There are exactly two paths:
 *
 * - **Live**: `docManager.applyAgentWrite(...)` applies the change into the Y.Doc
 *   in memory and returns `true`. We only update the search index right away; the
 *   file is written exactly once, LATER, when the doc's own debounced store
 *   (`DocumentManager.scheduleStore`/`store`) fires. We must NOT also write the
 *   file here — that would be a double write racing the doc's own persistence.
 * - **Not live**: `applyAgentWrite` returns `false` (or there is no `docManager`),
 *   and we fall back to the original direct path: file write -> commit -> index,
 *   exactly once, right now.
 *
 * `docManager` is late-bindable via `setDocManager` (not just the constructor)
 * because `DocumentManager`'s own constructor takes a `NoteService` — wiring code
 * that wants a single shared `NoteService` instance must build this service first,
 * then `DocumentManager`, then attach it back here (mirrors the existing
 * late-binding pattern used for the watcher's external-change hooks). */
export class NoteService {
  constructor(
    private vault: Vault,
    private git: VaultGit,
    private indexer: Indexer,
    private watcher?: { markOwnWrite(path: string, content: string): void; markOwnRemove(path: string): void },
    // Shared serialization queue; a private one keeps existing callers backward-compatible.
    private mutex: Mutex = new Mutex(),
    private docManager?: DocManagerHook,
    private embedder?: EmbedderHook,
  ) {}

  /** Late-binds the live-doc hook after construction — see the class doc comment
   *  for why this is needed alongside the constructor param. */
  setDocManager(docManager: DocManagerHook): void {
    this.docManager = docManager;
  }

  /** Fire-and-forget `enqueue`/`removeNote` call, guarded so a misbehaving embedder
   *  (a synchronous throw, against its own contract) can never break a write/move/
   *  remove that already succeeded on disk, in git and in the search index. Never
   *  awaited by callers — embedding must add zero latency to the mutex-critical
   *  write path. */
  #notifyEmbedder(fn: (embedder: EmbedderHook) => void): void {
    if (!this.embedder) return;
    try {
      fn(this.embedder);
    } catch (err) {
      console.warn("[ndbrain] note service: embedder hook threw, ignoring:", err);
    }
  }

  read(path: string): Promise<string | null> {
    return this.vault.read(path);
  }

  /** Unlocked write body: filesystem -> git commit -> index, unconditionally (no
   *  live-doc routing). Callers MUST invoke this from inside their own
   *  `this.mutex.run(...)` — the mutex is not reentrant, so calling `write()`
   *  (which locks) from within an already-locked task deadlocks. */
  async #writeInner(path: string, content: string, actor: string): Promise<void> {
    this.watcher?.markOwnWrite(path, content);
    await this.vault.write(path, content);
    await this.git.commitChange(`note: update ${path}`, actor, [path]);
    this.indexer.indexNote(path, content);
    this.#notifyEmbedder((embedder) => embedder.enqueue(path, content));
  }

  /** Unlocked routing body shared by `write`/`editNote`/`appendNote`: sends `content`
   *  either into the live doc (index-only, no direct write) or through `#writeInner`
   *  (direct write), per the class doc comment. Callers MUST invoke this from inside
   *  their own `this.mutex.run(...)`, same reentrancy caveat as `#writeInner`. */
  async #route(path: string, content: string, actor: string): Promise<void> {
    if (this.docManager?.applyAgentWrite(path, content, actor)) {
      this.indexer.indexNote(path, content);
      return;
    }
    await this.#writeInner(path, content, actor);
  }

  write(path: string, content: string, actor: string): Promise<void> {
    return this.mutex.run(() => this.#route(path, content, actor));
  }

  /**
   * Direct, unconditional write — filesystem -> git commit -> index — that bypasses
   * the live-doc routing in `write`/`editNote`/`appendNote`. Reserved for
   * `DocumentManager`'s own persistence pipeline (`store`/`scheduleStore`): when a
   * live doc's debounced store fires, it must actually reach disk even though the
   * path is (by definition, since it's the doc being stored) still live. Routing
   * that call back through `write()` would re-enter `applyAgentWrite`, which would
   * see the path is still live, no-op the already-matching Y.Doc content, and skip
   * the file write forever — `writeDirect` breaks that loop. Not intended for
   * general callers; use `write` for those.
   */
  writeDirect(path: string, content: string, actor: string): Promise<void> {
    return this.mutex.run(() => this.#writeInner(path, content, actor));
  }

  /**
   * Moves/renames a note. Rejects with `NoteBusyError` (no file/index touched) if `from`
   * is currently live: deleting the file at `from` while its doc is still open there
   * would let the doc's own later debounced store write the file straight back under the
   * old path, leaving the note duplicated under both `from` and `to`. This is the
   * documented v1 decision (see I1 in the Plan 3 hardening report): refuse the mutation
   * and let the caller retry once the note isn't being edited live, rather than trying to
   * migrate/rebind the live doc onto the new path.
   */
  move(from: string, to: string, actor: string): Promise<void> {
    return this.mutex.run(async () => {
      if (this.docManager?.isLive(from))
        throw new NoteBusyError(`note is open in a live session, try again later: ${from}`);
      const raw = await this.vault.read(from);
      if (raw === null) throw new NoteNotFoundError(`note not found: ${from}`);
      if ((await this.vault.read(to)) !== null)
        throw new NoteExistsError(`note already exists: ${to}`);
      this.watcher?.markOwnRemove(from);
      this.watcher?.markOwnWrite(to, raw);
      await this.vault.move(from, to);
      await this.git.commitChange(`note: move ${from} -> ${to}`, actor, [from, to]);
      this.indexer.renameNote(from, to, raw);
      this.#notifyEmbedder((embedder) => embedder.removeNote(from));
      this.#notifyEmbedder((embedder) => embedder.enqueue(to, raw));
    });
  }

  /** Reads the "current" content for `path`: the live doc's markdown if `path` is
   *  live (so edits target what's actually on screen, not a possibly-stale file —
   *  otherwise an agent edit would race concurrent live human edits), else the file. */
  async #currentContent(path: string): Promise<string | null> {
    const live = this.docManager?.getLiveMarkdown(path);
    return live ?? (await this.vault.read(path));
  }

  /** Find-and-replace: `find` must occur exactly once in the note, otherwise rejects
   *  without writing. Read, replace and write happen atomically inside one lock so no
   *  other mutation can land between the occurrence count and the write.
   *
   *  For a live doc, "the note" means the live doc's current markdown (via
   *  `docManager.getLiveMarkdown`), not the on-disk file, which may lag behind it. */
  editNote(path: string, find: string, replace: string, actor: string): Promise<void> {
    return this.mutex.run(async () => {
      const content = await this.#currentContent(path);
      if (content === null) throw new NoteNotFoundError(`note not found: ${path}`);
      if (find === "") throw new EditTargetNotFoundError(`find string must not be empty`);
      const occurrences = content.split(find).length - 1;
      if (occurrences === 0) throw new EditTargetNotFoundError(`edit target not found in ${path}`);
      if (occurrences > 1) throw new EditAmbiguousError(`edit target ambiguous in ${path}`);
      const updated = content.replace(find, () => replace);
      await this.#route(path, updated, actor);
    });
  }

  /** Appends `content` to the note, separated by a newline; creates the note with
   *  `content` if it does not yet exist. For a live doc, appends to the live doc's
   *  current markdown (see `editNote`'s doc comment for why). */
  appendNote(path: string, content: string, actor: string): Promise<void> {
    return this.mutex.run(async () => {
      const existing = await this.#currentContent(path);
      const updated = existing === null ? content : `${existing}\n${content}`;
      await this.#route(path, updated, actor);
    });
  }

  /**
   * Deletes a note. Rejects with `NoteBusyError` (no file/index touched) if `path` is
   * currently live, for the same reason `move` does (see its doc comment): a live doc's
   * later debounced store would otherwise resurrect the deleted file.
   */
  remove(path: string, actor: string): Promise<boolean> {
    return this.mutex.run(async () => {
      if (this.docManager?.isLive(path))
        throw new NoteBusyError(`note is open in a live session, try again later: ${path}`);
      this.watcher?.markOwnRemove(path);
      const removed = await this.vault.remove(path);
      if (removed) {
        await this.git.commitChange(`note: delete ${path}`, actor, [path]);
        this.indexer.removeNote(path);
        this.#notifyEmbedder((embedder) => embedder.removeNote(path));
      }
      return removed;
    });
  }
}
