/**
 * Index schema and migrations.
 *
 * Everything in here is a **cache**. Deleting the database file must cost nothing
 * but the time to walk the vault again — that is the product's central promise
 * ("migration is copying a folder"), and `test/index.test.ts` asserts it rather
 * than trusting it.
 *
 * Consequence for migrations: a migration is allowed to be lossy. If a schema
 * change is awkward, dropping the tables and reindexing is a legitimate strategy,
 * which it never is for a database that holds the only copy of something.
 *
 * Every row carries `owner`. Not "most rows" — every row, including the FTS table,
 * so that a query cannot accidentally span tenants. See `queries.ts` for why the
 * filter lives in the SQL rather than in a wrapper.
 */

import type { Database } from './database.js';

export const SCHEMA_VERSION = 1;

const MIGRATIONS: Array<(db: Database) => void> = [
  // v0 -> v1: initial schema
  (db) => {
    db.exec(`
      CREATE TABLE notes (
        owner      TEXT NOT NULL,
        path       TEXT NOT NULL,
        title      TEXT NOT NULL,
        -- Case-folded path. Used to resolve links and to detect the collisions
        -- the note service refuses; kept here so lookups do not fold in SQL.
        path_key   TEXT NOT NULL,
        title_key  TEXT NOT NULL,
        size       INTEGER NOT NULL,
        mtime_ms   INTEGER NOT NULL,
        -- Content hash: lets a rescan skip files that did not change.
        hash       TEXT NOT NULL,
        indexed_at INTEGER NOT NULL,
        PRIMARY KEY (owner, path)
      ) STRICT;

      CREATE INDEX notes_owner_title ON notes (owner, title_key);
      CREATE INDEX notes_owner_mtime ON notes (owner, mtime_ms DESC);

      CREATE TABLE tags (
        owner TEXT NOT NULL,
        path  TEXT NOT NULL,
        tag   TEXT NOT NULL,
        -- Case-folded tag, so #Homelab and #homelab count as one.
        key   TEXT NOT NULL,
        PRIMARY KEY (owner, path, key),
        FOREIGN KEY (owner, path) REFERENCES notes (owner, path) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX tags_owner_key ON tags (owner, key);

      CREATE TABLE links (
        owner       TEXT NOT NULL,
        -- Note the link is written in.
        source      TEXT NOT NULL,
        -- Link target exactly as written, before resolution.
        target_raw  TEXT NOT NULL,
        target_key  TEXT NOT NULL,
        -- Resolved note path, or NULL when the target does not exist.
        -- Unresolved links are kept deliberately: a link into the void is a
        -- finding the tidy-up view reports, not an error to discard.
        target_path TEXT,
        heading     TEXT,
        alias       TEXT,
        offset      INTEGER NOT NULL,
        FOREIGN KEY (owner, source) REFERENCES notes (owner, path) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX links_owner_source ON links (owner, source);
      CREATE INDEX links_owner_target ON links (owner, target_path);
      CREATE INDEX links_owner_key    ON links (owner, target_key);

      CREATE TABLE tasks (
        owner TEXT NOT NULL,
        path  TEXT NOT NULL,
        line  INTEGER NOT NULL,
        done  INTEGER NOT NULL,
        text  TEXT NOT NULL,
        PRIMARY KEY (owner, path, line),
        FOREIGN KEY (owner, path) REFERENCES notes (owner, path) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX tasks_owner_done ON tasks (owner, done);

      -- Contentless-external FTS: the note text lives in the file, so the index
      -- stores only what search needs. 'unicode61 remove_diacritics 2' makes
      -- "Muller" find "Müller", which matters for a German vault.
      CREATE VIRTUAL TABLE notes_fts USING fts5(
        owner UNINDEXED,
        path  UNINDEXED,
        title,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
  },
];

/** Applies pending migrations. Safe to call on every start. */
export function migrate(db: Database): void {
  const current = db.userVersion;

  if (current > MIGRATIONS.length) {
    throw new Error(
      `index schema is version ${current}, newer than this build understands ` +
        `(${MIGRATIONS.length}). Delete the index file and let it rebuild.`,
    );
  }

  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const migration = MIGRATIONS[version];
    if (!migration) continue;
    db.transaction(() => {
      migration(db);
    });
    db.userVersion = version + 1;
  }
}

/** Empties the index without touching the schema — used by a full rebuild. */
export function clearIndex(db: Database, owner?: string): void {
  db.transaction(() => {
    if (owner === undefined) {
      db.exec('DELETE FROM notes_fts; DELETE FROM tasks; DELETE FROM links; DELETE FROM tags; DELETE FROM notes;');
      return;
    }
    db.run('DELETE FROM notes_fts WHERE owner = ?', owner);
    db.run('DELETE FROM tasks WHERE owner = ?', owner);
    db.run('DELETE FROM links WHERE owner = ?', owner);
    db.run('DELETE FROM tags WHERE owner = ?', owner);
    db.run('DELETE FROM notes WHERE owner = ?', owner);
  });
}
