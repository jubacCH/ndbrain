import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Database } from "../db/database.js";
import { Indexer } from "../index/indexer.js";
import { Vault, VaultPathError } from "../vault/files.js";
import { VaultGit } from "../vault/git.js";
import { NoteService } from "../notes/service.js";
import { NoteExistsError, NoteNotFoundError } from "../notes/errors.js";
import { ScopeError, type Scope } from "../keys/scope.js";
import { NoteTools, type Caller } from "./tools.js";

let dir: string;
let db: Database;
let vault: Vault;
let notes: NoteService;
let tools: NoteTools;

function caller(name: string, scope: Scope, keyId = 1): Caller {
  return { keyId, name, scope };
}

function accessLogRows(): Array<{ key_id: number; tool: string; target: string | null; allowed: number }> {
  return db.prepare("SELECT key_id, tool, target, allowed FROM access_log ORDER BY id").all() as any;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ndbrain-tools-"));
  db = openDatabase(":memory:");
  vault = new Vault(dir);
  const git = new VaultGit(dir);
  await git.init();
  notes = new NoteService(vault, git, new Indexer(db));
  tools = new NoteTools({ db, notes, vault });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const myaiWriter: Scope = { namespace: "myai/", canWrite: true };
const myaiReader: Scope = { namespace: "myai/", canWrite: false };
const fullWriter: Scope = { namespace: "", canWrite: true };

describe("NoteTools.writeNote", () => {
  it("allows an in-scope write and logs allowed=1", async () => {
    const result = await tools.writeNote(caller("myai-key", myaiWriter), {
      path: "myai/a.md",
      content: "# A",
    });
    expect(result).toEqual({ ok: true });
    expect(await notes.read("myai/a.md")).toBe("# A");
    const rows = accessLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "write_note", target: "myai/a.md", allowed: 1 });
  });

  it("denies an out-of-scope write, logs allowed=0 and writes no file", async () => {
    const call = caller("myai-key", myaiWriter);
    await expect(tools.writeNote(call, { path: "other/a.md", content: "# A" })).rejects.toBeInstanceOf(
      ScopeError,
    );
    expect(await notes.read("other/a.md")).toBeNull();
    const rows = accessLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "write_note", target: "other/a.md", allowed: 0 });
  });

  it("denies a write from a read-only key and logs allowed=0", async () => {
    const call = caller("myai-reader", myaiReader);
    await expect(tools.writeNote(call, { path: "myai/a.md", content: "# A" })).rejects.toBeInstanceOf(
      ScopeError,
    );
    expect(await notes.read("myai/a.md")).toBeNull();
    expect(accessLogRows()[0]).toMatchObject({ tool: "write_note", allowed: 0 });
  });

  it("normalizes before the scope check so a raw '..'-prefix cannot smuggle an out-of-scope write", async () => {
    // Raw string starts with "myai/" (the caller's namespace) but normalizes to
    // "other/evil.md" which is out of scope. If isPathInScope ran on the raw string,
    // this would incorrectly pass as in-scope.
    const call = caller("myai-key", myaiWriter);
    await expect(
      tools.writeNote(call, { path: "myai/../other/evil.md", content: "pwned" }),
    ).rejects.toBeInstanceOf(ScopeError);
    expect(await notes.read("other/evil.md")).toBeNull();
    expect(accessLogRows()[0]).toMatchObject({ allowed: 0 });
  });

  it("rejects a path escaping the vault root with a clean VaultPathError, not a crash", async () => {
    const call = caller("full-key", fullWriter);
    await expect(tools.writeNote(call, { path: "../evil.md", content: "pwned" })).rejects.toBeInstanceOf(
      VaultPathError,
    );
    const rows = accessLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "write_note", allowed: 0 });
  });
});

