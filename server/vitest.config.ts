import { defineConfig } from 'vitest/config';

/**
 * The runner's own settings, which used to live in whoever's shell was running.
 *
 * `npm test` was `vitest run` with nothing else, so it inherited vitest's
 * defaults of 5 s per test and 10 s per hook — and failed. Not always, and not
 * the same tests twice, which is the worst way for a suite to fail: it looks
 * like a defect in whatever was touched last. The flags that made it pass were
 * passed by hand and written down nowhere, so the suite worked for whoever knew
 * them and was broken for everybody else.
 *
 * What the numbers hang on, so they can be judged rather than inherited:
 *
 *  - `testTimeout` — a login test pays real scrypt at 64 MiB, on purpose, since
 *    that cost is the thing the login brake exists to bound. A handful of them
 *    in one test passes five seconds on a busy machine while the code is fine.
 *  - `hookTimeout` — `beforeEach` builds a vault on disk and migrates a
 *    database. `node:sqlite` is synchronous, so a harness cannot overlap that
 *    work with anything; several files setting up at once queue behind each
 *    other.
 *  - `maxForks` — each fork can hold a 64 MiB scrypt buffer and its own SQLite
 *    handles. This is the one number here that is about the machine rather than
 *    about the code: raise it on a host with memory to spare.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    poolOptions: { forks: { maxForks: 2 } },
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
