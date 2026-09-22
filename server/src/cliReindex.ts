/**
 * `ndbrain-user reindex …`: rebuilding the index from the files.
 *
 * Its own module rather than another branch in `cli.ts`, which runs itself on
 * import — this way the command can be tested against a runtime without
 * spawning a process. Same reason as `cliSpaces.ts`.
 *
 * Why it needs to exist at all: `Indexer.rebuild` had no caller, so the only
 * reindex anybody could perform was deleting `ndbrain.db`. That file is not the
 * index — it also holds the accounts, the sessions, the agent keys, the shares
 * and the edit log, and none of those can be derived from the vault. Advising
 * its deletion to repair a cache costs every login and every grant on the box.
 */

import type { Runtime } from './runtime.js';

export const REINDEX_USAGE = `  reindex [<user>]            rebuild the index from the vault (all accounts by default)
`;

/** Runs `reindex`, writing its report through `write`. */
export async function runReindexCommand(
  runtime: Runtime,
  args: string[],
  write: (text: string) => void,
): Promise<void> {
  const [named, ...rest] = args;
  if (rest.length > 0) throw new Error('usage: reindex [<user>]');

  let owners: string[];
  if (named === undefined) {
    owners = runtime.users.list().map((user) => user.id);
    if (owners.length === 0) {
      write('no accounts yet\n');
      return;
    }
  } else {
    // Named and unknown is a typo, not an empty job. Reporting "0 notes" for a
    // misspelled account would look like a successful reindex of an empty vault.
    const user = runtime.users.get(named);
    if (user === undefined) throw new Error(`no such account: ${named}`);
    owners = [user.id];
  }

  let skippedAnywhere = false;

  for (const owner of owners) {
    // Before the index, exactly as at start-up: a note share whose file was
    // replaced while nobody was looking has to go before that file's words are
    // indexed under it. A rebuild reads every file, so it is the widest window
    // there is for getting that order wrong.
    await runtime.app.dropDanglingShares(owner);

    const stats = await runtime.indexer.rebuild(owner);
    const counts = `${stats.added} indexed`;
    const skipped = stats.skipped.length > 0 ? `, ${stats.skipped.length} skipped` : '';
    write(`${owner.padEnd(20)} ${counts}${skipped}\n`);

    for (const notePath of stats.skipped) {
      write(`  skipped: ${notePath}\n`);
      skippedAnywhere = true;
    }
  }

  if (skippedAnywhere) {
    write(
      '\nA skipped file is on disk and out of search. Its name is one no vault can carry ' +
        'onto every filesystem — a "?", a ":", a reserved name such as aux, a trailing dot or ' +
        'space. Rename it and run reindex again.\n',
    );
  }
}
