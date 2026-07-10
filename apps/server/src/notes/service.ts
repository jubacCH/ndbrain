import type { Vault } from "../vault/files.js";
import type { VaultGit } from "../vault/git.js";
import type { Indexer } from "../index/indexer.js";
import {
  EditAmbiguousError,
  EditTargetNotFoundError,
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
  ) {}

  /** Late-binds the live-doc hook after construction — see the class doc comment
   *  for why this is needed alongside the constructor param. */
  setDocManager(docManager: DocManagerHook): void {
    this.docManager = docManager;
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

  move(from: string, to: string, actor: string): Promise<void> {
    return this.mutex.run(async () => {
      const raw = await this.vault.read(from);
      if (raw === null) throw new NoteNotFoundError(`note not found: ${from}`);
      if ((await this.vault.read(to)) !== null)
        throw new NoteExistsError(`note already exists: ${to}`);
      this.watcher?.markOwnRemove(from);
      this.watcher?.markOwnWrite(to, raw);
      await this.vault.move(from, to);
      await this.git.commitChange(`note: move ${from} -> ${to}`, actor, [from, to]);
      this.indexer.renameNote(from, to, raw);
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

  remove(path: string, actor: string): Promise<boolean> {
    return this.mutex.run(async () => {
      this.watcher?.markOwnRemove(path);
      const removed = await this.vault.remove(path);
      if (removed) {
        await this.git.commitChange(`note: delete ${path}`, actor, [path]);
        this.indexer.removeNote(path);
      }
      return removed;
    });
  }
}
