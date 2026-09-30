/**
 * That `npm test` is enough, which it was not.
 *
 * `vitest run` with no settings gets 5 s per test and 10 s per hook. Both are
 * too short here for reasons that are the point of the code rather than
 * accidents of it: a login test pays real scrypt at 64 MiB, and `beforeEach`
 * builds a vault and migrates a database through `node:sqlite`, which is
 * synchronous and cannot be overlapped.
 *
 * So the suite failed — intermittently, in different files each time, which
 * reads as a defect in whatever was touched last rather than as a runner that
 * gave up early. It passed with `--pool=forks --poolOptions.forks.maxForks=2
 * --hookTimeout=30000`, passed by hand, recorded nowhere. Anybody who ran the
 * documented command instead got failures that were not there.
 *
 * This is one file's contents standing in for a promise about a command, which
 * is not a beautiful test. The alternative is running the suite from inside
 * itself to find out.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const config = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vitest.config.ts'),
  'utf8',
);

function setting(name: string): number {
  const found = new RegExp(`${name}:\\s*([\\d_]+)`).exec(config);
  if (found === null) throw new Error(`${name} is not set in vitest.config.ts`);
  return Number(found[1]?.replace(/_/g, ''));
}

describe('the runner needs no flags from the shell', () => {
  it('gives a test longer than the default five seconds', () => {
    // Enough for a test that makes several real scrypt calls on a loaded
    // machine. A passing test stops waiting at once, so the ceiling costs
    // nothing except when something is genuinely stuck.
    expect(setting('testTimeout')).toBeGreaterThanOrEqual(20_000);
  });

  it('gives a hook longer still, since setup is the slower half', () => {
    // The harness does more than the test it prepares: a vault on disk, a
    // migrated database, and no way to overlap either.
    expect(setting('hookTimeout')).toBeGreaterThanOrEqual(setting('testTimeout'));
  });

  it('bounds how many forks hold a 64 MiB buffer at once', () => {
    // The one number here that is about the machine. Named so that raising it
    // is a decision rather than a discovery.
    expect(setting('maxForks')).toBeGreaterThanOrEqual(1);
    expect(config).toMatch(/pool:\s*'forks'/);
  });
});
