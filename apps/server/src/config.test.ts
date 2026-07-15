import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("applies defaults and reads overrides", () => {
    expect(loadConfig({})).toEqual({
      vaultDir: "/data/vault",
      dbPath: "/data/ndbrain.db",
      port: 3000,
      allowedOrigins: [],
      cookieSameSite: "lax",
      cookieSecure: false,
    });
    expect(loadConfig({ NDBRAIN_PORT: "8080", NDBRAIN_VAULT_DIR: "/tmp/v" })).toMatchObject({
      port: 8080,
      vaultDir: "/tmp/v",
    });
  });

  // I1: the desktop webview (tauri://localhost / http://tauri.localhost) needs an
  // explicit CORS allowlist - empty by default so the browser/same-origin path never
  // gets an Access-Control-* header it didn't have before.
  describe("NDBRAIN_ALLOWED_ORIGINS", () => {
    it("defaults to an empty allowlist (CORS off)", () => {
      expect(loadConfig({}).allowedOrigins).toEqual([]);
    });

    it("parses a comma-separated list, trimming whitespace and dropping empty entries", () => {
      expect(
        loadConfig({ NDBRAIN_ALLOWED_ORIGINS: "tauri://localhost, http://tauri.localhost ,,http://localhost:3000" })
          .allowedOrigins,
      ).toEqual(["tauri://localhost", "http://tauri.localhost", "http://localhost:3000"]);
    });

    it("treats an empty string the same as unset", () => {
      expect(loadConfig({ NDBRAIN_ALLOWED_ORIGINS: "" }).allowedOrigins).toEqual([]);
    });
  });

  describe("cookie attributes", () => {
    it("default to today's behavior: SameSite=Lax, not Secure", () => {
      const config = loadConfig({});
      expect(config.cookieSameSite).toBe("lax");
      expect(config.cookieSecure).toBe(false);
    });

    it("NDBRAIN_COOKIE_SAMESITE=none switches to cross-origin cookies", () => {
      expect(loadConfig({ NDBRAIN_COOKIE_SAMESITE: "none" }).cookieSameSite).toBe("none");
    });

    it("any other NDBRAIN_COOKIE_SAMESITE value falls back to lax", () => {
      expect(loadConfig({ NDBRAIN_COOKIE_SAMESITE: "strict" }).cookieSameSite).toBe("lax");
    });

    it("NDBRAIN_COOKIE_SECURE=true enables the Secure attribute", () => {
      expect(loadConfig({ NDBRAIN_COOKIE_SECURE: "true" }).cookieSecure).toBe(true);
    });

    it("any other NDBRAIN_COOKIE_SECURE value stays false", () => {
      expect(loadConfig({ NDBRAIN_COOKIE_SECURE: "1" }).cookieSecure).toBe(false);
    });
  });
});
