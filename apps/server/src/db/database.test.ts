import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DatabaseCtor from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase, SCHEMA_VERSION } from "./database.js";

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

describe("schema migrations", () => {
  it("brings a fresh :memory: DB to the latest schema version, with the new column and index present", () => {
    const db = openDatabase(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);

    const cols = (db.prepare("PRAGMA table_info(api_keys)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("revoked_at");

    const indexes = (db.prepare("PRAGMA index_list(access_log)").all() as { name: string }[]).map(
      (i) => i.name,
    );
    expect(indexes).toContain("idx_access_log_key_ts");
  });

  it("migrates a pre-migration-system DB file up to the latest version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ndbrain-migrate-"));
    const path = join(dir, "test.db");
    try {
      // Simulate a DB written before the migrator existed: api_keys has no revoked_at
      // column, access_log has no lookup index. Stamp it as schema version 1 (the
      // migrator's baseline) to mirror what a never-versioned old DB looks like.
      const raw = new DatabaseCtor(path);
      raw.exec(`
        CREATE TABLE api_keys (
          id INTEGER PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          key_hash TEXT NOT NULL,
          namespace TEXT NOT NULL DEFAULT '',
          can_write INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT,
          last_used_at TEXT
        );
        CREATE TABLE access_log (
          id INTEGER PRIMARY KEY,
          key_id INTEGER,
          ts TEXT NOT NULL DEFAULT (datetime('now')),
          tool TEXT NOT NULL,
          target TEXT,
          allowed INTEGER NOT NULL
        );
      `);
      raw.pragma("user_version = 1");
      raw.close();

      const db = openDatabase(path);
      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);

      const cols = (db.prepare("PRAGMA table_info(api_keys)").all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(cols).toContain("revoked_at");

      const indexes = (db.prepare("PRAGMA index_list(access_log)").all() as { name: string }[]).map(
        (i) => i.name,
      );
      expect(indexes).toContain("idx_access_log_key_ts");
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
