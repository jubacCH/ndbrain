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

/** The single write path for all vault mutations: filesystem -> git commit -> index.
 *
 * Note: each mutation is a three-step sequence (filesystem write -> git commit ->
 * index update) and is NOT atomic. A git failure can leave the on-disk file and the
 * search index diverged from the committed history. This is self-healing: the next
 * successful write of the same path re-runs `git add -A -- <path>` + `indexNote`,
 * reconciling disk, git and index to the latest content. */
export class NoteService {
  constructor(
    private vault: Vault,
    private git: VaultGit,
    private indexer: Indexer,
    private watcher?: { markOwnWrite(path: string, content: string): void; markOwnRemove(path: string): void },
    // Shared serialization queue; a private one keeps existing callers backward-compatible.
    private mutex: Mutex = new Mutex(),
  ) {}

  read(path: string): Promise<string | null> {
    return this.vault.read(path);
  }

  /** Unlocked write body: filesystem -> git commit -> index. Callers MUST invoke this
   *  from inside their own `this.mutex.run(...)` — the mutex is not reentrant, so
   *  calling `write()` (which locks) from within an already-locked task deadlocks. */
  async #writeInner(path: string, content: string, actor: string): Promise<void> {
    this.watcher?.markOwnWrite(path, content);
    await this.vault.write(path, content);
    await this.git.commitChange(`note: update ${path}`, actor, [path]);
    this.indexer.indexNote(path, content);
  }

  write(path: string, content: string, actor: string): Promise<void> {
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

  /** Find-and-replace: `find` must occur exactly once in the note, otherwise rejects
   *  without writing. Read, replace and write happen atomically inside one lock so no
   *  other mutation can land between the occurrence count and the write. */
  editNote(path: string, find: string, replace: string, actor: string): Promise<void> {
    return this.mutex.run(async () => {
      const content = await this.vault.read(path);
      if (content === null) throw new NoteNotFoundError(`note not found: ${path}`);
      if (find === "") throw new EditTargetNotFoundError(`find string must not be empty`);
      const occurrences = content.split(find).length - 1;
      if (occurrences === 0) throw new EditTargetNotFoundError(`edit target not found in ${path}`);
      if (occurrences > 1) throw new EditAmbiguousError(`edit target ambiguous in ${path}`);
      const updated = content.replace(find, () => replace);
      await this.#writeInner(path, updated, actor);
    });
  }

  /** Appends `content` to the note, separated by a newline; creates the note with
   *  `content` if it does not yet exist. */
  appendNote(path: string, content: string, actor: string): Promise<void> {
    return this.mutex.run(async () => {
      const existing = await this.vault.read(path);
      const updated = existing === null ? content : `${existing}\n${content}`;
      await this.#writeInner(path, updated, actor);
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
