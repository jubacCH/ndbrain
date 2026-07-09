import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDatabase } from "../db/database.js";
import { Indexer } from "../index/indexer.js";
import { NoteService } from "../notes/service.js";
import { Vault } from "../vault/files.js";
import { VaultGit } from "../vault/git.js";
import { AuthService } from "../http/auth.js";
import { ApiKeyService } from "../keys/service.js";
import { buildServer } from "../http/server.js";

let dir: string;
let app: FastifyInstance;
let agentKey: string;
let baseUrl: string;

// Streamable-HTTP (stateless mode) requires this exact Accept header on every POST, and
// application/json Content-Type; see @modelcontextprotocol/sdk webStandardStreamableHttp.js.
const mcpHeaders = (key?: string) => ({
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  ...(key ? { authorization: `Bearer ${key}` } : {}),
});

function rpc(method: string, params?: object, id = 1) {
  return { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
}

// The SDK's Streamable HTTP transport drives the raw Node req/res itself (via
// @hono/node-server internally), which needs a real socket — Fastify's `inject()` fakes one
// and that trips up the transport's keep-alive bookkeeping. So this hits a real listening
// server over HTTP, which is also a more faithful end-to-end exercise of `/mcp` anyway.
async function postMcp(payload: object, key?: string): Promise<{ statusCode: number; json: () => any }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: mcpHeaders(key),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { statusCode: res.status, json: () => JSON.parse(text) };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ndbrain-mcp-"));
  const db = openDatabase(":memory:");
  const vault = new Vault(dir);
  const git = new VaultGit(dir);
  await git.init();
  const indexer = new Indexer(db);
  const auth = new AuthService(db);
  await auth.createUser("julian", "secret123");
  const notes = new NoteService(vault, git, indexer);
  const apiKeys = new ApiKeyService(db);
  agentKey = await apiKeys.create("myai", "myai/", true);
  app = buildServer({ notes, auth, db, git, indexer, vault, apiKeys });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("POST /mcp", () => {
  it("rejects a request with no Bearer key with 401", async () => {
    const res = await postMcp(rpc("tools/list"));
    expect(res.statusCode).toBe(401);
  });

  it("rejects a request with an invalid Bearer key with 401", async () => {
    const res = await postMcp(rpc("tools/list"), "ndb_totally-invalid");
    expect(res.statusCode).toBe(401);
  });

  it("lists the note tools for a valid agent key", async () => {
    const res = await postMcp(rpc("tools/list"), agentKey);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "search_notes",
        "read_note",
        "list_notes",
        "build_context",
        "write_note",
        "edit_note",
        "append_note",
        "move_note",
        "delete_note",
      ]),
    );
  });

  it("writes an in-scope note via tools/call and persists it", async () => {
    const res = await postMcp(
      rpc("tools/call", { name: "write_note", arguments: { path: "myai/a.md", content: "# A" } }),
      agentKey,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.isError).toBeFalsy();

    expect(await new Vault(dir).read("myai/a.md")).toBe("# A");
  });

  it("rejects an out-of-scope write as a tool error and writes nothing", async () => {
    const res = await postMcp(
      rpc("tools/call", { name: "write_note", arguments: { path: "other/x.md", content: "pwned" } }),
      agentKey,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.isError).toBe(true);

    expect(await new Vault(dir).read("other/x.md")).toBeNull();
  });
});