describe("NoteTools.readNote", () => {
  it("returns content for an in-scope note and logs allowed=1", async () => {
    await notes.write("myai/a.md", "# A", "seed");
    const result = await tools.readNote(caller("myai-key", myaiWriter), { path: "myai/a.md" });
    expect(result).toEqual({ found: true, path: "myai/a.md", content: "# A" });
    expect(accessLogRows()[0]).toMatchObject({ tool: "read_note", allowed: 1 });
  });

  it("returns not-found (never leaking existence) for an out-of-scope note and logs allowed=0", async () => {
    await notes.write("other/secret.md", "# Secret", "seed");
    const result = await tools.readNote(caller("myai-key", myaiWriter), { path: "other/secret.md" });
    expect(result).toEqual({ found: false });
    expect(accessLogRows()[0]).toMatchObject({ tool: "read_note", target: "other/secret.md", allowed: 0 });
  });

  it("returns not-found for a missing but in-scope note, still logged as allowed", async () => {
    const result = await tools.readNote(caller("myai-key", myaiWriter), { path: "myai/nope.md" });
    expect(result).toEqual({ found: false });
    expect(accessLogRows()[0]).toMatchObject({ allowed: 1 });
  });
});

describe("NoteTools.listNotes", () => {
  it("only returns paths in the caller's scope", async () => {
    await notes.write("myai/a.md", "# A", "seed");
    await notes.write("other/b.md", "# B", "seed");
    const result = await tools.listNotes(caller("myai-key", myaiWriter));
    expect(result.paths).toEqual(["myai/a.md"]);
  });

  it("logs allowed=0 and rethrows when the underlying vault op throws unexpectedly, so every call still logs a row", async () => {
    const boom = new Error("disk on fire");
    vault.list = async () => {
      throw boom;
    };
    await expect(tools.listNotes(caller("myai-key", myaiWriter))).rejects.toBe(boom);
    const rows = accessLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "list_notes", allowed: 0 });
  });
});

describe("NoteTools.searchNotes", () => {
  it("forces the caller namespace and finds no other/ note", async () => {
    await notes.write("myai/a.md", "# Alpha\nhello world", "seed");
    await notes.write("other/b.md", "# Alpha\nhello world", "seed");
    const result = await tools.searchNotes(caller("myai-key", myaiWriter), { query: "hello" });
    expect(result.hits.map((h) => h.path)).toEqual(["myai/a.md"]);
    expect(accessLogRows()[0]).toMatchObject({ tool: "search_notes", allowed: 1 });
  });

  it("a full-scope caller sees both namespaces (control: proves the myai/ filter above is real)", async () => {
    await notes.write("myai/a.md", "# Alpha\nhello world", "seed");
    await notes.write("other/b.md", "# Alpha\nhello world", "seed");
    const result = await tools.searchNotes(caller("full-key", fullWriter), { query: "hello" });
    expect(result.hits.map((h) => h.path).sort()).toEqual(["myai/a.md", "other/b.md"]);
  });
});

describe("NoteTools.buildContext", () => {
  it("returns not-found for an out-of-scope path and logs allowed=0", async () => {
    await notes.write("other/secret.md", "# Secret", "seed");
    const result = await tools.buildContext(caller("myai-key", myaiWriter), { path: "other/secret.md" });
    expect(result).toEqual({ found: false });
    expect(accessLogRows()[0]).toMatchObject({ tool: "build_context", allowed: 0 });
  });

  it("returns not-found for a missing but in-scope note, still logged as allowed (not conflated with a denial)", async () => {
    const result = await tools.buildContext(caller("myai-key", myaiWriter), { path: "myai/nope.md" });
    expect(result).toEqual({ found: false });
    expect(accessLogRows()[0]).toMatchObject({ tool: "build_context", target: "myai/nope.md", allowed: 1 });
  });

  it("filters backlinks to the caller's scope", async () => {
    await notes.write("myai/target.md", "# Target", "seed");
    await notes.write("myai/b.md", "# B\nSee [[myai/target]]", "seed");
    await notes.write("other/a.md", "# A\nSee [[myai/target]]", "seed");
    const result = await tools.buildContext(caller("myai-key", myaiWriter), { path: "myai/target.md" });
    expect(result.found).toBe(true);
    expect(result.backlinks).toContain("myai/b.md");
    expect(result.backlinks).not.toContain("other/a.md");
  });
});

