import { watch, type FSWatcher } from "chokidar";
import { createHash } from "node:crypto";
import { relative, sep } from "node:path";
import type { Vault } from "../vault/files.js";
import type { Indexer } from "../index/indexer.js";
import type { VaultGit } from "../vault/git.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** Watches the vault for external file changes (e.g. Syncthing/SMB) and re-indexes them.
 *  Own writes are suppressed via a content-hash registry filled by markOwnWrite(). */
export class VaultWatcher {
  private fsWatcher: FSWatcher | null = null;
  private ownWrites = new Map<string, string>();
  private ownRemoves = new Set<string>();
  onExternalChange?: (path: string) => void;

  constructor(
    private vault: Vault,
    private indexer: Indexer,
    private git: VaultGit,
  ) {}

  markOwnWrite(path: string, content: string): void {
    this.ownWrites.set(path, hash(content));
  }

  markOwnRemove(path: string): void {
    this.ownRemoves.add(path);
  }

  async start(): Promise<void> {
    this.fsWatcher = watch(this.vault.rootDir, {
      ignored: (p) => p.split(sep).includes(".git") || p.endsWith(".tmp"),
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
    });
    const handle = async (absPath: string) => {
      const rel = relative(this.vault.rootDir, absPath).replaceAll(sep, "/");
      try {
        if (!rel.endsWith(".md")) return;
        const raw = await this.vault.read(rel);
        if (raw === null) return;
        if (this.ownWrites.get(rel) === hash(raw)) {
          this.ownWrites.delete(rel);
          return;
        }
        this.indexer.indexNote(rel, raw);
        await this.git.commitChange(`note: external change ${rel}`, "external", [rel]);
        this.onExternalChange?.(rel);
      } catch (err) {
        console.error("[ndbrain] watcher error for %s:", rel, err);
      }
    };
    const handleUnlink = async (absPath: string) => {
      const rel = relative(this.vault.rootDir, absPath).replaceAll(sep, "/");
      try {
        if (!rel.endsWith(".md")) return;
        if (this.ownRemoves.has(rel)) {
          this.ownRemoves.delete(rel);
          return;
        }
        this.indexer.removeNote(rel);
        await this.git.commitChange(`note: external delete ${rel}`, "external", [rel]);
        this.onExternalChange?.(rel);
      } catch (err) {
        console.error("[ndbrain] watcher error for %s:", rel, err);
      }
    };
    this.fsWatcher
      .on("add", (p) => void handle(p))
      .on("change", (p) => void handle(p))
      .on("unlink", (p) => void handleUnlink(p));
    await new Promise<void>((resolve) => this.fsWatcher!.once("ready", () => resolve()));
  }

  async stop(): Promise<void> {
    await this.fsWatcher?.close();
    this.fsWatcher = null;
  }
}
