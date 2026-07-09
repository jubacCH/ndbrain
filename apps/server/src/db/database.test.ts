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

  it("creates api_keys and access_log tables with proper defaults", () => {
    const db = openDatabase(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain("api_keys");
    expect(tables).toContain("access_log");

    // Test that insert with defaults works
    const insertResult = db
      .prepare("INSERT INTO api_keys (name, key_hash) VALUES (?, ?)")
      .run("test-key", "abc123def456");
    expect(insertResult.changes).toBe(1);

    // Verify the inserted row has correct defaults
    const row = db
      .prepare("SELECT name, key_hash, namespace, can_write FROM api_keys WHERE name = ?")
      .get("test-key") as any;
    expect(row.name).toBe("test-key");
    expect(row.key_hash).toBe("abc123def456");
    expect(row.namespace).toBe("");
    expect(row.can_write).toBe(0);
  });
});
