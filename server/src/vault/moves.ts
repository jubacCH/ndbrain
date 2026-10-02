/**
 * Moving a vault's directory to the account's identifier, and the signpost that
 * keeps the result readable.
 *
 * The v16 migration made `users.id` a random identifier, which is also the
 * directory a vault lives in. A migration has a database and nothing else, and
 * the dangerous part of that change is exactly the seam between the two: a
 * database that says `acc_…` while the folder is still called `julian` is an
 * account whose notes have all vanished — not with an error, with an empty
 * tree. So the migration writes the mapping into `vault_moves` and this runs
 * from that table at start-up.
 *
 * **Repeatable, because a crash is the normal case to design for.** Every row
 * is one of four situations and each has one answer: the old directory is there
 * and the new one is not (move it), the new one is already there (the move
 * happened; drop the row), neither is there (an account with no vault yet; make
 * one), or both are there (say so and leave both alone — that is two sets of
 * notes and not something to guess about). A rename on one filesystem is
 * atomic, so there is no half-moved directory to find.
 *
 * **The signpost.** With the directory named by the identifier, nothing on disk
 * says whose notes these are: a backup, an `rsync`, somebody with a shell. So
 * `vaults/WHOSE-NOTES.txt` names the login beside each identifier. No code
 * reads it — the application resolves vaults by id and nothing else — and it is
 * written again from the database on every start, so a rename or a deleted
 * account cannot leave a line claiming a vault. Why a file and not the
 * directory of symlinks this started as: see `writeSignposts`.
 */

import { readdir, rename, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Database } from '../db/database.js';
import { assertUserId } from './paths.js';

/** Where the signpost lives. Not a vault, and skipped by everything that walks them. */
export const WHOSE_NOTES = 'WHOSE-NOTES.txt';

/** The directory of symlinks this replaced in v16. Removed on start; see `writeSignposts`. */
export const LEGACY_BY_NAME = 'by-name';

export interface MoveReport {
  moved: Array<{ from: string; to: string }>;
  /** Both directories exist. Nothing is touched and somebody has to look. */
  conflicted: Array<{ from: string; to: string }>;
}

const exists = async (at: string): Promise<boolean> => {
  try {
    await stat(at);
    return true;
  } catch {
    return false;
  }
};

/**
 * Carries out whatever `vault_moves` still asks for.
 *
 * Returns what it did rather than logging it: the caller has the logger, and a
 * function that both moves directories and decides how to talk about it is one
 * that cannot be tested without reading log lines.
 */
export async function runVaultMoves(db: Database, dataDir: string): Promise<MoveReport> {
  const report: MoveReport = { moved: [], conflicted: [] };
  let pending: Array<Record<string, unknown>>;
  try {
    pending = db.all('SELECT guid, from_name FROM vault_moves');
  } catch {
    // No such table: a database older than v16, or newer than this build. Both
    // are somebody else's problem and neither is a reason to refuse to start.
    return report;
  }

  const vaults = path.join(dataDir, 'vaults');
  for (const row of pending) {
    const to = String(row['guid']);
    const from = String(row['from_name']);
    // The names become path segments, so they are checked here as well as
    // wherever they came from — a row edited by hand is still a row.
    assertUserId(to);
    assertUserId(from);

    const source = path.join(vaults, from);
    const target = path.join(vaults, to);
    const [hasSource, hasTarget] = [await exists(source), await exists(target)];

    if (hasSource && hasTarget) {
      // Two directories, both with notes in them. Picking one would throw the
      // other away silently, which is the one outcome worth refusing.
      report.conflicted.push({ from, to });
      continue;
    }

    if (hasSource) {
      await rename(source, target);
      report.moved.push({ from, to });
    } else if (!hasTarget) {
      // An account whose vault was never made — a row from a restore, or one
      // created and never written to. The vault belongs to the identifier now.
      await mkdir(target, { recursive: true });
    }

    db.run('DELETE FROM vault_moves WHERE guid = ?', to);
  }

  return report;
}

