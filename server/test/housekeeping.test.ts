/**
 * The two tables that grow on their own, and the sweep that bounds them.
 *
 * `access_log` takes a row for every MCP call an agent makes, reads included —
 * that is the point of it, since reading a note leaves no other trace anywhere.
 * On the live instance it had reached 529 904 rows in two months and made up
 * 69.9 MB of a 71.9 MB database: ninety-seven per cent of the file was a log
 * nobody reads past its first fortnight. It also travelled: the nightly
 * database backup carried seventy megabytes where the notes themselves are two.
 *
 * Nothing ever read the old rows. `pulse` asks for a window, `ApiKeyService.log`
 * asks for the newest few; neither can reach past the horizon below. So the
 * sweep is not a compromise between keeping and losing — it drops rows that no
 * query can name.
 *
 * `sessions` was already swept, but only at startup, while its own docstring
 * claimed "on start and periodically". A service that runs for months starts
 * rarely. Both are swept on the same timer now, and the comment is true.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApiKeyService } from '../src/auth/keys.js';
import { SessionService, UserService } from '../src/auth/users.js';
import { Database } from '../src/db/database.js';
import { migrate } from '../src/db/schema.js';
import { Vault } from '../src/vault/fs.js';

const DAY = 24 * 60 * 60 * 1000;

let dataDir: string;
let db: Database;
let keys: ApiKeyService;
let users: UserService;
let sessions: SessionService;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-keep-'));
  db = new Database(':memory:');
  migrate(db);
  users = new UserService(db, new Vault(dataDir));
  keys = new ApiKeyService(db);
  sessions = new SessionService(db);
  await users.create('julian', 'ein gutes passwort');
});

afterEach(async () => {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

/** A row in the access log, dated by hand. */
function logged(at: number, tool = 'get_note'): void {
  db.run(
    'INSERT INTO access_log (key_id, owner, tool, path, allowed, at) VALUES (?, ?, ?, ?, ?, ?)',
    'key_x',
    'julian',
    tool,
    'Homelab/Proxmox.md',
    1,
    at,
  );
}

function rows(): number {
  return Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM access_log')?.n ?? 0);
}

describe('the access log', () => {
  it('keeps what a query can still ask for and drops the rest', () => {
    const now = Date.UTC(2026, 8, 22);
    logged(now - 1 * DAY);
    logged(now - 89 * DAY);
    logged(now - 91 * DAY);
    logged(now - 400 * DAY);
    expect(rows()).toBe(4);

    const dropped = keys.purgeLog(now);

    expect(dropped).toBe(2);
    expect(rows()).toBe(2);
  });

  it('leaves a log that is entirely within the horizon alone', () => {
    const now = Date.UTC(2026, 8, 22);
    for (let i = 0; i < 5; i += 1) logged(now - i * DAY);

    expect(keys.purgeLog(now)).toBe(0);
    expect(rows()).toBe(5);
  });

  it('still answers for the calls it kept', () => {
    // The sweep must not take the answer with the rows: what `key log` shows is
    // the recent calls, and those are exactly the ones on this side of the
    // horizon.
    const now = Date.UTC(2026, 8, 22);
    logged(now - 200 * DAY, 'search_notes');
    logged(now - 2 * DAY, 'get_note');

    keys.purgeLog(now);

    const recent = keys.recentAccess('julian', 10);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.tool).toBe('get_note');
  });
});

describe('expired sessions', () => {
  it('go with the same sweep, not only with a restart', () => {
    // The old docstring said "on start and periodically" while only the start
    // ever happened. A service that runs for months starts rarely.
    db.run(
      'INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
      'abgelaufen',
      'julian',
      Date.UTC(2026, 8, 1),
      Date.UTC(2026, 7, 1),
      Date.UTC(2026, 8, 1),
    );

    expect(sessions.purgeExpired(Date.UTC(2026, 8, 22))).toBe(1);
  });
});
