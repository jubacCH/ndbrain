import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
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
import { buildServer } from "./server.js";

let vaultDir: string;
let webDistDir: string;
let app: FastifyInstance;
let db: Database;

const INDEX_HTML_MARKER = "<title>ndbrain-static-fixture</title>";

async function buildTestServer(distDirOverride: string | undefined) {
  db = openDatabase(":memory:");
  const vault = new Vault(vaultDir);
  const git = new VaultGit(vaultDir);
  await git.init();
  const indexer = new Indexer(db);
  const auth = new AuthService(db);
  const notes = new NoteService(vault, git, indexer);
  const apiKeys = new ApiKeyService(db);
  const documents = new DocumentManager({ notes });
  return buildServer({ notes, auth, db, git, indexer, vault, apiKeys, documents, webDistDir: distDirOverride });
}

afterEach(async () => {
  await app.close();
  await rm(vaultDir, { recursive: true, force: true });
  await rm(webDistDir, { recursive: true, force: true });
});

describe("static web serving, with a built web/dist fixture", () => {
  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "ndbrain-static-vault-"));
    webDistDir = await mkdtemp(join(tmpdir(), "ndbrain-static-dist-"));
    await mkdir(join(webDistDir, "assets"), { recursive: true });
    await writeFile(join(webDistDir, "index.html"), `<!doctype html><html><head>${INDEX_HTML_MARKER}</head></html>`);
    await writeFile(join(webDistDir, "assets", "app.js"), "console.log('hi');");
    app = await buildTestServer(webDistDir);
  });

  it("GET / serves the built index.html", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain(INDEX_HTML_MARKER);
  });

  it("GET of a real built asset serves that file, not the SPA fallback", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("console.log");
  });

  it("GET of an unknown client-side route falls back to index.html (SPA routing)", async () => {
    const res = await app.inject({ method: "GET", url: "/notes/some-id-that-does-not-exist" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(INDEX_HTML_MARKER);
  });

  it("static serving never shadows /api/*: an unauthenticated GET /api/v1/notes still 401s", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/notes" });
    expect(res.statusCode).toBe(401);
  });

  it("static serving never shadows /mcp or /collab: both stay reachable (not swallowed into index.html)", async () => {
    const mcpRes = await app.inject({ method: "POST", url: "/mcp", payload: {} });
    // Whatever /mcp's own auth/handling returns, it must NOT be our SPA's index.html.
    expect(mcpRes.body).not.toContain(INDEX_HTML_MARKER);

    const collabRes = await app.inject({ method: "GET", url: "/collab" });
    expect(collabRes.body).not.toContain(INDEX_HTML_MARKER);
  });

  it("an authenticated REST call still round-trips normally alongside static serving", async () => {
    const auth = new AuthService(db);
    await auth.createUser("julian", "secret123");
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "julian", password: "secret123" },
    });
    expect(login.statusCode).toBe(200);
    const token = login.json().token as string;

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/notes",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("static web serving, with no web/dist built yet", () => {
  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "ndbrain-static-vault-"));
    // A path that deliberately doesn't exist - simulates running the server from
    // source before `pnpm -F @ndbrain/web build` has ever produced a dist.
    webDistDir = join(tmpdir(), `ndbrain-static-missing-dist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    app = await buildTestServer(webDistDir);
  });

  it("boots without throwing and GET / does not crash the server (no static mounted)", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    // No index.html to serve; Fastify's default 404 (not a 500, and not a hang).
    expect(res.statusCode).toBe(404);
  });

  it("the API still works normally", async () => {
    const auth = new AuthService(db);
    await auth.createUser("julian", "secret123");
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "julian", password: "secret123" },
    });
    expect(login.statusCode).toBe(200);
    const token = login.json().token as string;

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/notes",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("an unauthenticated /api/v1/notes still 401s (auth exemption logic didn't accidentally open it up)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/notes" });
    expect(res.statusCode).toBe(401);
  });
});
