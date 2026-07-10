import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.js";
import { ApiKeyService, InvalidKeyNameError, DuplicateKeyNameError, InvalidExpiryError } from "./service.js";

function makeService() {
  const db = openDatabase(":memory:");
  return new ApiKeyService(db);
}

describe("ApiKeyService", () => {
  describe("create", () => {
    it("returns a plaintext key in ndb_<64hex> format (256-bit)", async () => {
      const service = makeService();
      const key = await service.create("myai", "myai/", true);
      expect(key).toMatch(/^ndb_[0-9a-f]{64}$/);
    });

    it("throws InvalidKeyNameError for names with disallowed characters", async () => {
      const service = makeService();
      await expect(service.create("bad name!", "", false)).rejects.toThrow(InvalidKeyNameError);
      await expect(service.create("bad/name", "", false)).rejects.toThrow(InvalidKeyNameError);
    });

    it("accepts names matching /^[A-Za-z0-9._-]+$/", async () => {
      const service = makeService();
      await expect(service.create("my-key_1.0", "", false)).resolves.toMatch(/^ndb_/);
    });

    it("throws DuplicateKeyNameError for a name that already exists", async () => {
      const service = makeService();
      await service.create("myai", "myai/", true);
      await expect(service.create("myai", "other/", false)).rejects.toThrow(DuplicateKeyNameError);
    });

    it("normalizes expiresAt to UTC ISO string", async () => {
      const service = makeService();
      const past = new Date(Date.now() - 1_000).toISOString();
      const key = await service.create("expired-key", "test/", false, past);
      const result = await service.validate(key);
      expect(result).toBeNull();
    });

    it("stores future expiry correctly in UTC", async () => {
      const service = makeService();
      const future = new Date(Date.now() + 3600_000).toISOString();
      const key = await service.create("future-key", "test/", false, future);
      const result = await service.validate(key);
      expect(result).not.toBeNull();
    });

    it("normalizes a namespace without a trailing slash, so it can't prefix-match siblings like 'myaixyz.md'", async () => {
      const service = makeService();
      const key = await service.create("k", "myai", false);
      const result = await service.validate(key);
      expect(result!.scope.namespace).toBe("myai/");
    });

    it("leaves an empty namespace (whole-vault scope) untouched", async () => {
      const service = makeService();
      const key = await service.create("k", "", false);
      const result = await service.validate(key);
      expect(result!.scope.namespace).toBe("");
    });

    it("leaves an already-slash-terminated namespace untouched", async () => {
      const service = makeService();
      const key = await service.create("k", "myai/", false);
      const result = await service.validate(key);
      expect(result!.scope.namespace).toBe("myai/");
    });

    it("throws InvalidExpiryError when expiresAt is a malformed date string", async () => {
      const service = makeService();
      await expect(service.create("test", "", false, "garbage")).rejects.toThrow(InvalidExpiryError);
    });

    it("throws InvalidExpiryError when expiresAt is an invalid date", async () => {
      const service = makeService();
      await expect(service.create("test", "", false, "not-a-date")).rejects.toThrow(InvalidExpiryError);
    });
  });

  describe("validate", () => {
    it("returns keyId, name and scope for a correct key", async () => {
      const service = makeService();
      const key = await service.create("myai", "myai/", true);
      const result = await service.validate(key);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("myai");
      expect(result!.scope).toEqual({ namespace: "myai/", canWrite: true });
      expect(typeof result!.keyId).toBe("number");
    });

    it("returns null for an incorrect/tampered key", async () => {
      const service = makeService();
      await service.create("myai", "myai/", true);
      const result = await service.validate("ndb_00000000000000000000000000000000");
      expect(result).toBeNull();
    });

    it("returns null for a garbage/malformed presented key", async () => {
      const service = makeService();
      const result = await service.validate("not-a-real-key");
      expect(result).toBeNull();
    });

    it("returns null for an expired key", async () => {
      const service = makeService();
      const past = new Date(Date.now() - 60_000).toISOString();
      const key = await service.create("myai", "myai/", true, past);
      const result = await service.validate(key);
      expect(result).toBeNull();
    });

    it("accepts a key with an expiry in the future", async () => {
      const service = makeService();
      const future = new Date(Date.now() + 60_000).toISOString();
      const key = await service.create("myai", "myai/", true, future);
      const result = await service.validate(key);
      expect(result).not.toBeNull();
    });

    it("updates last_used_at on successful validation", async () => {
      const service = makeService();
      const key = await service.create("myai", "myai/", true);
      expect(service.list()[0].lastUsedAt).toBeNull();
      await service.validate(key);
      expect(service.list()[0].lastUsedAt).not.toBeNull();
    });
  });

  describe("list", () => {
    it("lists keys without exposing the hash", async () => {
      const service = makeService();
      await service.create("myai", "myai/", true);
      const entries = service.list();
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry.name).toBe("myai");
      expect(entry.namespace).toBe("myai/");
      expect(entry.canWrite).toBe(true);
      expect(entry.createdAt).toBeTruthy();
      expect(entry.lastUsedAt).toBeNull();
      expect(entry.expiresAt).toBeNull();
      expect(entry).not.toHaveProperty("keyHash");
      expect(entry).not.toHaveProperty("key_hash");
    });

    it("does not include the internal id", async () => {
      const service = makeService();
      await service.create("myai", "myai/", true);
      const entries = service.list();
      expect(entries[0]).not.toHaveProperty("id");
    });
  });

  describe("revoke", () => {
    it("soft-revokes: the key stops validating, but the row survives for audit resolution", async () => {
      const service = makeService();
      const key = await service.create("myai", "myai/", true);
      expect(service.revoke("myai")).toBe(true);
      expect(await service.validate(key)).toBeNull();
    });

    it("hides a revoked key from list() by default", async () => {
      const service = makeService();
      await service.create("myai", "myai/", true);
      service.revoke("myai");
      expect(service.list()).toHaveLength(0);
    });

    it("returns false for an unknown name", () => {
      const service = makeService();
      expect(service.revoke("does-not-exist")).toBe(false);
    });

    it("returns false when revoking an already-revoked key", async () => {
      const service = makeService();
      await service.create("myai", "myai/", true);
      expect(service.revoke("myai")).toBe(true);
      expect(service.revoke("myai")).toBe(false);
    });

    it("keeps a revoked name blamed: it cannot be reused for a new key", async () => {
      const service = makeService();
      await service.create("myai", "myai/", true);
      service.revoke("myai");
      await expect(service.create("myai", "other/", false)).rejects.toThrow(DuplicateKeyNameError);
    });
  });
});
