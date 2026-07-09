import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Database } from "../db/database.js";
import { Indexer } from "../index/indexer.js";
import { Vault } from "../vault/files.js";
import { VaultGit } from "../vault/git.js";
import { NoteService } from "./service.js";

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
  });

  it("remove deletes file and index rows", async () => {
    await svc.write("a.md", "x", "julian");
    expect(await svc.remove("a.md", "julian")).toBe(true);
    expect(db.prepare("SELECT count(*) c FROM notes").get()).toEqual({ c: 0 });
  });
});
