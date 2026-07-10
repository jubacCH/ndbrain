import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { DocumentManager } from "../collab/document-manager.js";
import { openDatabase } from "../db/database.js";
import { Indexer } from "../index/indexer.js";
import { NoteService } from "../notes/service.js";
import { Vault } from "../vault/files.js";
import { VaultGit } from "../vault/git.js";
import { VaultWatcher } from "./watcher.js";

let dir: string;
let watcher: VaultWatcher;
let db: ReturnType<typeof openDatabase>;
let git: VaultGit;
let indexer: Indexer;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ndbrain-watch-"));
  db = openDatabase(":memory:");
  git = new VaultGit(dir);
  await git.init();
  indexer = new Indexer(db);
  watcher = new VaultWatcher(new Vault(dir), indexer, git);
  await watcher.start();
});
afterEach(async () => {
  await watcher.stop();
  await rm(dir, { recursive: true, force: true });
});

const flush = () => new Promise((r) => setTimeout(r, 400));

describe("VaultWatcher", () => {
  it("indexes externally created notes", async () => {
    const seen = vi.fn();
    watcher.onExternalChange = seen;
    await writeFile(join(dir, "ext.md"), "# External");
    await flush();
    expect(seen).toHaveBeenCalledWith("ext.md");
    expect(db.prepare("SELECT title FROM notes WHERE path='ext.md'").get()).toEqual({ title: "External" });
  });

  it("suppresses events for registered own writes", async () => {
    const seen = vi.fn();
    watcher.onExternalChange = seen;
    watcher.markOwnWrite("own.md", "# Own");
    await writeFile(join(dir, "own.md"), "# Own");
    await flush();
    expect(seen).not.toHaveBeenCalled();
  });

  it("removes externally deleted notes from the index and fires onExternalChange", async () => {
    const seen = vi.fn();
    watcher.onExternalChange = seen;
    await writeFile(join(dir, "gone.md"), "# Gone");
    await flush();
    expect(db.prepare("SELECT count(*) c FROM notes WHERE path='gone.md'").get()).toEqual({ c: 1 });

    seen.mockClear();
    await rm(join(dir, "gone.md"));
    await flush();
    expect(seen).toHaveBeenCalledWith("gone.md");
    expect(db.prepare("SELECT count(*) c FROM notes WHERE path='gone.md'").get()).toEqual({ c: 0 });
  });

  it("does not report a NoteService-driven remove as an external change", async () => {
    const seen = vi.fn();
    const svc = new NoteService(new Vault(dir), git, indexer, watcher);
    await svc.write("a.md", "# A", "julian");
    await flush();
    watcher.onExternalChange = seen;
    await svc.remove("a.md", "julian");
    await flush();
    expect(seen).not.toHaveBeenCalled();
  });

  it("does not report a NoteService-driven move as an external change for either path", async () => {
    const seen = vi.fn();
    const svc = new NoteService(new Vault(dir), git, indexer, watcher);
    await svc.write("a.md", "# A", "julian");
    await flush();
    watcher.onExternalChange = seen;
    await svc.move("a.md", "b.md", "julian");
    await flush();
    expect(seen).not.toHaveBeenCalled();
  });

  it("does not ignore paths merely containing '.git' as a substring (e.g. .github/)", async () => {
    const seen = vi.fn();
    watcher.onExternalChange = seen;
    await mkdir(join(dir, ".github"), { recursive: true });
    await writeFile(join(dir, ".github", "notes.md"), "# CI notes");
    await flush();
    expect(seen).toHaveBeenCalledWith(".github/notes.md");
  });

  it("keeps watching after a handler error", async () => {
    const seen = vi.fn();
    watcher.onExternalChange = seen;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const indexSpy = vi.spyOn(indexer, "indexNote").mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await writeFile(join(dir, "bad.md"), "# Bad");
    await flush();
    expect(seen).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();

    indexSpy.mockRestore();
    await writeFile(join(dir, "good.md"), "# Good");
    await flush();
    expect(seen).toHaveBeenCalledWith("good.md");
    consoleError.mockRestore();
  });

  describe("onExternalChangeApply bridge (external file change -> live Y.Doc)", () => {
    it("rebases an out-of-band file write into a live Y.Doc via applyExternal", async () => {
      const notes = new NoteService(new Vault(dir), git, indexer, watcher);
      const manager = new DocumentManager({ notes });
      watcher.onExternalChangeApply = (path, markdown) => manager.applyExternal(path, markdown);

      await notes.write("a.md", "# A", "julian");
      await flush();
      const ydoc = new Y.Doc();
      await manager.load("a.md", ydoc);
      expect(manager.getText(ydoc).toString()).toBe("# A");

      // Out-of-band write bypassing NoteService entirely (simulates Obsidian/Syncthing).
      await writeFile(join(dir, "a.md"), "# A\n\nExternal edit");
      await flush();

      expect(manager.getText(ydoc).toString()).toBe("# A\n\nExternal edit");
    });

    it("does not fire onExternalChangeApply for a DocumentManager.store of the live doc (no loop)", async () => {
      const notes = new NoteService(new Vault(dir), git, indexer, watcher);
      const manager = new DocumentManager({ notes });
      const seen = vi.fn();
      watcher.onExternalChangeApply = seen;

      await notes.write("a.md", "# A", "julian");
      await flush();
      const ydoc = new Y.Doc();
      await manager.load("a.md", ydoc);
      manager.getText(ydoc).insert(manager.getText(ydoc).length, " extra");

      await manager.store("a.md", ydoc, "julian");
      await flush();

      expect(seen).not.toHaveBeenCalled();
      // Own store must not be rebased back into itself either (no churn).
      expect(manager.getText(ydoc).toString()).toBe("# A extra");
    });
  });
});
