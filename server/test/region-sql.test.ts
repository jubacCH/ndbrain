/**
 * The scope rule, said twice: `inScope` against `regionSql`.
 *
 * `inScope` decides a single path in TypeScript; `regionSql` is the same rule
 * written as a SQL fragment, and roughly fifty queries filter on that fragment
 * instead of on the function. Two spellings of one rule drift silently — the
 * function keeps being right while the fragment quietly hands out, or quietly
 * withholds, a neighbour. `share-kinds.test.ts` pins the function. This file
 * pins that the fragment says exactly the same thing, by asking both about the
 * same paths and comparing the answers, never by reading the SQL.
 *
 * The paths below are the ones a naive implementation gets wrong: a folder
 * whose name is the start of another folder's name, a note path that is the
 * start of a longer one, the same name in different letter case, the path that
 * *is* the region, and a name that is one string in two Unicode spellings. The
 * astral-character folder is there for the fragment specifically: SQLite counts
 * `substr` in characters while JavaScript counts `length` in UTF-16 code units,
 * so a prefix outside the basic plane is where the two arithmetics part.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { inScope, regionSql, type Region } from '../src/auth/shares.js';
import { Database } from '../src/db/database.js';
import { migrate } from '../src/db/schema.js';

const OWNER = 'julian';

/** `é` as one code point, and as `e` plus a combining accent. */
const NFC = 'Café';
const NFD = 'Café';

/** A folder whose first character is a surrogate pair in JavaScript. */
const ASTRAL = '\u{1F5C2} Ablage';

const PATHS = [
  // The note a note share names, and the neighbours whose names begin with it.
  'Projekt/Plan.md',
  'Projekt/Plan.md.bak',
  'Projekt/Plan2.md',
  'Projekt/Plan.md/Anhang.md',
  'Projekt/Alt/Plan.md',
  // The region itself, with and without the separator a folder prefix carries.
  'Projekt',
  'Projekt/',
  'Projekt.md',
  // A folder name that is the start of another folder name.
  'Projekte/Plan.md',
  'Projekte',
  // Letter case: paths here are case-sensitive, and `LIKE` would not be.
  'projekt/plan.md',
  'PROJEKT/PLAN.MD',
  'Projekt/PLAN.md',
  // One name, two Unicode spellings. Nothing normalises them, so they are two
  // different paths — and both sides have to agree that they are.
  `${NFC}/Plan.md`,
  `${NFD}/Plan.md`,
  // Outside the basic multilingual plane.
  `${ASTRAL}/Plan.md`,
  `${ASTRAL}2/Plan.md`,
  ASTRAL,
  // Somewhere else entirely, and the empty path.
  'Anderswo/Notiz.md',
  '',
];

const REGIONS: Array<{ label: string; region: Region }> = [
  { label: 'vault', region: { prefix: '', exact: false } },
  { label: 'folder Projekt/', region: { prefix: 'Projekt/', exact: false } },
  { label: 'folder Projekte/', region: { prefix: 'Projekte/', exact: false } },
  { label: 'folder NFC', region: { prefix: `${NFC}/`, exact: false } },
  { label: 'folder NFD', region: { prefix: `${NFD}/`, exact: false } },
  { label: 'folder astral', region: { prefix: `${ASTRAL}/`, exact: false } },
  { label: 'note Projekt/Plan.md', region: { prefix: 'Projekt/Plan.md', exact: true, since: 0 } },
  { label: 'note without a binding moment', region: { prefix: 'Projekt/Plan.md', exact: true } },
  { label: 'note NFC', region: { prefix: `${NFC}/Plan.md`, exact: true, since: 0 } },
  { label: 'note astral', region: { prefix: `${ASTRAL}/Plan.md`, exact: true, since: 0 } },
  // A note share spelled like a folder, and the empty exact region that cannot
  // be granted but must fail closed if one ever arrives.
  { label: 'note spelled as a folder', region: { prefix: 'Projekt/', exact: true, since: 0 } },
  { label: 'empty exact region', region: { prefix: '', exact: true, since: 0 } },
];

/** Before and after the moment a note share came to name its path. */
const EARLIER = 1_000;
const BOUND_AT = 2_000;
const LATER = 3_000;

let db: Database;

beforeAll(() => {
  db = new Database(':memory:');
  migrate(db);
  // The real `notes` table, not a stand-in: the fragment runs against this
  // column in production, and a collation on it would change the answer.
  for (const [i, notePath] of PATHS.entries()) {
    db.run(
      `INSERT INTO notes (owner, path, title, path_key, title_key, size, mtime_ms, hash, indexed_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, 'h', 0)`,
      OWNER,
      notePath,
      notePath,
      notePath.toLowerCase(),
      notePath.toLowerCase(),
      i,
    );
    db.run(
      `INSERT INTO edits (owner, path, actor, action, at) VALUES (?, ?, 'julian', 'update', ?)`,
      OWNER,
      notePath,
      EARLIER,
    );
    db.run(
      `INSERT INTO edits (owner, path, actor, action, at) VALUES (?, ?, 'julian', 'update', ?)`,
      OWNER,
      notePath,
      LATER,
    );
  }
});

