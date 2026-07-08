import { describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";

describe("openDatabase", () => {
  it("creates schema idempotently with FTS5", () => {
    const db = openDatabase(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
      .all()
      .map((r: any) => r.name);
    for (const t of ["notes", "links", "users", "sessions", "notes_fts"]) {
      expect(tables).toContain(t);
    }
    db.prepare("INSERT INTO notes_fts (path, title, body) VALUES (?,?,?)").run("a.md", "T", "hello world");
    const hit = db.prepare("SELECT path FROM notes_fts WHERE notes_fts MATCH 'hello'").get() as any;
    expect(hit.path).toBe("a.md");
  });
});
