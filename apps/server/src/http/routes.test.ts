import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDatabase, type Database } from "../db/database.js";
import { Indexer } from "../index/indexer.js";
import { NoteService } from "../notes/service.js";
import { Vault } from "../vault/files.js";
import { VaultGit } from "../vault/git.js";
import { AuthService } from "./auth.js";
import { ApiKeyService } from "../keys/service.js";
import { logAccess } from "../audit/log.js";
import { buildServer } from "./server.js";
import { DocumentManager } from "../collab/document-manager.js";

let dir: string;
let app: FastifyInstance;
let token: string;
let notes: NoteService;
let db: Database;
let apiKeys: ApiKeyService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ndbrain-http-"));
  db = openDatabase(":memory:");
  const vault = new Vault(dir);
  const git = new VaultGit(dir);
  await git.init();
  const indexer = new Indexer(db);
  const auth = new AuthService(db);
  await auth.createUser("julian", "secret123");
  notes = new NoteService(vault, git, indexer);
  apiKeys = new ApiKeyService(db);
  const documents = new DocumentManager({ notes });
  app = buildServer({ notes, auth, db, git, indexer, vault, apiKeys, documents });
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "julian", password: "secret123" },
  });
  token = login.json().token;
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const authed = (opts: object) => ({ ...opts, headers: { authorization: `Bearer ${token}` } });

describe("REST /api/v1/auth", () => {
  it("login with query string succeeds with valid credentials", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login?x=1",
      payload: { username: "julian", password: "secret123" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("token");
  });
});

describe("REST /api/v1", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/notes" });
    expect(res.statusCode).toBe(401);
  });

  it("full note lifecycle: put, get, list, search, backlinks, history, delete", async () => {
    const put = await app.inject(
      authed({ method: "PUT", url: "/api/v1/notes/myai/a.md", payload: { content: "# Alpha\n[[myai/b]]" } }),
    );
    expect(put.statusCode).toBe(204);
    await app.inject(authed({ method: "PUT", url: "/api/v1/notes/myai/b.md", payload: { content: "# Beta" } }));

    const get = await app.inject(authed({ method: "GET", url: "/api/v1/notes/myai/a.md" }));
    expect(get.json()).toMatchObject({ path: "myai/a.md", content: "# Alpha\n[[myai/b]]" });

    const list = await app.inject(authed({ method: "GET", url: "/api/v1/notes" }));
    expect(list.json().notes).toHaveLength(2);

    const search = await app.inject(authed({ method: "GET", url: "/api/v1/search?q=Alpha" }));
    expect(search.json().hits[0].path).toBe("myai/a.md");

    const back = await app.inject(authed({ method: "GET", url: "/api/v1/backlinks/myai/b.md" }));
    expect(back.json().backlinks).toEqual(["myai/a.md"]);

    const hist = await app.inject(authed({ method: "GET", url: "/api/v1/history/myai/a.md" }));
    expect(hist.json().history[0].author).toBe("julian");

    const del = await app.inject(authed({ method: "DELETE", url: "/api/v1/notes/myai/a.md" }));
    expect(del.statusCode).toBe(204);
  });

  it("maps unsafe paths to 400 and missing notes to 404", async () => {
    const bad = await app.inject(
      authed({ method: "PUT", url: "/api/v1/notes/..%2Fevil.md", payload: { content: "x" } }),
    );
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject(authed({ method: "GET", url: "/api/v1/notes/nope.md" }));
    expect(missing.statusCode).toBe(404);
  });

  it("rejects writes into the .git directory with 400", async () => {
    const res = await app.inject(
      authed({ method: "PUT", url: "/api/v1/notes/.git/x.md", payload: { content: "x" } }),
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when moving a note whose source is missing", async () => {
    const res = await app.inject(
      authed({ method: "POST", url: "/api/v1/notes-move", payload: { from: "nope.md", to: "x.md" } }),
    );
    expect(res.statusCode).toBe(404);
  });

  it("returns 409 when the move target already exists and leaves it untouched", async () => {
    await app.inject(authed({ method: "PUT", url: "/api/v1/notes/a.md", payload: { content: "# A" } }));
    await app.inject(authed({ method: "PUT", url: "/api/v1/notes/b.md", payload: { content: "# B" } }));
    const res = await app.inject(
      authed({ method: "POST", url: "/api/v1/notes-move", payload: { from: "a.md", to: "b.md" } }),
    );
    expect(res.statusCode).toBe(409);
    const b = await app.inject(authed({ method: "GET", url: "/api/v1/notes/b.md" }));
    expect(b.json().content).toBe("# B");
  });

  it("returns 400 for a search without the required q parameter", async () => {
    const res = await app.inject(authed({ method: "GET", url: "/api/v1/search" }));
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when the note content is not a string", async () => {
    const res = await app.inject(
      authed({ method: "PUT", url: "/api/v1/notes/x.md", payload: { content: 123 } }),
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/notes/x.md",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: "{ not valid json",
    });
    expect(res.statusCode).toBe(400);
  });

  it("maps an unexpected internal error to 500 without leaking the raw message", async () => {
    vi.spyOn(notes, "write").mockRejectedValueOnce(new Error("secret-internal-detail-42"));
    const res = await app.inject(
      authed({ method: "PUT", url: "/api/v1/notes/x.md", payload: { content: "y" } }),
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("secret-internal-detail-42");
  });

  it("moves a note via notes-move and preserves history", async () => {
    await app.inject(authed({ method: "PUT", url: "/api/v1/notes/src.md", payload: { content: "# Src" } }));
    const move = await app.inject(
      authed({ method: "POST", url: "/api/v1/notes-move", payload: { from: "src.md", to: "dst/moved.md" } }),
    );
    expect(move.statusCode).toBe(204);
    const gone = await app.inject(authed({ method: "GET", url: "/api/v1/notes/src.md" }));
    expect(gone.statusCode).toBe(404);
    const there = await app.inject(authed({ method: "GET", url: "/api/v1/notes/dst/moved.md" }));
    expect(there.json().content).toBe("# Src");
    const hist = await app.inject(authed({ method: "GET", url: "/api/v1/history/dst/moved.md" }));
    expect(hist.json().history.length).toBeGreaterThanOrEqual(2);
  });
});

