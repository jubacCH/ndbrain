/**
 * Temporary: runs the dev UI against the deployed instance on CT 132, so the
 * new editor can be looked at without deploying anything first.
 *
 * Writes go to the real vault. Delete this file when it has served its purpose.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: 'http://10.10.30.98:3000', changeOrigin: false },
    },
  },
});
