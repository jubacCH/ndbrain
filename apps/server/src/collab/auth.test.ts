import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.js";
import { AuthService } from "../http/auth.js";
import { ApiKeyService } from "../keys/service.js";
import { authenticateCollab, CollabAuthError } from "./auth.js";

function makeDeps() {
  const db = openDatabase(":memory:");
  return { auth: new AuthService(db), apiKeys: new ApiKeyService(db) };
}

describe("authenticateCollab", () => {
  describe("session tokens (human)", () => {
    it("authenticates a valid session as the username, read-write, for any doc", async () => {
      const deps = makeDeps();
      await deps.auth.createUser("julian", "secret123");
      const token = (await deps.auth.login("julian", "secret123"))!;

      const result = await authenticateCollab(deps, { token, documentName: "notes/x.md" });

      expect(result).toEqual({
        actor: "julian",
        readOnly: false,
        documentName: "notes/x.md",
      });
    });

    it("returns the canonical (normalized) documentName", async () => {
      const deps = makeDeps();
      await deps.auth.createUser("julian", "secret123");
      const token = (await deps.auth.login("julian", "secret123"))!;

      const result = await authenticateCollab(deps, {
        token,
        documentName: "myai/./x.md",
      });

      expect(result).toEqual({
        actor: "julian",
        readOnly: false,
        documentName: "myai/x.md",
      });
    });

    it("throws CollabAuthError for a valid session but a malformed/traversal documentName", async () => {
      const deps = makeDeps();
      await deps.auth.createUser("julian", "secret123");
      const token = (await deps.auth.login("julian", "secret123"))!;

      await expect(
        authenticateCollab(deps, { token, documentName: "../etc/passwd.md" }),
      ).rejects.toThrow(CollabAuthError);
      await expect(
        authenticateCollab(deps, { token, documentName: "notes/x.txt" }),
      ).rejects.toThrow(CollabAuthError);
    });
  });

  describe("API keys (agent)", () => {
    it("authenticates a valid write-key in-scope as the key name, read-write", async () => {
      const deps = makeDeps();
      const key = await deps.apiKeys.create("myai-agent", "myai/", true);

      const result = await authenticateCollab(deps, {
        token: key,
        documentName: "myai/notes.md",
      });

      expect(result).toEqual({
        actor: "myai-agent",
        readOnly: false,
        documentName: "myai/notes.md",
      });
    });

    it("authenticates a read-only key in-scope as read-only", async () => {
      const deps = makeDeps();
      const key = await deps.apiKeys.create("reader", "myai/", false);

      const result = await authenticateCollab(deps, {
        token: key,
        documentName: "myai/notes.md",
      });

      expect(result).toEqual({
        actor: "reader",
        readOnly: true,
        documentName: "myai/notes.md",
      });
    });

    it("throws when the doc is out of the key's scope", async () => {
      const deps = makeDeps();
      const key = await deps.apiKeys.create("myai-agent", "myai/", true);

      await expect(
        authenticateCollab(deps, { token: key, documentName: "other/notes.md" }),
      ).rejects.toThrow();
    });

    it("throws for a traversal documentName that normalizes outside the key's scope", async () => {
      // "myai/../other.md" normalizes (via assertSafePath) to "other.md" -
      // normalization must happen BEFORE the scope-prefix check, so this
      // must be rejected against a "myai/" scope rather than sneaking past
      // as a raw string that happens to start with "myai/".
      const deps = makeDeps();
      const key = await deps.apiKeys.create("myai-agent", "myai/", true);

      await expect(
        authenticateCollab(deps, { token: key, documentName: "myai/../other.md" }),
      ).rejects.toThrow();
    });

    it("throws CollabAuthError for malformed/traversal paths", async () => {
      const deps = makeDeps();
      const key = await deps.apiKeys.create("myai-agent", "myai/", true);

      await expect(
        authenticateCollab(deps, { token: key, documentName: "../etc/passwd.md" }),
      ).rejects.toThrow(CollabAuthError);
    });

    it("throws for an expired key", async () => {
      const deps = makeDeps();
      const past = new Date(Date.now() - 60_000).toISOString();
      const key = await deps.apiKeys.create("myai-agent", "myai/", true, past);

      await expect(
        authenticateCollab(deps, { token: key, documentName: "myai/notes.md" }),
      ).rejects.toThrow();
    });

    it("throws for a revoked key", async () => {
      const deps = makeDeps();
      const key = await deps.apiKeys.create("myai-agent", "myai/", true);
      deps.apiKeys.revoke("myai-agent");

      await expect(
        authenticateCollab(deps, { token: key, documentName: "myai/notes.md" }),
      ).rejects.toThrow();
    });
  });

  describe("no/invalid token", () => {
    it("throws when no token is provided", async () => {
      const deps = makeDeps();

      await expect(authenticateCollab(deps, { documentName: "notes/x.md" })).rejects.toThrow();
    });

    it("throws for a garbage session token", async () => {
      const deps = makeDeps();

      await expect(
        authenticateCollab(deps, { token: "garbage-token", documentName: "notes/x.md" }),
      ).rejects.toThrow();
    });

    it("throws for a garbage ndb_ key", async () => {
      const deps = makeDeps();

      await expect(
        authenticateCollab(deps, {
          token: "ndb_0000000000000000000000000000000000000000000000000000000000000000",
          documentName: "notes/x.md",
        }),
      ).rejects.toThrow();
    });
  });
});
