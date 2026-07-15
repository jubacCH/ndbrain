import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDatabase } from "../db/database.js";
import { Indexer } from "../index/indexer.js";
import { NoteService } from "../notes/service.js";
import { Vault } from "../vault/files.js";
import { VaultGit } from "../vault/git.js";
import { AuthService } from "./auth.js";
import { ApiKeyService } from "../keys/service.js";
import { DocumentManager } from "../collab/document-manager.js";
import { buildServer, type ServerDeps } from "./server.js";

// I1: cross-origin cookies (the Tauri desktop webview) need `SameSite=None; Secure`,
// but that must be opt-in via env-sourced config (`ServerDeps.cookieSameSite`/
// `cookieSecure`, from `NDBRAIN_COOKIE_SAMESITE`/`NDBRAIN_COOKIE_SECURE` in
// production) - the default homelab-dev, same-origin-over-http case must keep
// setting the exact same cookie attributes as before this change.

let dir: string;
let app: FastifyInstance;

async function buildAppWithDeps(overrides: Partial<ServerDeps> = {}): Promise<FastifyInstance> {
  dir = await mkdtemp(join(tmpdir(), "ndbrain-cookie-"));
  const db = openDatabase(":memory:");
  const vault = new Vault(dir);
  const git = new VaultGit(dir);
  await git.init();
  const indexer = new Indexer(db);
  const auth = new AuthService(db);
  await auth.createUser("julian", "secret123");
  const notes = new NoteService(vault, git, indexer);
  const apiKeys = new ApiKeyService(db);
  const documents = new DocumentManager({ notes });
  return buildServer({ notes, auth, db, git, indexer, vault, apiKeys, documents, ...overrides });
}

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

async function login(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "julian", password: "secret123" },
  });
  const setCookie = res.headers["set-cookie"];
  return Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
}

describe("session cookie attributes", () => {
  it("default: SameSite=Lax, no Secure, HttpOnly, Path=/ (today's exact behavior)", async () => {
    app = await buildAppWithDeps();
    const setCookie = await login();
    expect(setCookie).toContain("ndbrain_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toMatch(/;\s*Secure/i);
  });

  it("NDBRAIN_COOKIE_SAMESITE=none + NDBRAIN_COOKIE_SECURE=true -> SameSite=None; Secure", async () => {
    app = await buildAppWithDeps({ cookieSameSite: "none", cookieSecure: true });
    const setCookie = await login();
    expect(setCookie).toContain("SameSite=None");
    expect(setCookie).toMatch(/;\s*Secure/i);
  });

  it("cookieSameSite=none without cookieSecure still sets SameSite=None (operator's responsibility to also set Secure)", async () => {
    app = await buildAppWithDeps({ cookieSameSite: "none" });
    const setCookie = await login();
    expect(setCookie).toContain("SameSite=None");
    expect(setCookie).not.toMatch(/;\s*Secure/i);
  });
});
