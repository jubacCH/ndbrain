import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("applies defaults and reads overrides", () => {
    expect(loadConfig({})).toEqual({ vaultDir: "/data/vault", dbPath: "/data/ndbrain.db", port: 3000 });
    expect(loadConfig({ NDBRAIN_PORT: "8080", NDBRAIN_VAULT_DIR: "/tmp/v" })).toMatchObject({
      port: 8080,
      vaultDir: "/tmp/v",
    });
  });
});
