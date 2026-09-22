/**
 * The two clocks a waiting test runs against, and which one must win.
 *
 * `waitFor` and `findBy…` give up after `asyncUtilTimeout`. The runner gives up
 * after `testTimeout`. Both were five seconds, so the runner always got there
 * first: the ceiling in `test/setup.ts` was unreachable, and a test waiting for
 * an element that never appears said "took too long" rather than naming the
 * element. Under load it also failed tests that were merely slow.
 *
 * This is one line in each of two files, which is exactly the kind of relation
 * that drifts when somebody tunes one of them.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));

function numberIn(file: string, pattern: RegExp): number {
  const source = readFileSync(path.join(here, '..', file), 'utf8');
  const found = pattern.exec(source);
  if (found === null) throw new Error(`no ${pattern} in ${file}`);
  return Number(found[1]?.replace(/_/g, ''));
}

describe('the waiting test and the runner', () => {
  it('leaves waitFor room to reach its own ceiling', () => {
    const waiting = numberIn('test/setup.ts', /asyncUtilTimeout:\s*([\d_]+)/);
    const runner = numberIn('vite.config.ts', /testTimeout:\s*([\d_]+)/);

    // Room for the wait itself plus whatever the test did before it started
    // waiting. Equal values are the broken case this exists to prevent.
    expect(runner).toBeGreaterThan(waiting * 2);
  });

  it('gives a hook the same room, since a slow harness fails the same way', () => {
    const waiting = numberIn('test/setup.ts', /asyncUtilTimeout:\s*([\d_]+)/);
    const hooks = numberIn('vite.config.ts', /hookTimeout:\s*([\d_]+)/);

    expect(hooks).toBeGreaterThan(waiting * 2);
  });
});