/**
 * Rebuilds `vaults/WHOSE-NOTES.txt` so the disk says whose notes are whose.
 *
 * **A file, not a directory of symlinks, and that is the design rather than a
 * detail.** Until 02.10.2026 this was `vaults/by-name/<login> -> ../<id>`, and
 * being a directory with a legal account name in the place where vaults live,
 * it needed an exception in four separate places: chokidar's `ignored`, the
 * watcher's own sweep, `vaultDirectories`, and the history timer's loop. Three
 * of those were written on purpose. The fourth was missing, and it cost an
 * outage — the timer versioned the signposts as though they held notes, as
 * root, and the application then could not clear them on start.
 *
 * A file needs none of the four, because "is not a directory" is already the
 * rule in every one of those places. It also explains itself to whoever meets
 * it, which a column of symlinks does not, and that was the whole point of
 * writing anything here. What is given up is `cd vaults/by-name/julian`.
 *
 * It stays inside `vaults/` rather than moving up beside it, which would have
 * removed the exceptions just as well: only `vaults/` and `index/` are mounted,
 * and under `read_only: true` a sibling of them is not writable. It would have
 * failed quietly, in the one place nobody looks.
 *
 * Thrown away and written again rather than reconciled: a line left behind from
 * a rename is worse than no line — it is a name claiming somebody else's vault.
 *
 * A signpost that cannot be written is not a reason to fail, because nothing
 * reads it. Returns how many accounts are named in the file, which is fewer
 * than were asked for whenever something got in the way; the caller says so in
 * the log rather than letting it pass unnoticed.
 */
export async function writeSignposts(
  dataDir: string,
  accounts: ReadonlyArray<{ id: string; loginName: string }>,
): Promise<number> {
  // Installations that ran v16 before this change have the directory of
  // symlinks. It was rebuilt on every start, so there is nothing to migrate and
  // only something to remove — left there, the history timer goes on versioning
  // it.
  //
  // The `catch` is the load-bearing part, not the position: the old directory
  // is exactly the thing that may be unremovable, because that is what the
  // outage was, and an upgrade must not hang on the installations that hit it.
  // Where the removal fails, the directory stays and the timer keeps skipping
  // it by name, which is the one reason that exception is still in the script.
  await rm(path.join(dataDir, 'vaults', LEGACY_BY_NAME), { recursive: true, force: true }).catch(() => {});

  const named: Array<{ id: string; loginName: string }> = [];
  for (const account of accounts) {
    // Still validated, for a different reason than before. It is no longer
    // becoming a path, but it is becoming one line in a file of one line per
    // account, and a newline in a login would forge a line of its own.
    try {
      assertUserId(account.loginName);
      assertUserId(account.id);
      named.push(account);
    } catch {
      continue;
    }
  }

  const width = named.reduce((widest, account) => Math.max(widest, account.loginName.length), 0);
  const body = named.map((account) => `${account.loginName.padEnd(width)}  ${account.id}`).join('\n');

  try {
    await writeFile(
      path.join(dataDir, 'vaults', WHOSE_NOTES),
      `# Which vault belongs to which login.\n` +
        `#\n` +
        `# Written from the database on every start, because a directory named by a\n` +
        `# random identifier does not say whose notes are in it — and a backup, an\n` +
        `# rsync or somebody with a shell has nothing else to go on. Nothing reads\n` +
        `# this file; editing it changes nothing and it will be overwritten.\n` +
        `#\n` +
        `# A login can be changed. The identifier beside it never does.\n` +
        `\n${body}\n`,
      'utf8',
    );
  } catch {
    // A read-only mount, a full disk, a directory that is not there. None of
    // them is a reason not to serve notes.
    return 0;
  }
  return named.length;
}

/**
 * The vault directories.
 *
 * No exception for the signpost any more: it is a sibling of this directory
 * rather than something in it, so there is nothing here to leave out.
 */
export async function vaultDirectories(dataDir: string): Promise<string[]> {
  const entries = await readdir(path.join(dataDir, 'vaults'), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}
