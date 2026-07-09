import type { Vault } from "../vault/files.js";
import type { VaultGit } from "../vault/git.js";
import type { Indexer } from "../index/indexer.js";
import { NoteExistsError, NoteNotFoundError } from "./errors.js";

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
  ) {}

  read(path: string): Promise<string | null> {
    return this.vault.read(path);
  }

  async write(path: string, content: string, actor: string): Promise<void> {
    this.watcher?.markOwnWrite(path, content);
    await this.vault.write(path, content);
    await this.git.commitChange(`note: update ${path}`, actor, [path]);
    this.indexer.indexNote(path, content);
  }

  async move(from: string, to: string, actor: string): Promise<void> {
    const raw = await this.vault.read(from);
    if (raw === null) throw new NoteNotFoundError(`note not found: ${from}`);
    if ((await this.vault.read(to)) !== null)
      throw new NoteExistsError(`note already exists: ${to}`);
    this.watcher?.markOwnRemove(from);
    this.watcher?.markOwnWrite(to, raw);
    await this.vault.move(from, to);
    await this.git.commitChange(`note: move ${from} -> ${to}`, actor, [from, to]);
    this.indexer.renameNote(from, to, raw);
  }

  async remove(path: string, actor: string): Promise<boolean> {
    this.watcher?.markOwnRemove(path);
    const removed = await this.vault.remove(path);
    if (removed) {
      await this.git.commitChange(`note: delete ${path}`, actor, [path]);
      this.indexer.removeNote(path);
    }
    return removed;
  }
}
