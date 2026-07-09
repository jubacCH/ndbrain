import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.js";
import { ApiKeyService } from "./service.js";
import { runKeyCli } from "./cli.js";

function makeService() {
  return new ApiKeyService(openDatabase(":memory:"));
}

describe("runKeyCli", () => {
  describe("key create", () => {
    it("creates a key, prints it with a visible-only-now warning, and it validates with the given scope", async () => {
      const keys = makeService();
      const result = await runKeyCli(
        ["key", "create", "myai", "--scope", "myai/", "--write"],
        { keys },
      );

      expect(result.code).toBe(0);
      const match = result.out.match(/ndb_[0-9a-f]{64}/);
      expect(match).not.toBeNull();
      expect(result.out.toLowerCase()).toContain("only");

      const validated = await keys.validate(match![0]);
      expect(validated).not.toBeNull();
      expect(validated!.scope).toEqual({ namespace: "myai/", canWrite: true });
    });

    it("defaults to read-only when --write is omitted", async () => {
      const keys = makeService();
      const result = await runKeyCli(["key", "create", "reader", "--scope", "docs/"], { keys });
      expect(result.code).toBe(0);
      const key = result.out.match(/ndb_[0-9a-f]{64}/)![0];
      const validated = await keys.validate(key);
      expect(validated!.scope.canWrite).toBe(false);
    });

    it("accepts an --expires flag", async () => {
      const keys = makeService();
      const future = new Date(Date.now() + 3600_000).toISOString();
      const result = await runKeyCli(
        ["key", "create", "temp", "--scope", "", "--expires", future],
        { keys },
      );
      expect(result.code).toBe(0);
      expect(keys.list()[0].expiresAt).not.toBeNull();
    });

    it("fails with code 1 when --scope is missing", async () => {
      const keys = makeService();
      const result = await runKeyCli(["key", "create", "myai"], { keys });
      expect(result.code).toBe(1);
    });

    it("fails with code 1 when name is missing", async () => {
      const keys = makeService();
      const result = await runKeyCli(["key", "create", "--scope", "x/"], { keys });
      expect(result.code).toBe(1);
    });

    it("fails with code 1 on duplicate name", async () => {
      const keys = makeService();
      await runKeyCli(["key", "create", "myai", "--scope", "myai/"], { keys });
      const result = await runKeyCli(["key", "create", "myai", "--scope", "other/"], { keys });
      expect(result.code).toBe(1);
    });

    it("fails with code 1 on an invalid key name", async () => {
      const keys = makeService();
      const result = await runKeyCli(["key", "create", "bad name!", "--scope", "x/"], { keys });
      expect(result.code).toBe(1);
    });

    it("fails with code 1 on an invalid --expires date", async () => {
      const keys = makeService();
      const result = await runKeyCli(
        ["key", "create", "x", "--scope", "x/", "--expires", "notadate"],
        { keys },
      );
      expect(result.code).toBe(1);
      expect(result.out).toContain("Error: invalid --expires date: notadate");
      expect(keys.list()).toHaveLength(0);
    });

    it("normalizes a scope without trailing slash and reports it as an informational note, not a warning", async () => {
      const keys = makeService();
      const result = await runKeyCli(["key", "create", "myai", "--scope", "myai"], { keys });
      expect(result.code).toBe(0);
      expect(result.out).toContain('Note: scope normalized to "myai/"');
      expect(result.out).not.toContain("Warning");
      const key = result.out.match(/ndb_[0-9a-f]{64}/)![0];
      const validated = await keys.validate(key);
      expect(validated!.scope.namespace).toBe("myai/");
    });

    it("does not note anything for a scope already ending with a trailing slash", async () => {
      const keys = makeService();
      const result = await runKeyCli(["key", "create", "myai", "--scope", "myai/"], { keys });
      expect(result.code).toBe(0);
      expect(result.out).not.toContain("Warning");
      expect(result.out).not.toContain("Note: scope normalized");
    });

    it("does not note anything for an empty scope (whole vault, stays unwarned)", async () => {
      const keys = makeService();
      const result = await runKeyCli(["key", "create", "myai", "--scope", ""], { keys });
      expect(result.code).toBe(0);
      expect(result.out).not.toContain("Warning");
      expect(result.out).not.toContain("Note: scope normalized");
    });
  });

  describe("key list", () => {
    it("shows an empty message when there are no keys", async () => {
      const keys = makeService();
      const result = await runKeyCli(["key", "list"], { keys });
      expect(result.code).toBe(0);
      expect(result.out.toLowerCase()).toContain("no keys");
    });

    it("lists a created key's name, namespace and write flag", async () => {
      const keys = makeService();
      await runKeyCli(["key", "create", "myai", "--scope", "myai/", "--write"], { keys });
      const result = await runKeyCli(["key", "list"], { keys });
      expect(result.code).toBe(0);
      expect(result.out).toContain("myai");
      expect(result.out).toContain("myai/");
    });
  });

  describe("key revoke", () => {
    it("revokes an existing key with code 0", async () => {
      const keys = makeService();
      await runKeyCli(["key", "create", "myai", "--scope", "myai/"], { keys });
      const result = await runKeyCli(["key", "revoke", "myai"], { keys });
      expect(result.code).toBe(0);
      expect(keys.list()).toHaveLength(0);
    });

    it("returns code 1 for an unknown name", async () => {
      const keys = makeService();
      const result = await runKeyCli(["key", "revoke", "does-not-exist"], { keys });
      expect(result.code).toBe(1);
    });
  });

  describe("usage", () => {
    it("prints usage with code 1 for an unknown command", async () => {
      const keys = makeService();
      const result = await runKeyCli(["bogus"], { keys });
      expect(result.code).toBe(1);
      expect(result.out.toLowerCase()).toContain("usage");
    });

    it("prints usage with code 1 for an unknown key subcommand", async () => {
      const keys = makeService();
      const result = await runKeyCli(["key", "bogus"], { keys });
      expect(result.code).toBe(1);
      expect(result.out.toLowerCase()).toContain("usage");
    });

    it("prints usage with code 0 for --help", async () => {
      const keys = makeService();
      const result = await runKeyCli(["--help"], { keys });
      expect(result.code).toBe(0);
      expect(result.out.toLowerCase()).toContain("usage");
    });

    it("prints usage with code 1 for an empty argv", async () => {
      const keys = makeService();
      const result = await runKeyCli([], { keys });
      expect(result.code).toBe(1);
    });
  });
});
