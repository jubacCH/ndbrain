import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.js";
import { Vault } from "../vault/files.js";
import { Indexer } from "./indexer.js";

describe("Indexer", () => {
  it("indexes a note into notes, fts and links", () => {
    const db = openDatabase(":memory:");
    const idx = new Indexer(db);
    idx.indexNote("a.md", "---\ntags: [x]\n---\n# Alpha\nSee [[b]]");
    const note = db.prepare("SELECT * FROM notes WHERE path='a.md'").get() as any;
    expect(note.title).toBe("Alpha");
    expect(JSON.parse(note.frontmatter_json)).toEqual({ tags: ["x"] });
    const link = db.prepare("SELECT target FROM links WHERE source_path='a.md'").get() as any;
    expect(link.target).toBe("b");
    const hit = db.prepare("SELECT path FROM notes_fts WHERE notes_fts MATCH 'Alpha'").get() as any;
    expect(hit.path).toBe("a.md");
  });

  it("re-indexing replaces old fts/link rows; remove cleans up", () => {
    const db = openDatabase(":memory:");
    const idx = new Indexer(db);
    idx.indexNote("a.md", "old [[x]]");
    idx.indexNote("a.md", "new [[y]]");
    expect(db.prepare("SELECT count(*) c FROM links WHERE source_path='a.md'").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT count(*) c FROM notes_fts WHERE path='a.md'").get()).toEqual({ c: 1 });
    idx.removeNote("a.md");
    expect(db.prepare("SELECT count(*) c FROM notes").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT count(*) c FROM notes_fts WHERE path='a.md'").get()).toEqual({ c: 0 });
  });

  it("reindexAll rebuilds the index from the vault", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ndbrain-idx-"));
    const vault = new Vault(dir);
    await vault.write("one.md", "# One");
    await vault.write("sub/two.md", "# Two");
    const db = openDatabase(":memory:");
    const count = await new Indexer(db).reindexAll(vault);
    expect(count).toBe(2);
    await rm(dir, { recursive: true, force: true });
  });
});
