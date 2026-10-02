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
 * `vaults/by-name/<login> -> ../<id>` is written beside them. No code reads it
 * — the application resolves vaults by id and nothing else — and it is rebuilt
 * from scratch on every start, so a rename or a deleted account cannot leave a
 * link pointing at a name that is gone.
 */

import { readdir, rename, rm, stat, symlink, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { Database } from '../db/database.js';
import { assertUserId } from './paths.js';

/** Where the signpost lives. Not a vault, and skipped by everything that walks them. */
export const BY_NAME = 'by-name';

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
 * Rebuilds `vaults/by-name` so the disk says whose notes are whose.
 *
 * Thrown away and written again rather than reconciled: the directory holds
 * nothing but links, making it costs nothing, and a link left behind from a
 * rename is worse than no link at all — it is a name that resolves to somebody
 * else's vault.
 *
 * A link that cannot be written is not a reason to fail: nothing reads these.
 * Neither is a directory that cannot be cleared, and that half was missing —
 * see below. Returns how many links are there, which is less than the number of
 * accounts whenever something got in the way.
 */
export async function writeSignposts(
  dataDir: string,
  accounts: ReadonlyArray<{ id: string; loginName: string }>,
): Promise<number> {
  const root = path.join(dataDir, 'vaults', BY_NAME);

  // The guarantee in the docstring covered the links and not these two lines,
  // and on 02.10.2026 that took the live instance down. The history timer had
  // treated this directory as a vault and committed a git repository into it as
  // root; the application cleared it as uid 1000, the unlink failed with EACCES,
  // and the container went into a restart loop. Over a directory that nothing
  // reads, while every note in the vaults beside it was intact and served.
  //
  // Returning instead of throwing leaves whatever is in there alone. That is
  // worse than a rebuilt directory, because a link left from a rename resolves
  // to somebody else's vault — but the caller says so in the log, and a stale
  // signpost that nothing reads is still a smaller thing than a service that
  // will not start.
  try {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
  } catch {
    return 0;
  }

  let written = 0;
  for (const account of accounts) {
    // The login is free text as far as a filesystem is concerned — it is
    // checked on the way in, and checked again here because this is the place
    // it becomes a path.
    try {
      assertUserId(account.loginName);
      assertUserId(account.id);
    } catch {
      continue;
    }
    try {
      await symlink(path.join('..', account.id), path.join(root, account.loginName));
      written += 1;
    } catch {
      // A name that clashes with another link, a filesystem without symlinks,
      // a read-only mount. None of them is a reason not to serve notes.
    }
  }
  return written;
}

/** The vault directories, with the signpost left out. */
export async function vaultDirectories(dataDir: string): Promise<string[]> {
  const entries = await readdir(path.join(dataDir, 'vaults'), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && entry.name !== BY_NAME).map((entry) => entry.name);
}
