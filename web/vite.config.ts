import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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
  server: {
    // `npm run dev` talks to a server started separately, so the API is on
    // another port during development but same-origin in production.
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
});
