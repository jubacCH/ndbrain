import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
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
  },
  server: {
    // `npm run dev` talks to a server started separately, so the API is on
    // another port during development but same-origin in production.
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
});
