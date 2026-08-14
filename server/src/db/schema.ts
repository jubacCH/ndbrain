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

export const SCHEMA_VERSION = 6;

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

  // v1 -> v2: users and sessions
  //
  // Note that this is the one part of the database that is NOT a rebuildable
  // cache. Losing it means losing every account, so the deploy documentation
  // treats this file as worth backing up even though the index beside it is not.
  (db) => {
    db.exec(`
      CREATE TABLE users (
        -- Doubles as the vault directory name, so it is restricted to the same
        -- character set that paths.ts enforces.
        id            TEXT PRIMARY KEY,
        display_name  TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        created_at    INTEGER NOT NULL,
        disabled_at   INTEGER
      ) STRICT;

      CREATE TABLE sessions (
        -- SHA-256 of the cookie value. Storing the raw token would mean a
        -- database leak hands over live sessions, not just password hashes.
        token_hash  TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX sessions_user    ON sessions (user_id);
      CREATE INDEX sessions_expires ON sessions (expires_at);
    `);
  },

  // v2 -> v3: the edit log
  //
  // Who changed a note is not written in the note, so unlike everything else in
  // the index this cannot be reconstructed from the vault. It is therefore its
  // own table rather than a column on `notes`: adding it there would quietly
  // break the promise that deleting the database costs nothing but a reindex —
  // the notes would come back and the history would not, without anybody
  // noticing.
  //
  // Losing this table loses the activity view, never a note.
  (db) => {
    db.exec(`
      CREATE TABLE edits (
        owner  TEXT NOT NULL,
        path   TEXT NOT NULL,
        -- The account, or later an agent's key name. Free text, because an agent
        -- is not a user row and never will be.
        actor  TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'rename')),
        at     INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX edits_owner_at ON edits (owner, at DESC);
    `);
  },

  // v3 -> v4: agent keys and their access log
  (db) => {
    db.exec(`
      CREATE TABLE api_keys (
        id          TEXT PRIMARY KEY,
        -- SHA-256 of the key. The key is 256 bits of randomness, so a fast hash
        -- is right here: there is nothing to brute-force, and a slow KDF would
        -- put argon2-scale work on every single MCP call.
        key_hash    TEXT NOT NULL UNIQUE,
        -- The account this key acts as. A key can never see more than its owner.
        owner       TEXT NOT NULL,
        name        TEXT NOT NULL,
        -- Path prefix the key is confined to. Empty string = the whole vault.
        scope       TEXT NOT NULL,
        can_write   INTEGER NOT NULL,
        created_at  INTEGER NOT NULL,
        last_used_at INTEGER,
        -- Soft revoke: the row stays so the access log keeps a readable name.
        revoked_at  INTEGER,
        FOREIGN KEY (owner) REFERENCES users (id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX api_keys_owner ON api_keys (owner);

      CREATE TABLE access_log (
        key_id  TEXT NOT NULL,
        owner   TEXT NOT NULL,
        tool    TEXT NOT NULL,
        path    TEXT,
        allowed INTEGER NOT NULL,
        at      INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX access_log_owner_at ON access_log (owner, at DESC);
    `);
  },

  // v4 -> v5: shares
  //
  // A share is (owner, prefix) granted to one other account, read or write. The
  // prefix carries a trailing slash, or is empty for the whole vault, so that a
  // string comparison cannot let `Homelab` match `Homelab2`.
  //
  // Like `users` and `edits`, this is **not** derivable from the vault: who may
  // see what is not written in the Markdown. It survives `clearIndex` for the
  // same reason they do.
  (db) => {
    db.exec(`
      CREATE TABLE shares (
        id         TEXT PRIMARY KEY,
        owner      TEXT NOT NULL,
        -- Path prefix, '' for the whole vault, otherwise ending in '/'.
        prefix     TEXT NOT NULL,
        grantee    TEXT NOT NULL,
        can_write  INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        -- One grant per (owner, prefix, grantee): re-granting changes the right
        -- rather than stacking a second row that the resolver would have to
        -- reconcile.
        UNIQUE (owner, prefix, grantee),
        FOREIGN KEY (owner)   REFERENCES users (id) ON DELETE CASCADE,
        FOREIGN KEY (grantee) REFERENCES users (id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX shares_grantee ON shares (grantee);
      CREATE INDEX shares_owner   ON shares (owner);
    `);
  },

  // v5 -> v6: frontmatter properties
  //
  // Frontmatter was parsed from the start and then thrown away — only `tags`
  // survived, into its own table. Everything else a note declared about itself
  // (`status: aktiv`, `type: moc`) existed in the file and nowhere the index
  // could reach, so it could not be filtered on and could not be listed
  // cheaply.
  //
  // Key/value rows rather than columns, because the vocabulary belongs to
  // whoever keeps the vault. A column per property would mean a migration every
  // time somebody invents a field, which is precisely the sort of structure this
  // tool refuses to impose.
  //
  // Rebuildable from the vault like the rest of the index, so `clearIndex`
  // wipes it without a second thought.
  (db) => {
    db.exec(`
      CREATE TABLE props (
        owner TEXT NOT NULL,
        path  TEXT NOT NULL,
        key   TEXT NOT NULL,
        -- Always text. A YAML scalar can be a number, a date or a boolean, and
        -- storing each in its own type would make "status = aktiv" and
        -- "year = 2026" two different queries.
        value TEXT NOT NULL,
        -- Case-folded, so "Status: Aktiv" and "status: aktiv" answer the same
        -- question — the same rule tags already follow.
        key_fold   TEXT NOT NULL,
        value_fold TEXT NOT NULL,
        PRIMARY KEY (owner, path, key_fold, value_fold),
        FOREIGN KEY (owner, path) REFERENCES notes (owner, path) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX props_owner_key   ON props (owner, key_fold);
      CREATE INDEX props_owner_pair  ON props (owner, key_fold, value_fold);
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

/**
 * Empties the index without touching the schema — used by a full rebuild.
 *
 * Deliberately leaves `users`, `sessions`, `edits`, `api_keys` and `shares`
 * alone: a rebuild reads the vault, and none of those are derivable from it.
 */
export function clearIndex(db: Database, owner?: string): void {
  db.transaction(() => {
    if (owner === undefined) {
      db.exec(
        'DELETE FROM notes_fts; DELETE FROM props; DELETE FROM tasks; ' +
          'DELETE FROM links; DELETE FROM tags; DELETE FROM notes;',
      );
      return;
    }
    db.run('DELETE FROM notes_fts WHERE owner = ?', owner);
    db.run('DELETE FROM props WHERE owner = ?', owner);
    db.run('DELETE FROM tasks WHERE owner = ?', owner);
    db.run('DELETE FROM links WHERE owner = ?', owner);
    db.run('DELETE FROM tags WHERE owner = ?', owner);
    db.run('DELETE FROM notes WHERE owner = ?', owner);
  });
}
