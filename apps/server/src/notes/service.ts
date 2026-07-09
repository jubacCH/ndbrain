import type { Vault } from "../vault/files.js";
import type { VaultGit } from "../vault/git.js";
import type { Indexer } from "../index/indexer.js";

/** The single write path for all vault mutations: filesystem -> git commit -> index. */
export class NoteService {
  constructor(
    private vault: Vault,
    private git: VaultGit,
    private indexer: Indexer,
    private watcher?: { markOwnWrite(path: string, content: string): void },
  ) {}

  read(path: string): Promise<string | null> {
    return this.vault.read(path);
  }

  async write(path: string, content: string, actor: string): Promise<void> {
    this.watcher?.markOwnWrite(path, content);
    await this.vault.write(path, content);
    await this.git.commitChange(`note: update ${path}`, actor);
    this.indexer.indexNote(path, content);
  }

  async move(from: string, to: string, actor: string): Promise<void> {
    const raw = await this.vault.read(from);
    if (raw === null) throw new Error(`note not found: ${from}`);
    await this.vault.move(from, to);
    await this.git.commitChange(`note: move ${from} -> ${to}`, actor);
    this.indexer.renameNote(from, to, raw);
  }

  async remove(path: string, actor: string): Promise<boolean> {
    const removed = await this.vault.remove(path);
    if (removed) {
      await this.git.commitChange(`note: delete ${path}`, actor);
      this.indexer.removeNote(path);
    }
    return removed;
  }
}
