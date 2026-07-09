import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.js";
import { ApiKeyService, InvalidKeyNameError, DuplicateKeyNameError } from "./service.js";

function makeService() {
  const db = openDatabase(":memory:");
  return new ApiKeyService(db);
}

describe("ApiKeyService", () => {
  describe("create", () => {
    it("returns a plaintext key in ndb_<32hex> format", async () => {
      const service = makeService();
      const key = await service.create("myai", "myai/", true);
      expect(key).toMatch(/^ndb_[0-9a-f]{32}$/);
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
  });

  describe("revoke", () => {
    it("removes the key and returns true", async () => {
      const service = makeService();
      const key = await service.create("myai", "myai/", true);
      expect(service.revoke("myai")).toBe(true);
      expect(service.list()).toHaveLength(0);
      expect(await service.validate(key)).toBeNull();
    });

    it("returns false for an unknown name", () => {
      const service = makeService();
      expect(service.revoke("does-not-exist")).toBe(false);
    });
  });
});
