import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { openDatabase, type Database } from "../db/database.js";
import { Indexer } from "../index/indexer.js";
import { Vault } from "../vault/files.js";
import { VaultGit } from "../vault/git.js";
import { NoteService } from "../notes/service.js";
import { DocumentManager } from "./document-manager.js";

let dir: string;
let db: Database;
let notes: NoteService;
let manager: DocumentManager;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ndbrain-docmgr-"));
  db = openDatabase(":memory:");
  const git = new VaultGit(dir);
  await git.init();
  notes = new NoteService(new Vault(dir), git, new Indexer(db));
  manager = new DocumentManager({ notes });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("DocumentManager", () => {
  it("is not live before load", () => {
    expect(manager.isLive("myai/a.md")).toBe(false);
  });

  it("load seeds the Y.Text with the note's file content and registers it as live", async () => {
    await notes.write("myai/a.md", "# A", "julian");
    const ydoc = new Y.Doc();

    await manager.load("myai/a.md", ydoc);

    expect(manager.getText(ydoc).toString()).toBe("# A");
    expect(manager.isLive("myai/a.md")).toBe(true);
  });

  it("load of a missing note seeds empty text and is live (new note)", async () => {
    const ydoc = new Y.Doc();

    await manager.load("myai/new.md", ydoc);

    expect(manager.getText(ydoc).toString()).toBe("");
    expect(manager.isLive("myai/new.md")).toBe(true);
  });

  it("unload removes the live registry entry", async () => {
    await notes.write("a.md", "# A", "julian");
    const ydoc = new Y.Doc();
    await manager.load("a.md", ydoc);
    expect(manager.isLive("a.md")).toBe(true);

    manager.unload("a.md");

    expect(manager.isLive("a.md")).toBe(false);
  });

  it("load rejects unsafe paths without registering anything", async () => {
    const ydoc = new Y.Doc();

    await expect(manager.load("../evil.md", ydoc)).rejects.toThrow();

    expect(manager.isLive("../evil.md")).toBe(false);
  });

  it("second load of same path with same ydoc is idempotent and preserves in-memory edits", async () => {
    await notes.write("myai/a.md", "# A", "julian");
    const ydoc = new Y.Doc();
    await manager.load("myai/a.md", ydoc);
    expect(manager.getText(ydoc).toString()).toBe("# A");

    // Mutate the live ytext in memory
    manager.getText(ydoc).insert(manager.getText(ydoc).length, " extra");
    expect(manager.getText(ydoc).toString()).toBe("# A extra");

    // Load again — should be a no-op and preserve the in-memory edit
    await manager.load("myai/a.md", ydoc);

    // In-memory edit is preserved, not reset to file content
    expect(manager.getText(ydoc).toString()).toBe("# A extra");
    expect(manager.isLive("myai/a.md")).toBe(true);
  });

  it("load of same path with different ydoc is a no-op and keeps first-loaded ydoc", async () => {
    await notes.write("myai/a.md", "# A", "julian");
    const ydoc1 = new Y.Doc();
    const ydoc2 = new Y.Doc();

    // Load path with ydoc1
    await manager.load("myai/a.md", ydoc1);
    manager.getText(ydoc1).insert(manager.getText(ydoc1).length, " from ydoc1");
    expect(manager.getText(ydoc1).toString()).toBe("# A from ydoc1");

    // Try to load same path with ydoc2 — should be a no-op
    await manager.load("myai/a.md", ydoc2);

    // ydoc1 is still live with its content preserved
    expect(manager.getText(ydoc1).toString()).toBe("# A from ydoc1");
    expect(manager.isLive("myai/a.md")).toBe(true);
    // ydoc2 is empty (never seeded)
    expect(manager.getText(ydoc2).toString()).toBe("");
  });
});
