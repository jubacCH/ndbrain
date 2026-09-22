/**
 * What a folder share does when its folder is moved or deleted.
 *
 * Both operations find the shares they have to touch with a prefix match in
 * SQL, and both used `prefix.length` as the character count. SQLite counts
 * `substr` in characters and JavaScript counts `length` in UTF-16 code units,
 * so for a folder whose name holds a character outside the basic plane the
 * query asked for more characters than the prefix has and matched nothing.
 *
 * The delete is the one that matters. A share nobody removed keeps pointing at
 * a path, and a folder later created under that name is shared with whoever
 * held it — a grant that nobody made and nobody can see coming. The move is
 * the quieter half: the share stays behind on a name that no longer exists.
 *
 * The emoji is not decoration. `normalizeVaultPath` allows it, so somebody's
 * vault can hold `📥 Inbox/` today, and these tests are written from the
 * outside — through `grant` and `view` — so they stay true whatever the SQL
 * underneath ends up looking like.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ShareService } from '../src/auth/shares.js';
import { Database } from '../src/db/database.js';
import { migrate } from '../src/db/schema.js';

let dir: string;
let db: Database;
let shares: ShareService;

/** A folder name whose emoji is one code point but two UTF-16 code units. */
const ASTRAL = '📥 Inbox/';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-fshare-'));
  db = new Database(path.join(dir, 'index.db'));
  migrate(db);
  shares = new ShareService(db);

  // Written straight in: a share row points at its accounts by foreign key, and
  // hashing two passwords for a test about prefix arithmetic would cost more
  // than the rest of the file put together.
  for (const id of ['julian', 'anna']) {
    db.run(
      'INSERT INTO users (id, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
      id,
      id,
      'x',
      'user',
      Date.now(),
    );
  }
});

afterEach(async () => {
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

/**
 * The folder prefixes `grantee` can see in `owner`'s vault.
 *
 * Read through `view`, which is what every permission check in the server asks,
 * so these tests say what a grantee can reach rather than what a table holds.
 * The caller's own vault is always the first entry of a view, hence the owner
 * filter; `exact` singles out note shares, which these two operations do not
 * touch.
 */
function granted(owner: string, grantee: string): string[] {
  return shares
    .view(grantee)
    .filter((scope) => scope.owner === owner && !scope.exact && scope.prefix !== '')
    .map((scope) => scope.prefix)
    .sort();
}

describe('a folder share when its folder goes away', () => {
  it('is withdrawn with the folder, so a later folder of that name does not inherit it', () => {
    shares.grant('julian', ASTRAL, 'anna');
    expect(granted('julian', 'anna')).toEqual([ASTRAL]);

    shares.dropFolder('julian', ASTRAL);

    expect(granted('julian', 'anna')).toEqual([]);
  });

  it('is withdrawn together with the shares below it', () => {
    shares.grant('julian', ASTRAL, 'anna');
    shares.grant('julian', `${ASTRAL}Belege/`, 'anna', true);

    shares.dropFolder('julian', ASTRAL);

    expect(granted('julian', 'anna')).toEqual([]);
  });

  it('leaves a folder whose name merely starts the same alone', () => {
    // `📥 Inbox` against `📥 Inboxarchiv`: the separator is what keeps them
    // apart, and it has to keep them apart here too.
    shares.grant('julian', ASTRAL, 'anna');
    shares.grant('julian', '📥 Inboxarchiv/', 'anna');

    shares.dropFolder('julian', ASTRAL);

    expect(granted('julian', 'anna')).toEqual(['📥 Inboxarchiv/']);
  });
});

describe('a folder share when its folder is moved', () => {
  it('follows the folder instead of staying on a name that is gone', () => {
    shares.grant('julian', ASTRAL, 'anna');

    shares.moveFolder('julian', ASTRAL, 'Archiv/2026/');

    expect(granted('julian', 'anna')).toEqual(['Archiv/2026/']);
  });

  it('carries the shares below it along, keeping their place', () => {
    shares.grant('julian', `${ASTRAL}Belege/`, 'anna', true);

    shares.moveFolder('julian', ASTRAL, 'Archiv/');

    expect(granted('julian', 'anna')).toEqual(['Archiv/Belege/']);
  });

  it('moves into a folder named with an astral character as well', () => {
    // The other direction: the destination is the one outside the basic plane,
    // which is where the JavaScript half of the rewrite has to hold up.
    shares.grant('julian', 'Eingang/Belege/', 'anna');

    shares.moveFolder('julian', 'Eingang/', ASTRAL);

    expect(granted('julian', 'anna')).toEqual([`${ASTRAL}Belege/`]);
  });
});
