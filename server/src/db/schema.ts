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

export const SCHEMA_VERSION = 16;

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
        -- character set that paths.ts enforces. Never written again after the
        -- account is made: see the v13 -> v14 migration, which moved the login
        -- off it precisely so that this can stay still.
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

  // v6 -> v7: force the properties to actually be filled
  //
  // v6 added an empty table and nothing put anything in it. The sync on startup
  // compares content hashes, and no file changed, so every existing note was
  // "unchanged" and its frontmatter was never read — leaving a feature that
  // silently answered "no notes declare anything" on a vault full of notes that
  // do.
  //
  // The general rule this is an instance of: **a migration that adds derived
  // data has to invalidate what it derives from.** Dropping the note rows is
  // safe precisely because they are derived — the next sync rebuilds them from
  // the files, which is the same promise the whole index rests on.
  (db) => {
    db.exec('DELETE FROM notes_fts; DELETE FROM props; DELETE FROM notes;');
  },
  // v7 -> v8: per-account preferences
  //
  // Almost every setting a person can change belongs in their browser: a theme,
  // a text size and which view opens first are properties of the screen they are
  // sitting at, and syncing those would make two devices fight each other.
  //
  // What belongs here instead is anything that changes what the *server*
  // answers. "Untouched for 42 days" was a number chosen by whoever wrote the
  // query, and it decides which notes get reported as needing attention — that
  // is a judgement about somebody's vault, so it has to be theirs to make, and
  // it has to be the same judgement whichever device asks.
  //
  // Key-value rather than a column per setting: settings arrive one at a time
  // over years, and a table that needs a migration for each one gets them
  // wedged into an existing column instead.
  (db) => {
    db.exec(`
      CREATE TABLE user_settings (
        user_id TEXT NOT NULL,
        key     TEXT NOT NULL,
        value   TEXT NOT NULL,
        PRIMARY KEY (user_id, key),
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) STRICT;
    `);
  },

  // v8 -> v9: spaces and note shares
  //
  // Two kinds where there was one of each. An account is a person or a space:
  // a space is a vault of its own that nobody signs in to, whose members are
  // ordinary shares with the space as owner. A share is the whole vault, a
  // folder, or exactly one note.
  //
  // The kind is a column rather than something read off the prefix. A note
  // share stores the note's exact path without a trailing slash, and "no
  // trailing slash" already means "the whole vault" for the empty prefix — a
  // rule that has to be inferred is a rule some later query infers wrongly.
  // Every existing row is derived here once: an empty prefix was the vault,
  // anything else a folder, because nothing else could be granted before.
  //
  // Both columns are checked, so a typo in a kind fails the write instead of
  // producing a share that no scope rule recognises.
  //
  // `bound_at` is when a note share came to name its current path: granted, or
  // last moved with its note. The git history and the edit log belong to a
  // path, not to a note, and whatever carried that name before is not the
  // grantee's to read. Empty for vault and folder shares, which name places.
  (db) => {
    db.exec(`
      ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'person'
        CHECK (kind IN ('person', 'space'));

      ALTER TABLE shares ADD COLUMN kind TEXT NOT NULL DEFAULT 'folder'
        CHECK (kind IN ('vault', 'folder', 'note'));

      ALTER TABLE shares ADD COLUMN bound_at INTEGER;

      UPDATE shares SET kind = CASE WHEN prefix = '' THEN 'vault' ELSE 'folder' END;

      CREATE INDEX shares_owner_kind ON shares (owner, kind, prefix);
    `);
  },

  // v9 -> v10: which file a note share names.
  //
  // A path says where a note is, not which note it is. A file renamed over
  // the note, or a delete followed at once by a new file, reaches the watcher
  // as one `change` — the path was never seen missing. `bound_file` is the
  // identity of the file the share was given for (device, inode, birth time)
  // and `bound_hash` its content when last confirmed, so a different file
  // under the same name is recognised as one. Empty until first confirmed.
  (db) => {
    db.exec(`
      ALTER TABLE shares ADD COLUMN bound_file TEXT;
      ALTER TABLE shares ADD COLUMN bound_hash TEXT;
    `);
  },

  // v10 -> v11: one account per name, whatever the letter case.
  //
  // The id is the vault's directory name, and on macOS and Windows `Julian`
  // and `julian` are one directory — a space named like a person hands its
  // members that person's notes. `UserService` refuses the pair, but a check
  // in application code is a check with a gap: two creations in flight at once
  // both looked before either wrote, and password hashing is long enough to
  // fit a whole second request inside. The index closes it where the write
  // actually happens.
  //
  // A database that already holds such a pair is not something a migration may
  // quietly leave half-done: the index would simply fail to be created and the
  // collision would live on with nothing said. It is named and the start
  // refused instead, because renaming one of the two is a decision about
  // somebody's vault directory and not ours to make.
  (db) => {
    const clashes = db.all(
      `SELECT group_concat(id, ' / ') AS ids FROM users
        GROUP BY lower(id) HAVING COUNT(*) > 1 ORDER BY lower(id)`,
    );
    if (clashes.length > 0) {
      const named = clashes.map((row) => String(row['ids'])).join(', ');
      throw new Error(
        `these accounts differ only in letter case and cannot both exist: ${named}. ` +
          'Rename one of each pair (its vault directory too) and start again.',
      );
    }
    db.exec('CREATE UNIQUE INDEX users_id_lower ON users (lower(id));');
  },

  // v11 -> v12: re-read every task
  //
  // Task text used to come out of the code-masked line, so every inline code
  // span in a task was stored as blanks, and `tasks: false` in the frontmatter
  // is new. Neither shows up until a note changes — the same trap as v7, so the
  // note rows go and the next sync reads the files again.
  (db) => {
    db.exec('DELETE FROM notes_fts; DELETE FROM props; DELETE FROM tasks; DELETE FROM notes;');
  },

  // v12 -> v13: an agent key can expire.
  //
  // Nullable, and every row that already exists keeps NULL — "this key was made
  // without a deadline". Not a date in the past, which would take every running
  // agent down the moment the new image starts, and not today plus a year
  // either: a key handed out without a lifetime did not agree to one, and
  // inventing a deadline retroactively is an outage at a time nobody chose. The
  // four keys on the live instance therefore survive the upgrade untouched, and
  // the deadline arrives with the next key made rather than with the migration.
  //
  // NULL stays a legitimate value afterwards rather than being a leftover the
  // next migration cleans up: a key for a job that runs once a month is a
  // different case from one for a session, and the one that has to be renewed
  // every quarter is the one that ends up pasted into a file somewhere as a
  // workaround. See `DEFAULT_LIFETIME_DAYS` in `auth/keys.ts` for what a key
  // gets when nobody chooses.
  (db) => {
    db.exec('ALTER TABLE api_keys ADD COLUMN expires_at INTEGER;');
  },

  // v13 -> v14: what somebody signs in with stops being what the row is keyed by
  //
  // The id was three things at once: the primary key every share, session and
  // agent key hangs off, the vault's directory name, and the word typed at the
  // login. The first two have to be stable — one is a foreign key with no
  // `ON UPDATE CASCADE` anywhere in this schema, the other is a directory with
  // a git repository inside it — and the third is the one somebody wants to
  // change, because it was typed in a hurry or is spelled wrong or belonged to
  // a person who has since married.
  //
  // So the third moves out. `login_name` starts as a copy of the id and is free
  // afterwards; `id` is never written again. Nothing else in the database
  // changes, nothing on disk moves, and no open room or session is disturbed —
  // which is the whole reason to do it this way rather than to make the id
  // itself renameable.
  //
  // Unique on `lower(login_name)` for the same reason `users_id_lower` exists:
  // a login that differs only in case is two accounts to the database and one
  // to the person typing it.
  (db) => {
    db.exec("ALTER TABLE users ADD COLUMN login_name TEXT NOT NULL DEFAULT '';");
    db.exec('UPDATE users SET login_name = id;');
    db.exec('CREATE UNIQUE INDEX users_login_lower ON users (lower(login_name));');

    // The default is a mine, and the trigger defuses it.
    //
    // `ALTER TABLE ADD COLUMN NOT NULL` has to name a default, and the only
    // one available is the empty string — so an insert that does not mention
    // `login_name` gets one, and the unique index above then permits exactly
    // one such row in the whole table. The second one fails with "UNIQUE
    // constraint failed: users_login_lower", which says nothing at all about
    // the column somebody forgot.
    //
    // Rather than make that failure louder, this makes it impossible: a row
    // written without a login gets its id, which is what every row that existed
    // before this migration got and is the only sensible answer. Direct SQL —
    // a repair by hand, a test standing in for an older release — therefore
    // behaves like the service does.
    db.exec(`
      CREATE TRIGGER users_login_default AFTER INSERT ON users
      WHEN NEW.login_name = ''
      BEGIN
        UPDATE users SET login_name = NEW.id WHERE id = NEW.id;
      END;
    `);
  },

  // v14 -> v15: an identifier that was never anybody's name
  //
  // `id` is readable because it is a directory name, and readable is the one
  // thing an identifier should not be: every readable name is a name somebody
  // eventually wants changed. So each account also gets one that was never
  // chosen and never means anything — thirty-two hex characters out of
  // `randomblob`, behind `acc_` so that a value found in a log or a path says
  // what kind of thing it is.
  //
  // Nothing hangs off it yet. This migration only puts it there and guarantees
  // it is unique; what points at it is a later step, because moving every
  // foreign key and every vault directory is a different kind of change from
  // adding a column.
  //
  // `randomblob` is evaluated once per row rather than once per statement, so
  // the backfill below gives four accounts four different identifiers — which
  // the unique index would otherwise refuse, loudly, at exactly the right
  // moment.
  (db) => {
    db.exec("ALTER TABLE users ADD COLUMN guid TEXT NOT NULL DEFAULT '';");
    db.exec("UPDATE users SET guid = 'acc_' || lower(hex(randomblob(16)));");
    db.exec('CREATE UNIQUE INDEX users_guid ON users (guid);');

    // The same mine as `login_name`, defused the same way — and here the
    // trigger can produce the value itself, so a row written by hand gets a
    // real identifier rather than one somebody had to think of.
    db.exec(`
      CREATE TRIGGER users_guid_default AFTER INSERT ON users
      WHEN NEW.guid = ''
      BEGIN
        UPDATE users SET guid = 'acc_' || lower(hex(randomblob(16))) WHERE id = NEW.id;
      END;
    `);
  },

  // v15 -> v16: the identifier becomes the id, and the vault's directory with it
  //
  // Everything that names an account names it by `users.id`, and the code
  // passes that around as an opaque string — so making the id the random
  // identifier changes no route, no query and no client code. What it does
  // change is every row that points at a user, and the name of a directory.
  //
  // **Order.** The children are rewritten first, while `users` still holds the
  // names they refer to; `users` goes last. `PRAGMA defer_foreign_keys` holds
  // the constraints until the commit, which is the one thing that makes this
  // possible at all: this schema has no `ON UPDATE CASCADE` anywhere, and
  // `PRAGMA foreign_keys` cannot be switched inside a transaction while
  // `defer_foreign_keys` can.
  //
  // **The directories are not touched here.** A migration has a database and
  // nothing else, and the dangerous part of this change is the seam between the
  // two: a database that says `acc_…` while the folder is still called `julian`
  // is an account whose notes have all vanished. So the mapping is written into
  // `vault_moves` and the move itself happens at start-up, from that table,
  // repeatably — a crash between the two leaves rows the next start finishes.
  //
  // **The index is emptied rather than translated.** `notes`, `tags`, `links`,
  // `tasks`, `props` and the FTS table all carry an owner, and all of them are
  // derived from the vault; the header of this file says losing them must cost
  // nothing. Rebuilding is one sweep at start-up and cannot be subtly wrong,
  // which translating six tables can.
  (db) => {
    db.exec(`
      CREATE TABLE vault_moves (
        -- The identifier the directory is to be called.
        guid      TEXT PRIMARY KEY,
        -- What it is called now. The row goes once the move has happened, so
        -- this table is empty except between the migration and the next start.
        from_name TEXT NOT NULL
      ) STRICT;
    `);
    db.exec('INSERT INTO vault_moves (guid, from_name) SELECT guid, id FROM users;');

    db.exec('PRAGMA defer_foreign_keys = ON;');

    // Both columns of `shares`: a grantee is an account like an owner is.
    const pointsAtAUser: ReadonlyArray<readonly [string, string]> = [
      ['sessions', 'user_id'],
      ['edits', 'owner'],
      ['api_keys', 'owner'],
      ['access_log', 'owner'],
      ['shares', 'owner'],
      ['shares', 'grantee'],
      ['user_settings', 'user_id'],
    ];
    for (const [table, column] of pointsAtAUser) {
      db.exec(
        `UPDATE ${table} SET ${column} = (SELECT u.guid FROM users u WHERE u.id = ${table}.${column})
          WHERE ${column} IN (SELECT id FROM users)`,
      );
    }

    db.exec('UPDATE users SET id = guid;');

    // The staging column has done its work: the identifier is the id now, and
    // two columns holding one value is a pair that can come to disagree.
    db.exec('DROP TRIGGER users_guid_default;');
    db.exec('DROP INDEX users_guid;');
    db.exec('ALTER TABLE users DROP COLUMN guid;');

    db.exec(
      'DELETE FROM notes_fts; DELETE FROM props; DELETE FROM tasks; ' +
        'DELETE FROM links; DELETE FROM tags; DELETE FROM notes;',
    );
  },
];

/**
 * Applies pending migrations. Safe to call on every start.
 *
 * `upTo` stops at an earlier version, so a test can build the database a
 * previous release left behind and watch the next migration convert it.
 */
export function migrate(db: Database, upTo: number = MIGRATIONS.length): void {
  const current = db.userVersion;

  if (current > MIGRATIONS.length) {
    // Deliberately does not advise deleting the file, which is what it used to
    // say. `ndbrain.db` is not only the index: it holds the accounts, the
    // sessions, the agent keys, the shares, the settings and the edit log, and
    // none of those can be derived from the vault. Deleting it to get past a
    // version mismatch costs every login and every grant on the box — and the
    // mismatch itself is a downgrade, which has a cheaper answer.
    throw new Error(
      `index schema is version ${current}, newer than this build understands ` +
        `(${MIGRATIONS.length}). A newer ndbrain wrote this database, so run that ` +
        'version again — or restore the index file from a backup taken before the ' +
        'upgrade. Do not delete it: it holds the accounts, agent keys and shares ' +
        'as well as the index, and only the index could be rebuilt from the vault.',
    );
  }

  for (let version = current; version < Math.min(upTo, MIGRATIONS.length); version += 1) {
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