describe("REST /api/v1/keys", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/keys" });
    expect(res.statusCode).toBe(401);
  });

  it("creates a key and lists it without the hash", async () => {
    const create = await app.inject(
      authed({
        method: "POST",
        url: "/api/v1/keys",
        payload: { name: "agent-1", namespace: "myai/", canWrite: true },
      }),
    );
    expect(create.statusCode).toBe(200);
    expect(create.json().key).toMatch(/^ndb_[0-9a-f]{64}$/);

    const list = await app.inject(authed({ method: "GET", url: "/api/v1/keys" }));
    expect(list.statusCode).toBe(200);
    expect(list.json().keys).toEqual([
      expect.objectContaining({ name: "agent-1", namespace: "myai/", canWrite: true }),
    ]);
    expect(list.json().keys[0]).not.toHaveProperty("keyHash");
    expect(list.json().keys[0]).not.toHaveProperty("key_hash");
  });

  it("returns 400 for an invalid key name", async () => {
    const res = await app.inject(
      authed({
        method: "POST",
        url: "/api/v1/keys",
        payload: { name: "bad name!", namespace: "", canWrite: false },
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns 409 for a duplicate key name", async () => {
    await app.inject(
      authed({ method: "POST", url: "/api/v1/keys", payload: { name: "dup", namespace: "", canWrite: false } }),
    );
    const res = await app.inject(
      authed({ method: "POST", url: "/api/v1/keys", payload: { name: "dup", namespace: "", canWrite: false } }),
    );
    expect(res.statusCode).toBe(409);
  });

  it("returns 400 when the request body is missing required fields", async () => {
    const res = await app.inject(authed({ method: "POST", url: "/api/v1/keys", payload: { name: "x" } }));
    expect(res.statusCode).toBe(400);
  });

  it("revokes a key: 204 when it existed, 404 when it did not", async () => {
    await app.inject(
      authed({ method: "POST", url: "/api/v1/keys", payload: { name: "gone", namespace: "", canWrite: false } }),
    );
    const del = await app.inject(authed({ method: "DELETE", url: "/api/v1/keys/gone" }));
    expect(del.statusCode).toBe(204);

    const missing = await app.inject(authed({ method: "DELETE", url: "/api/v1/keys/gone" }));
    expect(missing.statusCode).toBe(404);

    const list = await app.inject(authed({ method: "GET", url: "/api/v1/keys" }));
    expect(list.json().keys).toEqual([]);
  });

  it("returns 400 with malformed expiresAt instead of 500", async () => {
    const res = await app.inject(
      authed({
        method: "POST",
        url: "/api/v1/keys",
        payload: { name: "bad-expiry", namespace: "", canWrite: false, expiresAt: "garbage" },
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_expiry");
  });

  it("does not include the internal id in list responses", async () => {
    await app.inject(
      authed({
        method: "POST",
        url: "/api/v1/keys",
        payload: { name: "test-key", namespace: "test/", canWrite: false },
      }),
    );
    const list = await app.inject(authed({ method: "GET", url: "/api/v1/keys" }));
    expect(list.statusCode).toBe(200);
    expect(list.json().keys[0]).not.toHaveProperty("id");
  });

  it("prevents an API key from accessing key-management endpoints (401)", async () => {
    // Mint a real API key via the service.
    const apiKey = await apiKeys.create("agent-test", "myai/", true);

    // Try to use it as Bearer auth on /api/v1/keys endpoints.
    const getKeys = await app.inject({
      method: "GET",
      url: "/api/v1/keys",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(getKeys.statusCode).toBe(401);

    const postKeys = await app.inject({
      method: "POST",
      url: "/api/v1/keys",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { name: "should-fail", namespace: "", canWrite: false },
    });
    expect(postKeys.statusCode).toBe(401);

    const deleteKeys = await app.inject({
      method: "DELETE",
      url: "/api/v1/keys/agent-test",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(deleteKeys.statusCode).toBe(401);
  });
});

describe("REST /api/v1/audit", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/audit" });
    expect(res.statusCode).toBe(401);
  });

  it("resolves the key name via a join, newest first, and keeps names for revoked keys", async () => {
    await apiKeys.create("agent-1", "", true);
    const keyRow = db.prepare("SELECT id FROM api_keys WHERE name = ?").get("agent-1") as { id: number };

    logAccess(db, keyRow.id, "search_notes", null, true);
    logAccess(db, null, "auth", null, false);
    logAccess(db, keyRow.id, "read_note", "a.md", true);

    // Revoking the key must not break audit-log name resolution (soft-revoke).
    apiKeys.revoke("agent-1");

    const audit = await app.inject(authed({ method: "GET", url: "/api/v1/audit" }));
    expect(audit.statusCode).toBe(200);
    const entries = audit.json().entries as Array<{
      keyName: string | null;
      tool: string;
      target: string | null;
      allowed: boolean;
      ts: string;
    }>;
    expect(entries).toHaveLength(3);
    // Newest first.
    expect(entries.map((e) => e.tool)).toEqual(["read_note", "auth", "search_notes"]);
    expect(entries[0]).toMatchObject({ keyName: "agent-1", tool: "read_note", target: "a.md", allowed: true });
    expect(entries[1]).toMatchObject({ keyName: null, tool: "auth", target: null, allowed: false });
    expect(entries[2]).toMatchObject({ keyName: "agent-1", tool: "search_notes", target: null, allowed: true });
  });

  it("clamps the limit query param to a sane maximum", async () => {
    const res = await app.inject(authed({ method: "GET", url: "/api/v1/audit?limit=999999" }));
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().entries)).toBe(true);
  });
});

describe("REST /api/v1/graph", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/graph" });
    expect(res.statusCode).toBe(401);
  });

  it("returns nodes and edges built from indexed notes and links", async () => {
    await app.inject(authed({ method: "PUT", url: "/api/v1/notes/a.md", payload: { content: "# A\n[[b]]" } }));
    await app.inject(authed({ method: "PUT", url: "/api/v1/notes/b.md", payload: { content: "# B" } }));

    const res = await app.inject(authed({ method: "GET", url: "/api/v1/graph" }));
    expect(res.statusCode).toBe(200);
    expect(res.json().nodes).toEqual(
      expect.arrayContaining([
        { id: "a.md", title: "A" },
        { id: "b.md", title: "B" },
      ]),
    );
    expect(res.json().edges).toEqual([{ source: "a.md", target: "b.md" }]);
  });
});
