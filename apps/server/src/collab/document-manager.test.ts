import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { openDatabase, type Database } from "../db/database.js";
import { Indexer } from "../index/indexer.js";
import { Vault } from "../vault/files.js";
import { VaultGit } from "../vault/git.js";
import { NoteService } from "../notes/service.js";
import { DocumentManager } from "./document-manager.js";

let dir: string;
let db: Database;
let git: VaultGit;
let notes: NoteService;
let manager: DocumentManager;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ndbrain-docmgr-"));
  db = openDatabase(":memory:");
  git = new VaultGit(dir);
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

  describe("store", () => {
    it("writes the Y.Text content to the file and creates one git commit authored by the actor", async () => {
      await notes.write("myai/a.md", "# A", "julian");
      const ydoc = new Y.Doc();
      await manager.load("myai/a.md", ydoc);
      manager.getText(ydoc).insert(manager.getText(ydoc).length, " extra");

      const before = await git.historyFor("myai/a.md");
      await manager.store("myai/a.md", ydoc, "julian");

      expect(await notes.read("myai/a.md")).toBe("# A extra");
      const after = await git.historyFor("myai/a.md");
      expect(after.length).toBe(before.length + 1);
      expect(after[0]?.author).toBe("julian");
    });

    it("is a no-op (no new commit) when the serialized content matches the current file content", async () => {
      await notes.write("myai/a.md", "# A", "julian");
      const ydoc = new Y.Doc();
      await manager.load("myai/a.md", ydoc);

      const before = await git.historyFor("myai/a.md");
      await manager.store("myai/a.md", ydoc, "julian");
      const after = await git.historyFor("myai/a.md");

      expect(after.length).toBe(before.length);
      expect(await notes.read("myai/a.md")).toBe("# A");
    });

    it("falls back to the 'collab' actor when none is provided and no prior writer is known", async () => {
      const ydoc = new Y.Doc();
      await manager.load("myai/new.md", ydoc);
      manager.getText(ydoc).insert(0, "# New");

      await manager.store("myai/new.md", ydoc);

      const history = await git.historyFor("myai/new.md");
      expect(history[0]?.author).toBe("collab");
    });
  });

  describe("scheduleStore / flush / flushAll", () => {
    it("collapses 3 rapid schedules into exactly one commit after flush", async () => {
      await notes.write("myai/a.md", "# A", "julian");
      const ydoc = new Y.Doc();
      await manager.load("myai/a.md", ydoc);

      const before = await git.historyFor("myai/a.md");

      manager.scheduleStore("myai/a.md", ydoc, "julian", 1500);
      manager.getText(ydoc).insert(manager.getText(ydoc).length, " one");
      manager.scheduleStore("myai/a.md", ydoc, "julian", 1500);
      manager.getText(ydoc).insert(manager.getText(ydoc).length, " two");
      manager.scheduleStore("myai/a.md", ydoc, "julian", 1500);
      manager.getText(ydoc).insert(manager.getText(ydoc).length, " three");

      await manager.flush("myai/a.md");

      expect(await notes.read("myai/a.md")).toBe("# A one two three");
      const after = await git.historyFor("myai/a.md");
      expect(after.length).toBe(before.length + 1);
    });

    it("flush is a no-op when nothing is pending for the path", async () => {
      await notes.write("myai/a.md", "# A", "julian");
      const before = await git.historyFor("myai/a.md");

      await manager.flush("myai/a.md");

      const after = await git.historyFor("myai/a.md");
      expect(after.length).toBe(before.length);
    });

    it("flushAll flushes all pending paths", async () => {
      await notes.write("myai/a.md", "# A", "julian");
      await notes.write("myai/b.md", "# B", "julian");
      const ydocA = new Y.Doc();
      const ydocB = new Y.Doc();
      await manager.load("myai/a.md", ydocA);
      await manager.load("myai/b.md", ydocB);

      manager.getText(ydocA).insert(manager.getText(ydocA).length, " a-extra");
      manager.getText(ydocB).insert(manager.getText(ydocB).length, " b-extra");
      manager.scheduleStore("myai/a.md", ydocA, "julian", 1500);
      manager.scheduleStore("myai/b.md", ydocB, "julian", 1500);

      await manager.flushAll();

      expect(await notes.read("myai/a.md")).toBe("# A a-extra");
      expect(await notes.read("myai/b.md")).toBe("# B b-extra");
    });

    it("uses the last explicit actor as the fallback for a later store without an actor", async () => {
      await notes.write("myai/a.md", "# A", "julian");
      const ydoc = new Y.Doc();
      await manager.load("myai/a.md", ydoc);

      manager.scheduleStore("myai/a.md", ydoc, "julian", 1500);
      await manager.flush("myai/a.md");
      manager.getText(ydoc).insert(manager.getText(ydoc).length, " more");

      // No actor passed this time — should fall back to the last known writer, "julian".
      await manager.store("myai/a.md", ydoc);

      const history = await git.historyFor("myai/a.md");
      expect(history[0]?.author).toBe("julian");
    });

    // Note: these two tests use REAL timers with short `delayMs` overrides,
    // not `vi.useFakeTimers()`. `store()` goes through `VaultGit`/simple-git,
    // which spawns a real child process; vitest's fake timers hang that
    // child process's I/O completion (confirmed experimentally — the tests
    // below time out under fake timers), so real timers + short delays are
    // used instead, per the fallback documented for this task.

    it("flushAll awaits a store already in flight from a timer that fired just before it was called", async () => {
      // Reproduces the shutdown data-loss window: the debounce timer fires and
      // starts `store()` as fire-and-forget (removing its `pending` entry
      // immediately), then `flushAll()` is called before that store settles.
      // `flushAll()` must not see an empty `pending` map and return early — it
      // must await the in-flight commit so a caller exiting right after
      // `flushAll()` can't lose it.
      await notes.write("myai/a.md", "# A", "julian");
      const ydoc = new Y.Doc();
      await manager.load("myai/a.md", ydoc);
      manager.getText(ydoc).insert(manager.getText(ydoc).length, " extra");

      const before = await git.historyFor("myai/a.md");

      // Gate the real write so we can deterministically observe the store
      // still being in flight at the moment flushAll is invoked.
      const originalWrite = notes.write.bind(notes);
      let releaseWrite = () => {};
      const writeGate = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      const writeSpy = vi
        .spyOn(notes, "write")
        .mockImplementation(async (path, content, actor) => {
          await writeGate;
          return originalWrite(path, content, actor);
        });

      manager.scheduleStore("myai/a.md", ydoc, "julian", 10);

      // Let the debounce timer fire; store() starts and immediately blocks
      // inside the gated notes.write — it is now genuinely in flight, and
      // its `pending` entry is already gone.
      await new Promise((resolve) => setTimeout(resolve, 40));

      let flushAllSettled = false;
      const flushAllPromise = manager.flushAll().then(() => {
        flushAllSettled = true;
      });

      // Give flushAll a window to (wrongly) resolve early if it doesn't
      // await the in-flight store.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(flushAllSettled).toBe(false);

      releaseWrite();
      await flushAllPromise;
      expect(flushAllSettled).toBe(true);
      writeSpy.mockRestore();

      expect(await notes.read("myai/a.md")).toBe("# A extra");
      const after = await git.historyFor("myai/a.md");
      expect(after.length).toBe(before.length + 1);
    });

    it("coalesces 3 rapid schedules into exactly one store() call from the real timer, not via flush", async () => {
      // Unlike the flush()-based coalescing test above (which would pass
      // even without clearTimeout, since flush() forces the store directly),
      // this exercises the real setTimeout/clearTimeout path: each
      // scheduleStore call must cancel the previous pending timer so only
      // the last one ever fires.
      //
      // A plain "exactly one new commit" assertion alone would NOT actually
      // prove coalescing here: store() is idempotent (skips the commit when
      // content already matches disk), and Y.Doc mutations are in-place, so
      // even if all 3 timers survived (no clearTimeout) and each called
      // store() with the same, fully-mutated ydoc, only the first would
      // produce a commit and the rest would be harmless no-ops — the commit
      // count would be 1 either way. So the spy on store()'s call count is
      // the real discriminator; the commit-count check is kept alongside it
      // as the sanity check the task asked for.
      await notes.write("myai/a.md", "# A", "julian");
      const ydoc = new Y.Doc();
      await manager.load("myai/a.md", ydoc);

      const before = await git.historyFor("myai/a.md");
      const delayMs = 30;
      const storeSpy = vi.spyOn(manager, "store");

      manager.scheduleStore("myai/a.md", ydoc, "julian", delayMs);
      manager.getText(ydoc).insert(manager.getText(ydoc).length, " one");
      await new Promise((resolve) => setTimeout(resolve, delayMs / 3)); // well under delayMs
      manager.scheduleStore("myai/a.md", ydoc, "julian", delayMs);
      manager.getText(ydoc).insert(manager.getText(ydoc).length, " two");
      await new Promise((resolve) => setTimeout(resolve, delayMs / 3)); // well under delayMs
      manager.scheduleStore("myai/a.md", ydoc, "julian", delayMs);
      manager.getText(ydoc).insert(manager.getText(ydoc).length, " three");

      // Let the single surviving timer actually fire and its store settle.
      await new Promise((resolve) => setTimeout(resolve, delayMs + 100));

      expect(storeSpy).toHaveBeenCalledTimes(1);
      expect(await notes.read("myai/a.md")).toBe("# A one two three");
      const after = await git.historyFor("myai/a.md");
      expect(after.length).toBe(before.length + 1);
    });
  });
});
