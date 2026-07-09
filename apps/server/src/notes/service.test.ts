import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type Database } from "../db/database.js";
import { Indexer } from "../index/indexer.js";
import { Vault } from "../vault/files.js";
import { VaultGit } from "../vault/git.js";
import { NoteService } from "./service.js";
import { NoteExistsError, NoteNotFoundError } from "./errors.js";

let dir: string;
let db: Database;
let svc: NoteService;
let git: VaultGit;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ndbrain-svc-"));
  db = openDatabase(":memory:");
  git = new VaultGit(dir);
  await git.init();
  svc = new NoteService(new Vault(dir), git, new Indexer(db));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("NoteService", () => {
  it("write persists file, commits with actor and indexes", async () => {
    await svc.write("myai/a.md", "# A", "myai-key");
    expect(await svc.read("myai/a.md")).toBe("# A");
    expect((await git.historyFor("myai/a.md"))[0].author).toBe("myai-key");
    expect(db.prepare("SELECT title FROM notes WHERE path='myai/a.md'").get()).toEqual({ title: "A" });
  });

  it("move updates file, index and history", async () => {
    await svc.write("a.md", "# A", "julian");
    await svc.move("a.md", "b/c.md", "julian");
    expect(await svc.read("a.md")).toBeNull();
    expect(db.prepare("SELECT count(*) c FROM notes WHERE path='b/c.md'").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT count(*) c FROM notes WHERE path='a.md'").get()).toEqual({ c: 0 });
    const history = await git.historyFor("b/c.md");
    expect(history).toHaveLength(2);
    expect(history[0].author).toBe("julian");
    expect(history[0].message).toBe("note: move a.md -> b/c.md");
    expect(history[1].message).toBe("note: update a.md");
  });

  it("move rejects with NoteNotFoundError when the source is missing", async () => {
    await expect(svc.move("nope.md", "x.md", "julian")).rejects.toBeInstanceOf(NoteNotFoundError);
  });

  it("move rejects with NoteExistsError and leaves the target untouched", async () => {
    await svc.write("a.md", "# A", "julian");
    await svc.write("b.md", "# B", "julian");
    await expect(svc.move("a.md", "b.md", "julian")).rejects.toBeInstanceOf(NoteExistsError);
    expect(await svc.read("b.md")).toBe("# B");
    expect(await svc.read("a.md")).toBe("# A");
  });

  it("remove deletes file and index rows", async () => {
    await svc.write("a.md", "x", "julian");
    expect(await svc.remove("a.md", "julian")).toBe(true);
    expect(db.prepare("SELECT count(*) c FROM notes").get()).toEqual({ c: 0 });
  });

  it("serializes concurrent writes so each commit keeps its own actor", async () => {
    // Without a shared mutation queue the two commitChange sequences interleave:
    // one commit sweeps the other's staged file under the wrong author (or leaves
    // it as a no-op). The mutex must make both commits land under their own actor.
    await Promise.all([
      svc.write("p1.md", "# One", "actor-one"),
      svc.write("p2.md", "# Two", "actor-two"),
    ]);
    const h1 = await git.historyFor("p1.md");
    const h2 = await git.historyFor("p2.md");
    expect(h1).toHaveLength(1);
    expect(h2).toHaveLength(1);
    expect(h1[0].author).toBe("actor-one");
    expect(h2[0].author).toBe("actor-two");
  });

  it("write marks the path as an own write via the watcher", async () => {
    const watcher = { markOwnWrite: vi.fn(), markOwnRemove: vi.fn() };
    const wired = new NoteService(new Vault(dir), git, new Indexer(db), watcher);
    await wired.write("w.md", "# W", "julian");
    expect(watcher.markOwnWrite).toHaveBeenCalledWith("w.md", "# W");
  });

  it("move marks the source as an own remove and the target as an own write via the watcher", async () => {
    const watcher = { markOwnWrite: vi.fn(), markOwnRemove: vi.fn() };
    const wired = new NoteService(new Vault(dir), git, new Indexer(db), watcher);
    await wired.write("m.md", "# M", "julian");
    watcher.markOwnWrite.mockClear();
    await wired.move("m.md", "n.md", "julian");
    expect(watcher.markOwnRemove).toHaveBeenCalledWith("m.md");
    expect(watcher.markOwnWrite).toHaveBeenCalledWith("n.md", "# M");
  });

  it("remove marks the path as an own remove via the watcher", async () => {
    const watcher = { markOwnWrite: vi.fn(), markOwnRemove: vi.fn() };
    const wired = new NoteService(new Vault(dir), git, new Indexer(db), watcher);
    await wired.write("r.md", "# R", "julian");
    await wired.remove("r.md", "julian");
    expect(watcher.markOwnRemove).toHaveBeenCalledWith("r.md");
  });
});