describe("NoteTools.editNote", () => {
  it("edits an in-scope note and logs allowed=1", async () => {
    await notes.write("myai/a.md", "hello world", "seed");
    await tools.editNote(caller("myai-key", myaiWriter), {
      path: "myai/a.md",
      find: "hello",
      replace: "goodbye",
    });
    expect(await notes.read("myai/a.md")).toBe("goodbye world");
    expect(accessLogRows()[0]).toMatchObject({ tool: "edit_note", allowed: 1 });
  });

  it("propagates NoteNotFoundError as a clean typed error and logs allowed=0", async () => {
    const call = caller("myai-key", myaiWriter);
    await expect(
      tools.editNote(call, { path: "myai/nope.md", find: "a", replace: "b" }),
    ).rejects.toBeInstanceOf(NoteNotFoundError);
    expect(accessLogRows()[0]).toMatchObject({ tool: "edit_note", allowed: 0 });
  });

  it("denies an edit from a read-only key", async () => {
    await notes.write("myai/a.md", "hello", "seed");
    const call = caller("myai-reader", myaiReader);
    await expect(
      tools.editNote(call, { path: "myai/a.md", find: "hello", replace: "bye" }),
    ).rejects.toBeInstanceOf(ScopeError);
    expect(await notes.read("myai/a.md")).toBe("hello");
  });
});

describe("NoteTools.appendNote", () => {
  it("appends to an in-scope note and logs allowed=1", async () => {
    await notes.write("myai/a.md", "line one", "seed");
    await tools.appendNote(caller("myai-key", myaiWriter), { path: "myai/a.md", content: "line two" });
    expect(await notes.read("myai/a.md")).toBe("line one\nline two");
    expect(accessLogRows()[0]).toMatchObject({ tool: "append_note", allowed: 1 });
  });

  it("denies an out-of-scope append", async () => {
    const call = caller("myai-key", myaiWriter);
    await expect(tools.appendNote(call, { path: "other/a.md", content: "x" })).rejects.toBeInstanceOf(
      ScopeError,
    );
    expect(await notes.read("other/a.md")).toBeNull();
  });
});

describe("NoteTools.moveNote", () => {
  it("moves an in-scope note and logs allowed=1", async () => {
    await notes.write("myai/a.md", "# A", "seed");
    await tools.moveNote(caller("myai-key", myaiWriter), { from: "myai/a.md", to: "myai/b.md" });
    expect(await notes.read("myai/a.md")).toBeNull();
    expect(await notes.read("myai/b.md")).toBe("# A");
    expect(accessLogRows()[0]).toMatchObject({ tool: "move_note", allowed: 1 });
  });

  it("denies a move whose target is out of scope, logs allowed=0 and leaves the source untouched", async () => {
    await notes.write("myai/a.md", "# A", "seed");
    const call = caller("myai-key", myaiWriter);
    await expect(tools.moveNote(call, { from: "myai/a.md", to: "other/a.md" })).rejects.toBeInstanceOf(
      ScopeError,
    );
    expect(await notes.read("myai/a.md")).toBe("# A");
    expect(await notes.read("other/a.md")).toBeNull();
    expect(accessLogRows()[0]).toMatchObject({ tool: "move_note", allowed: 0 });
  });

  it("propagates NoteExistsError when the target already exists", async () => {
    await notes.write("myai/a.md", "# A", "seed");
    await notes.write("myai/b.md", "# B", "seed");
    const call = caller("myai-key", myaiWriter);
    await expect(tools.moveNote(call, { from: "myai/a.md", to: "myai/b.md" })).rejects.toBeInstanceOf(
      NoteExistsError,
    );
  });
});

describe("NoteTools.deleteNote", () => {
  it("deletes an in-scope note and logs allowed=1", async () => {
    await notes.write("myai/a.md", "# A", "seed");
    const result = await tools.deleteNote(caller("myai-key", myaiWriter), { path: "myai/a.md" });
    expect(result).toEqual({ ok: true, removed: true });
    expect(await notes.read("myai/a.md")).toBeNull();
    expect(accessLogRows()[0]).toMatchObject({ tool: "delete_note", allowed: 1 });
  });

  it("denies an out-of-scope delete and logs allowed=0", async () => {
    await notes.write("other/a.md", "# A", "seed");
    const call = caller("myai-key", myaiWriter);
    await expect(tools.deleteNote(call, { path: "other/a.md" })).rejects.toBeInstanceOf(ScopeError);
    expect(await notes.read("other/a.md")).toBe("# A");
  });
});
