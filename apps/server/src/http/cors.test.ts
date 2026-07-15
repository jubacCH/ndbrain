import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDatabase, type Database } from "../db/database.js";
import { Indexer } from "../index/indexer.js";
import { NoteService } from "../notes/service.js";
import { Vault } from "../vault/files.js";
import { VaultGit } from "../vault/git.js";
import { AuthService } from "./auth.js";
import { ApiKeyService } from "../keys/service.js";
import { DocumentManager } from "../collab/document-manager.js";
import { buildServer, type ServerDeps } from "./server.js";

// I1: the Tauri desktop webview runs the web app from a non-http(s) origin
// (`tauri://localhost` on macOS, `http://tauri.localhost` on Windows) - genuinely
// cross-origin from the server's point of view. These tests cover the CORS
// allowlist (`ServerDeps.allowedOrigins`, sourced from `NDBRAIN_ALLOWED_ORIGINS`
// in production) added to close that gap, with a hard requirement: the existing
// browser/same-origin case must come out byte-identical when no allowlist is
// configured (the default).

let dir: string;
let db: Database;
let notes: NoteService;
let apiKeys: ApiKeyService;

/** Minimal `ServerDeps`, shared by every test below; `allowedOrigins` (and any
 *  other override) is layered on top per-test. */
async function makeDeps(): Promise<ServerDeps> {
  dir = await mkdtemp(join(tmpdir(), "ndbrain-cors-"));
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
  return { notes, auth, db, git, indexer, vault, apiKeys, documents };
}

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("CORS: default (no NDBRAIN_ALLOWED_ORIGINS configured)", () => {
  beforeEach(async () => {
    app = buildServer(await makeDeps());
  });

  it("never sends an Access-Control-Allow-Origin header, even when the request carries an Origin", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "julian", password: "secret123" },
      headers: { origin: "http://localhost:3000" },
    });
    expect(login.headers["access-control-allow-origin"]).toBeUndefined();
    expect(login.headers["access-control-allow-credentials"]).toBeUndefined();

    const token = login.json().token;
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/notes",
      headers: { authorization: `Bearer ${token}`, origin: "tauri://localhost" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("preserves today's OPTIONS handling: 401 when unauthenticated (no preflight bypass)", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/notes",
      headers: { origin: "tauri://localhost", "access-control-request-method": "GET" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("preserves today's OPTIONS handling: 404 (method not routed) when authenticated", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "julian", password: "secret123" },
    });
    const token = login.json().token;
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/notes",
      headers: { authorization: `Bearer ${token}`, origin: "tauri://localhost" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("CORS: NDBRAIN_ALLOWED_ORIGINS configured", () => {
  const allowedOrigins = ["tauri://localhost", "http://tauri.localhost"];

  beforeEach(async () => {
    app = buildServer({ ...(await makeDeps()), allowedOrigins });
  });

  it("echoes back an allowed origin with credentials enabled", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "julian", password: "secret123" },
      headers: { origin: "tauri://localhost" },
    });
    expect(login.headers["access-control-allow-origin"]).toBe("tauri://localhost");
    expect(login.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("does not echo an origin outside the allowlist", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "julian", password: "secret123" },
      headers: { origin: "http://evil.example" },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers a CORS preflight (OPTIONS) for a protected route without requiring auth", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/notes",
      headers: {
        origin: "tauri://localhost",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers["access-control-allow-origin"]).toBe("tauri://localhost");
    expect(res.headers["access-control-allow-methods"]).toContain("GET");
  });

  it("still 401s an actual (non-preflight) unauthenticated request from an allowed origin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/notes",
      headers: { origin: "tauri://localhost" },
    });
    expect(res.statusCode).toBe(401);
  });
});
