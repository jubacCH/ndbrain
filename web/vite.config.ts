import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
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
