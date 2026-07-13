import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { openDatabase, type Database } from "../db/database.js";
import { DocumentManager } from "../collab/document-manager.js";
import { Indexer } from "../index/indexer.js";
import { Vault } from "../vault/files.js";
import { VaultGit } from "../vault/git.js";
import { NoteService } from "./service.js";
import {
  EditAmbiguousError,
  EditTargetNotFoundError,
  NoteBusyError,
  NoteExistsError,
  NoteNotFoundError,
} from "./errors.js";

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

  it("editNote replaces the single occurrence of find with replace", async () => {
    await svc.write("e.md", "# Title\n\nhello world", "julian");
    await svc.editNote("e.md", "hello world", "goodbye world", "julian");
    expect(await svc.read("e.md")).toBe("# Title\n\ngoodbye world");
  });

  it("editNote rejects with EditAmbiguousError when find occurs more than once", async () => {
    await svc.write("e.md", "foo foo", "julian");
    await expect(svc.editNote("e.md", "foo", "bar", "julian")).rejects.toBeInstanceOf(
      EditAmbiguousError,
    );
    expect(await svc.read("e.md")).toBe("foo foo");
  });

  it("editNote rejects with EditTargetNotFoundError when find is absent", async () => {
    await svc.write("e.md", "foo", "julian");
    await expect(svc.editNote("e.md", "bar", "baz", "julian")).rejects.toBeInstanceOf(
      EditTargetNotFoundError,
    );
    expect(await svc.read("e.md")).toBe("foo");
  });

  it("editNote rejects with NoteNotFoundError when the note does not exist", async () => {
    await expect(svc.editNote("nope.md", "foo", "bar", "julian")).rejects.toBeInstanceOf(
      NoteNotFoundError,
    );
  });

  it("editNote produces exactly one git commit authored by actor", async () => {
    await svc.write("e.md", "foo", "julian");
    await svc.editNote("e.md", "foo", "bar", "actor-edit");
    const history = await git.historyFor("e.md");
    expect(history).toHaveLength(2);
    expect(history[0].author).toBe("actor-edit");
    expect(history[0].message).toBe("note: update e.md");
  });

  it("appendNote appends content with a newline separator to an existing note", async () => {
    await svc.write("a.md", "line one", "julian");
    await svc.appendNote("a.md", "line two", "julian");
    expect(await svc.read("a.md")).toBe("line one\nline two");
  });

  it("appendNote creates the note when it does not exist", async () => {
    await svc.appendNote("new.md", "# New", "julian");
    expect(await svc.read("new.md")).toBe("# New");
    expect((await git.historyFor("new.md"))[0].author).toBe("julian");
  });

  it("editNote replaces with literal string containing $ special chars", async () => {
    await svc.write("e.md", "price: 100", "julian");
    await svc.editNote("e.md", "100", "$&-100 costs $$", "julian");
    expect(await svc.read("e.md")).toBe("price: $&-100 costs $$");
  });

  it("editNote rejects with EditTargetNotFoundError when find is empty", async () => {
    await svc.write("e.md", "foo", "julian");
    await expect(svc.editNote("e.md", "", "bar", "julian")).rejects.toBeInstanceOf(
      EditTargetNotFoundError,
    );
    expect(await svc.read("e.md")).toBe("foo");
  });

  it("EditAmbiguousError has correct name property", () => {
    expect(new EditAmbiguousError("test").name).toBe("EditAmbiguousError");
  });

  describe("live-doc routing (docManager hook)", () => {
    it("write on a live doc lands in the Y.Doc and index, skips the direct commit, and the doc's later store persists it exactly once", async () => {
      const wired = new NoteService(new Vault(dir), git, new Indexer(db));
      const manager = new DocumentManager({ notes: wired });
      wired.setDocManager(manager);

      await wired.write("myai/live-a.md", "# A", "julian");
      const ydoc = new Y.Doc();
      await manager.load("myai/live-a.md", ydoc);

      const before = await git.historyFor("myai/live-a.md");
      await wired.write("myai/live-a.md", "# New", "myai");

      // Landed in the live doc...
      expect(manager.getText(ydoc).toString()).toBe("# New");
      // ...index updated immediately...
      expect(db.prepare("SELECT title FROM notes WHERE path='myai/live-a.md'").get()).toEqual({
        title: "New",
      });
      // ...but no direct file write/commit happened yet.
      expect(await wired.read("myai/live-a.md")).toBe("# A");
      expect((await git.historyFor("myai/live-a.md")).length).toBe(before.length);

      // The doc's own (debounced, here manually flushed) store persists it later,
      // exactly once, attributed to the agent that made the live edit.
      await manager.store("myai/live-a.md", ydoc);
      const history = await git.historyFor("myai/live-a.md");
      expect(history.length).toBe(before.length + 1);
      expect(history[0]?.author).toBe("myai");
      expect(await wired.read("myai/live-a.md")).toBe("# New");
    });

    it("write without a live doc uses the unchanged direct path even with docManager wired", async () => {
      const wired = new NoteService(new Vault(dir), git, new Indexer(db));
      const manager = new DocumentManager({ notes: wired });
      wired.setDocManager(manager);

      await wired.write("myai/live-b.md", "# B", "julian");

      expect(await wired.read("myai/live-b.md")).toBe("# B");
      expect((await git.historyFor("myai/live-b.md"))[0].author).toBe("julian");
    });

    it("editNote on a live doc reads and edits the live doc's current content, not the (possibly stale) file", async () => {
      const wired = new NoteService(new Vault(dir), git, new Indexer(db));
      const manager = new DocumentManager({ notes: wired });
      wired.setDocManager(manager);

      await wired.write("myai/live-e.md", "hello world", "julian");
      const ydoc = new Y.Doc();
      await manager.load("myai/live-e.md", ydoc);
      // A live edit that exists only in the doc, not yet persisted to disk.
      manager.getText(ydoc).insert(manager.getText(ydoc).length, "!!!");
      expect(await wired.read("myai/live-e.md")).toBe("hello world");

      await wired.editNote("myai/live-e.md", "world!!!", "brain", "myai-agent");

      expect(manager.getText(ydoc).toString()).toBe("hello brain");
      // Still no direct file write for the live path.
      expect(await wired.read("myai/live-e.md")).toBe("hello world");
    });

    it("appendNote on a live doc appends to the live doc's current content", async () => {
      const wired = new NoteService(new Vault(dir), git, new Indexer(db));
      const manager = new DocumentManager({ notes: wired });
      wired.setDocManager(manager);

      await wired.write("myai/live-ap.md", "line one", "julian");
      const ydoc = new Y.Doc();
      await manager.load("myai/live-ap.md", ydoc);
      manager.getText(ydoc).insert(manager.getText(ydoc).length, " (live)");

      await wired.appendNote("myai/live-ap.md", "line two", "myai-agent");

      expect(manager.getText(ydoc).toString()).toBe("line one (live)\nline two");
      expect(await wired.read("myai/live-ap.md")).toBe("line one");
    });

    it("appendNote falls back to the direct path when docManager is set but the path is not live", async () => {
      const wired = new NoteService(new Vault(dir), git, new Indexer(db));
      const manager = new DocumentManager({ notes: wired });
      wired.setDocManager(manager);

      await wired.appendNote("myai/live-np.md", "hello", "julian");

      expect(await wired.read("myai/live-np.md")).toBe("hello");
      expect((await git.historyFor("myai/live-np.md"))[0].author).toBe("julian");
    });

    it("move rejects with NoteBusyError when the source is live, and leaves file/index untouched", async () => {
      const wired = new NoteService(new Vault(dir), git, new Indexer(db));
      const manager = new DocumentManager({ notes: wired });
      wired.setDocManager(manager);

      await wired.write("myai/a.md", "# A", "julian");
      const ydoc = new Y.Doc();
      await manager.load("myai/a.md", ydoc);
      expect(manager.isLive("myai/a.md")).toBe(true);

      const before = await git.historyFor("myai/a.md");
      await expect(wired.move("myai/a.md", "myai/b.md", "julian")).rejects.toBeInstanceOf(
        NoteBusyError,
      );

      expect(await wired.read("myai/a.md")).toBe("# A");
      expect(await wired.read("myai/b.md")).toBeNull();
      expect((await git.historyFor("myai/a.md")).length).toBe(before.length);
      expect(db.prepare("SELECT count(*) c FROM notes WHERE path='myai/b.md'").get()).toEqual({
        c: 0,
      });
    });

    it("remove rejects with NoteBusyError when the path is live, and leaves file/index untouched", async () => {
      const wired = new NoteService(new Vault(dir), git, new Indexer(db));
      const manager = new DocumentManager({ notes: wired });
      wired.setDocManager(manager);

      await wired.write("myai/a.md", "# A", "julian");
      const ydoc = new Y.Doc();
      await manager.load("myai/a.md", ydoc);
      expect(manager.isLive("myai/a.md")).toBe(true);

      const before = await git.historyFor("myai/a.md");
      await expect(wired.remove("myai/a.md", "julian")).rejects.toBeInstanceOf(NoteBusyError);

      expect(await wired.read("myai/a.md")).toBe("# A");
      expect((await git.historyFor("myai/a.md")).length).toBe(before.length);
      expect(db.prepare("SELECT count(*) c FROM notes WHERE path='myai/a.md'").get()).toEqual({
        c: 1,
      });
    });

    it("move/remove of a non-live note are unaffected by a docManager being wired", async () => {
      const wired = new NoteService(new Vault(dir), git, new Indexer(db));
      const manager = new DocumentManager({ notes: wired });
      wired.setDocManager(manager);

      await wired.write("myai/not-live.md", "# X", "julian");
      await wired.move("myai/not-live.md", "myai/moved.md", "julian");
      expect(await wired.read("myai/moved.md")).toBe("# X");

      await wired.write("myai/to-remove.md", "# Y", "julian");
      expect(await wired.remove("myai/to-remove.md", "julian")).toBe(true);
      expect(await wired.read("myai/to-remove.md")).toBeNull();
    });
  });

  describe("embedder hook", () => {
    function fakeEmbedder() {
      return { enqueue: vi.fn(), removeNote: vi.fn() };
    }

    it("write enqueues the written content exactly once", async () => {
      const embedder = fakeEmbedder();
      const wired = new NoteService(new Vault(dir), git, new Indexer(db), undefined, undefined, undefined, embedder);
      await wired.write("emb/a.md", "# A", "julian");
      expect(embedder.enqueue).toHaveBeenCalledTimes(1);
      expect(embedder.enqueue).toHaveBeenCalledWith("emb/a.md", "# A");
    });

    it("editNote enqueues the final (post-edit) content", async () => {
      const embedder = fakeEmbedder();
      const wired = new NoteService(new Vault(dir), git, new Indexer(db), undefined, undefined, undefined, embedder);
      await wired.write("emb/e.md", "hello world", "julian");
      embedder.enqueue.mockClear();
      await wired.editNote("emb/e.md", "world", "brain", "julian");
      expect(embedder.enqueue).toHaveBeenCalledTimes(1);
      expect(embedder.enqueue).toHaveBeenCalledWith("emb/e.md", "hello brain");
    });

    it("appendNote enqueues the final (post-append) content", async () => {
      const embedder = fakeEmbedder();
      const wired = new NoteService(new Vault(dir), git, new Indexer(db), undefined, undefined, undefined, embedder);
      await wired.write("emb/ap.md", "line one", "julian");
      embedder.enqueue.mockClear();
      await wired.appendNote("emb/ap.md", "line two", "julian");
      expect(embedder.enqueue).toHaveBeenCalledTimes(1);
      expect(embedder.enqueue).toHaveBeenCalledWith("emb/ap.md", "line one\nline two");
    });

    it("move removes embeddings for the old path and enqueues the moved content under the new path", async () => {
      const embedder = fakeEmbedder();
      const wired = new NoteService(new Vault(dir), git, new Indexer(db), undefined, undefined, undefined, embedder);
      await wired.write("emb/from.md", "# Moved", "julian");
      embedder.enqueue.mockClear();
      await wired.move("emb/from.md", "emb/to.md", "julian");
      expect(embedder.removeNote).toHaveBeenCalledWith("emb/from.md");
      expect(embedder.enqueue).toHaveBeenCalledWith("emb/to.md", "# Moved");
    });

    it("remove removes embeddings for the deleted path", async () => {
      const embedder = fakeEmbedder();
      const wired = new NoteService(new Vault(dir), git, new Indexer(db), undefined, undefined, undefined, embedder);
      await wired.write("emb/r.md", "# R", "julian");
      await wired.remove("emb/r.md", "julian");
      expect(embedder.removeNote).toHaveBeenCalledWith("emb/r.md");
    });

    it("without an embedder, no hook is called and behavior is unchanged (default backward compatibility)", async () => {
      await svc.write("noemb/a.md", "# A", "julian");
      await svc.editNote("noemb/a.md", "A", "B", "julian");
      await svc.appendNote("noemb/a.md", "more", "julian");
      await svc.move("noemb/a.md", "noemb/b.md", "julian");
      expect(await svc.remove("noemb/b.md", "julian")).toBe(true);
      // No embedder wired: nothing above should throw, and content ends up as expected.
    });

    it("a throwing embedder does not break the write, and the write still lands on disk/git/index", async () => {
      const embedder = { enqueue: vi.fn(() => { throw new Error("boom"); }), removeNote: vi.fn() };
      const wired = new NoteService(new Vault(dir), git, new Indexer(db), undefined, undefined, undefined, embedder);
      await expect(wired.write("emb/throw.md", "# Throw", "julian")).resolves.toBeUndefined();
      expect(await wired.read("emb/throw.md")).toBe("# Throw");
      expect(db.prepare("SELECT title FROM notes WHERE path='emb/throw.md'").get()).toEqual({
        title: "Throw",
      });
    });

    it("a throwing removeNote on delete does not break the removal", async () => {
      const embedder = { enqueue: vi.fn(), removeNote: vi.fn(() => { throw new Error("boom"); }) };
      const wired = new NoteService(new Vault(dir), git, new Indexer(db), undefined, undefined, undefined, embedder);
      await wired.write("emb/throw2.md", "# T2", "julian");
      await expect(wired.remove("emb/throw2.md", "julian")).resolves.toBe(true);
      expect(await wired.read("emb/throw2.md")).toBeNull();
    });
  });
});
