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
`;

export type { Database };

/** Open (or create) the ndbrain SQLite database and apply the schema idempotently. */
export function openDatabase(path: string): Database {
  const db = new DatabaseCtor(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}
