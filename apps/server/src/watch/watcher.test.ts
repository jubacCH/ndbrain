import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/database.js";
import { Indexer } from "../index/indexer.js";
import { Vault } from "../vault/files.js";
import { VaultGit } from "../vault/git.js";
import { VaultWatcher } from "./watcher.js";

let dir: string;
let watcher: VaultWatcher;
let db: ReturnType<typeof openDatabase>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ndbrain-watch-"));
  db = openDatabase(":memory:");
  const git = new VaultGit(dir);
  await git.init();
  watcher = new VaultWatcher(new Vault(dir), new Indexer(db), git);
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
});