afterAll(() => {
  db.close();
});

/** What the SQL fragment says about one path: the question 50 queries ask. */
function sqlSays(region: Region, notePath: string): boolean {
  const { sql, params } = regionSql('n.path', region);
  const row = db.get(
    `SELECT 1 AS hit FROM notes n WHERE n.owner = ? AND n.path = ? AND ${sql ?? '1 = 1'}`,
    OWNER,
    notePath,
    ...params,
  );
  return row !== undefined;
}

/** The same, for a time-stamped row, which is where `since` applies. */
function sqlSaysAt(region: Region, notePath: string, at: number): boolean {
  const { sql, params } = regionSql('e.path', region, 'e.at');
  const row = db.get(
    `SELECT 1 AS hit FROM edits e WHERE e.owner = ? AND e.path = ? AND e.at = ? AND ${sql ?? '1 = 1'}`,
    OWNER,
    notePath,
    at,
    ...params,
  );
  return row !== undefined;
}

describe('regionSql answers what inScope answers', () => {
  const pairs = REGIONS.flatMap(({ label, region }) =>
    PATHS.map((notePath) => ({ label, region, notePath })),
  );

  it.each(pairs)('$label on $notePath', ({ region, notePath }) => {
    expect(sqlSays(region, notePath)).toBe(inScope(region, notePath));
  });

  it('gives the whole set the same shape, not only pair by pair', () => {
    for (const { label, region } of REGIONS) {
      const { sql, params } = regionSql('n.path', region);
      const fromSql = db
        .all(
          `SELECT n.path FROM notes n WHERE n.owner = ? AND ${sql ?? '1 = 1'} ORDER BY n.rowid`,
          OWNER,
          ...params,
        )
        .map((row) => String(row['path']));
      expect(fromSql, label).toEqual(PATHS.filter((notePath) => inScope(region, notePath)));
    }
  });

  it('drops the condition only for a region that covers every path', () => {
    // `scopeSql` reads a null fragment as "no path restriction at all" and
    // filters on the owner alone. Anything else returning null would open the
    // whole vault.
    for (const { label, region } of REGIONS) {
      const coversAll = PATHS.every((notePath) => inScope(region, notePath));
      expect(regionSql('n.path', region).sql === null, label).toBe(coversAll);
    }
  });
});

describe('the moment a note share came to name its path', () => {
  const note: Region = { prefix: 'Projekt/Plan.md', exact: true, since: BOUND_AT };

  it('hides what the path did before, and shows what it did after', () => {
    expect(sqlSaysAt(note, 'Projekt/Plan.md', EARLIER)).toBe(false);
    expect(sqlSaysAt(note, 'Projekt/Plan.md', LATER)).toBe(true);
  });

  it('still refuses every other path, whatever the time', () => {
    for (const notePath of PATHS) {
      if (notePath === note.prefix) continue;
      for (const at of [EARLIER, LATER]) {
        expect(sqlSaysAt(note, notePath, at), notePath).toBe(false);
      }
    }
  });

  it('narrows the path rule and never widens it', () => {
    // The time branch is a second condition on top of the scope rule, not a
    // different scope rule: whatever it lets through, `inScope` lets through.
    for (const { label, region } of REGIONS) {
      for (const notePath of PATHS) {
        for (const at of [EARLIER, LATER]) {
          const timed = sqlSaysAt({ ...region, since: BOUND_AT }, notePath, at);
          const expected =
            inScope(region, notePath) && (!region.exact || at >= BOUND_AT);
          expect(timed, `${label} on ${notePath} at ${at}`).toBe(expected);
        }
      }
    }
  });

  it('leaves a place-naming region the whole past, even when asked with a time', () => {
    // A folder or vault share names a place, and the place's past is its
    // holder's. Only an exact region carries a moment it began at.
    const folder: Region = { prefix: 'Projekt/', exact: false, since: BOUND_AT };
    expect(sqlSaysAt(folder, 'Projekt/Plan.md', EARLIER)).toBe(true);
  });

  it('shows the whole past of a note share that carries no moment', () => {
    const unbound: Region = { prefix: 'Projekt/Plan.md', exact: true };
    expect(sqlSaysAt(unbound, 'Projekt/Plan.md', EARLIER)).toBe(true);
  });
});
