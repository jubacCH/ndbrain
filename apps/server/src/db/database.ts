import DatabaseCtor, { type Database } from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  path TEXT PRIMARY KEY,
  title TEXT,
  frontmatter_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
  source_path TEXT NOT NULL,
  target TEXT NOT NULL,
  PRIMARY KEY (source_path, target)
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(path UNINDEXED, title, body);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  key_hash TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT '',
  can_write INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY,
  key_id INTEGER,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  tool TEXT NOT NULL,
  target TEXT,
  allowed INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_log_key_ts ON access_log(key_id, ts);
`;

export type { Database };

function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

/**
 * Ordered schema migrations, applied on top of the base `SCHEMA` above via `PRAGMA
 * user_version`. Version 1 is the baseline: the tables as `CREATE TABLE IF NOT EXISTS`
 * leaves them, before any of the migrations below run. Each step here bumps the version
 * by one and must be idempotent, because a fresh database created from the (already
 * up-to-date) `SCHEMA` string reaches every step too — it just finds nothing to do.
 *
 * A never-versioned SQLite file (either a brand-new DB, or one written by code that
 * predates this migrator) reports `user_version = 0`; that's treated as "at the
 * baseline" (version 1), not "needs step 1 re-applied", since `SCHEMA` already created
 * the base tables idempotently.
 */
interface MigrationStep {
  /** The user_version reached once this step has run. */
  version: number;
  apply: (db: Database) => void;
}

const BASE_VERSION = 1;

const MIGRATIONS: MigrationStep[] = [
  {
    // Soft-revoke support (see keys/service.ts): api_keys.revoked_at.
    version: 2,
    apply: (db) => {
      if (!hasColumn(db, "api_keys", "revoked_at")) {
        db.exec("ALTER TABLE api_keys ADD COLUMN revoked_at TEXT");
      }
    },
  },
  {
    // Speeds up per-key audit-log lookups (Plan 4 audit view).
    version: 3,
    apply: (db) => {
      db.exec("CREATE INDEX IF NOT EXISTS idx_access_log_key_ts ON access_log(key_id, ts)");
    },
  },
];

export const SCHEMA_VERSION =
  MIGRATIONS.length > 0 ? MIGRATIONS[MIGRATIONS.length - 1].version : BASE_VERSION;

function migrate(db: Database): void {
  const raw = db.pragma("user_version", { simple: true }) as number;
  const current = raw === 0 ? BASE_VERSION : raw;

  if (current < SCHEMA_VERSION) {
    const applyPending = db.transaction(() => {
      for (const step of MIGRATIONS) {
        if (step.version > current) step.apply(db);
      }
    });
    applyPending();
  }

  if (raw !== SCHEMA_VERSION) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}

/** Open (or create) the ndbrain SQLite database, apply the schema idempotently, and run
 *  any pending migrations so both fresh and pre-existing DB files converge on the same
 *  `PRAGMA user_version`. */
export function openDatabase(path: string): Database {
  const db = new DatabaseCtor(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}
