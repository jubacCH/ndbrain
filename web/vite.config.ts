import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * When this bundle was built, frozen into it.
 *
 * A single-page app without a router never navigates, so a tab left open
 * keeps running the JavaScript it started with — through a deploy, and with
 * no way for the person in front of it to tell. That cost real time once:
 * a setting was looked for that the running bundle did not have yet.
 *
 * Seconds precision, UTC, and no commit hash: the Dockerfile copies only
 * `web/`, `server/` and `shared/`, so the build cannot see git, and carrying
 * the hash in would mean changing the deploy command for a line of text.
 * The time answers the question that is actually asked — is this older than
 * the deploy — without touching anything that deploys.
 */
const BUILT_AT = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

export default defineConfig({
  define: { __BUILT_AT__: JSON.stringify(BUILT_AT) },
  plugins: [react()],
  resolve: {
    // shared/schema.ts lives above this project and imports zod by bare name.
    // Without this, resolution walks up from shared/ and finds no node_modules.
    alias: { zod: fileURLToPath(new URL('./node_modules/zod', import.meta.url)) },
  },
  build: {
    // The server serves this directory statically.
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    // The shared schemas live above this project; the test runner has to be
    // allowed to read them for the same reason the bundler is.
    include: ['test/**/*.test.{ts,tsx}'],
    // Longer than the `asyncUtilTimeout` in `test/setup.ts`, and that relation
    // is the whole point. Both used to be five seconds, so the runner always
    // won: `waitFor` could never spend the ceiling it was given, and a test
    // waiting for an element that never appears reported "took too long"
    // instead of naming what it was waiting for. Under load that also made
    // slow-but-correct tests fail. `test/timeouts.test.ts` keeps the two apart.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    /**
     * Spies go back after every test, which they did not.
     *
     * Five `vi.spyOn(window, …)` calls in `shell.test.tsx` alone, none of them
     * undone: a `confirm` stubbed in one test stayed stubbed for every test after
     * it, and `mock.calls[0]` in a later test was somebody else's call. That cost
     * real time to find, because the test passed on its own and failed in the
     * file — the same shape as the `matchMedia` flake, one test leaving state for
     * the next.
     *
     * Restoring rather than clearing: `clearMocks` would empty the call lists and
     * leave the stubs in place, which fixes the counting and keeps the lie.
     */
    restoreMocks: true,
  },
  server: {
    // `npm run dev` talks to a server started separately, so the API is on
    // another port during development but same-origin in production.
    proxy: {
      // `ws: true` for /api/v1/collab: without it the dev proxy answers the
      // upgrade with a 404 and the editor falls back to saving the old way,
      // which looks exactly like the feature not working.
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false, ws: true },
    },
  },
});
