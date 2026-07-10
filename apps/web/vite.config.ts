import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const SERVER_ORIGIN = "http://localhost:3000";

// Proxies /api, /collab (websocket) and /mcp to the locally running
// @ndbrain/server instance so `pnpm --filter @ndbrain/web dev` works
// against a real backend without CORS/origin friction.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: SERVER_ORIGIN,
        changeOrigin: true,
      },
      "/collab": {
        target: SERVER_ORIGIN,
        ws: true,
        changeOrigin: true,
      },
      "/mcp": {
        target: SERVER_ORIGIN,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
