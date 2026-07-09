import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
