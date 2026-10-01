/**
 * Runs the dev UI against a server that is already running somewhere else.
 *
 * For looking at a change in the interface without building and deploying
 * first: the page is served by Vite with hot reload, and everything under
 * `/api` is proxied to a real ndBrain. **Writes go to that server's real
 * vault**, so point it at one whose notes you are willing to change.
 *
 *   NDBRAIN_REMOTE=http://192.168.1.10:3000 npx vite --config vite.remote.config.ts
 *
 * `changeOrigin` stays off on purpose: the session cookie is issued for the
 * origin the server sees, and rewriting the Host header would mean signing in
 * and then being signed out by the next request.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Where the real server is. Localhost, so the default is somebody's own machine. */
const remote = process.env['NDBRAIN_REMOTE'] ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: remote, changeOrigin: false },
    },
  },
});
