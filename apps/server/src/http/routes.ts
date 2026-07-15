import type { FastifyInstance } from "fastify";
import { backlinksOf, hybridSearch } from "../index/search.js";
import { buildGraph } from "../index/graph.js";
import { createMcpHandler } from "../mcp/server.js";
import { isNoneProvider } from "../embed/provider.js";
import type { ServerDeps } from "./server.js";

// find-my-way (Fastify's router) already URL-decodes wildcard route params before
// handlers ever see them - decoding again here double-decoded any path containing a
// literal `%` (e.g. "100%.md", already-decoded from "100%25.md" on the wire) into an
// invalid percent-escape, which made `decodeURIComponent` throw a URIError that
// bubbled up as an unhandled 500 instead of a normal note lookup.
const wildcardPath = (req: any): string => req.params["*"];
const actor = (req: any): string => req.session.username;

const DEFAULT_AUDIT_LIMIT = 100;
const MAX_AUDIT_LIMIT = 500;

interface AuditRow {
  ts: string;
  keyName: string | null;
  tool: string;
  target: string | null;
  allowed: number;
}

export function registerRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/api/v1/auth/login", async (req, reply) => {
    const { username, password } = req.body as { username: string; password: string };
    const token = await deps.auth.login(username, password);
    if (!token) return reply.code(401).send({ error: { code: "bad_credentials", message: "invalid login" } });
    // I1: cross-origin clients (the Tauri desktop webview) need `SameSite=None; Secure`
    // to receive this cookie at all - browsers drop `SameSite=None` cookies outright
    // unless `Secure` is also set. Both default to today's values (lax, not secure) so
    // a deployment that never sets the env vars gets byte-identical cookie attributes.
    reply.setCookie("ndbrain_session", token, {
      httpOnly: true,
      sameSite: deps.cookieSameSite ?? "lax",
      secure: deps.cookieSecure ?? false,
      path: "/",
    });
    return { token };
  });

  app.post("/api/v1/auth/logout", async (req, reply) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? req.cookies["ndbrain_session"];
    if (token) deps.auth.logout(token);
    return reply.code(204).send();
  });

  app.get("/api/v1/notes", async () => {
    const notes = deps.db.prepare("SELECT path, title FROM notes ORDER BY path").all();
    return { notes };
  });

  app.get("/api/v1/notes/*", async (req, reply) => {
    const path = deps.vault.assertSafePath(wildcardPath(req));
    const content = await deps.notes.read(path);
    if (content === null) return reply.code(404).send({ error: { code: "not_found", message: path } });
    return { path, content };
  });

  app.put(
    "/api/v1/notes/*",
    {
      schema: {
        body: { type: "object", required: ["content"], properties: { content: { type: "string" } } },
      },
    },
    async (req, reply) => {
      const path = deps.vault.assertSafePath(wildcardPath(req));
      const { content } = req.body as { content: string };
      await deps.notes.write(path, content, actor(req));
      return reply.code(204).send();
    },
  );

  app.delete("/api/v1/notes/*", async (req, reply) => {
    const path = deps.vault.assertSafePath(wildcardPath(req));
    const removed = await deps.notes.remove(path, actor(req));
    return reply.code(removed ? 204 : 404).send();
  });

  // Body-based move (from/to) instead of a path wildcard: Fastify forbids mid-path wildcards.
  app.post(
    "/api/v1/notes-move",
    {
      schema: {
        body: {
          type: "object",
          required: ["from", "to"],
          properties: { from: { type: "string" }, to: { type: "string" } },
        },
      },
    },
    async (req, reply) => {
      const { from, to } = req.body as { from: string; to: string };
      await deps.notes.move(deps.vault.assertSafePath(from), deps.vault.assertSafePath(to), actor(req));
      return reply.code(204).send();
    },
  );

  app.get(
    "/api/v1/search",
    {
      schema: {
        querystring: { type: "object", required: ["q"], properties: { q: { type: "string" } } },
      },
    },
    async (req) => {
      const { q } = req.query as { q: string };
      // Unscoped (no namespace filter): this REST endpoint is session-authed for a
      // human admin, not agent-key scoped like /mcp. Hybrid FTS+vector when an
      // embedding provider/store are configured, plain FTS otherwise (see hybridSearch's
      // own no-regression fallback).
      return { hits: await hybridSearch(deps.db, q, { provider: deps.embedProvider, store: deps.embedStore }) };
    },
  );

  app.get("/api/v1/backlinks/*", async (req) => {
    return { backlinks: backlinksOf(deps.db, deps.vault.assertSafePath(wildcardPath(req))) };
  });

  app.get("/api/v1/history/*", async (req) => {
    return { history: await deps.git.historyFor(deps.vault.assertSafePath(wildcardPath(req))) };
  });

  app.post("/api/v1/reindex", async () => {
    return { count: await deps.indexer.reindexAll(deps.vault) };
  });

  // Session-authed (same tier as /api/v1/reindex and the key/audit endpoints below):
  // a full re-embed is an admin action, not something an agent-scoped MCP key should
  // trigger. Guarded: with no embedding provider configured (the default), this must
  // never silently no-op — it returns a clear 409 instead.
  app.post("/api/v1/reindex-embeddings", async (_req, reply) => {
    if (!deps.embedProvider || isNoneProvider(deps.embedProvider) || !deps.embedIndexer) {
      return reply
        .code(409)
        .send({ error: { code: "embeddings_not_configured", message: "no embedding provider is configured" } });
    }
    const paths = await deps.vault.list();
    const notes: Array<{ path: string; markdown: string }> = [];
    for (const path of paths) {
      const markdown = await deps.vault.read(path);
      if (markdown !== null) notes.push({ path, markdown });
    }
    // Fire-and-forget, like the background startup reindex (main.ts): re-embedding a
    // whole vault can take a while against a real provider, and this must never block
    // the HTTP response or the event loop.
    const indexer = deps.embedIndexer;
    void indexer
      .reindexAll(notes)
      .catch((err) => console.error("[ndbrain] reindex-embeddings: background reindex failed:", err));
    return reply.code(202).send({ started: true, count: notes.length });
  });

  // Key management, audit trail and graph are all session-authed (humans manage keys
  // and inspect the vault via the web UI), not agent-key-authed like /mcp — no extra
  // work needed beyond registering under /api/v1, the onRequest hook in server.ts
  // already requires a valid session for everything except the exempted paths.

  app.get("/api/v1/keys", async () => {
    return { keys: deps.apiKeys.list() };
  });

  app.post(
    "/api/v1/keys",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "namespace", "canWrite"],
          properties: {
            name: { type: "string" },
            namespace: { type: "string" },
            canWrite: { type: "boolean" },
            expiresAt: { type: "string" },
          },
        },
      },
    },
    async (req) => {
      const { name, namespace, canWrite, expiresAt } = req.body as {
        name: string;
        namespace: string;
        canWrite: boolean;
        expiresAt?: string;
      };
      const key = await deps.apiKeys.create(name, namespace, canWrite, expiresAt);
      return { key };
    },
  );

  app.delete("/api/v1/keys/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const revoked = deps.apiKeys.revoke(name);
    return reply.code(revoked ? 204 : 404).send();
  });

  app.get(
    "/api/v1/audit",
    {
      schema: {
        querystring: { type: "object", properties: { limit: { type: "string" } } },
      },
    },
    async (req) => {
      const { limit } = req.query as { limit?: string };
      const requested = limit ? Number.parseInt(limit, 10) : DEFAULT_AUDIT_LIMIT;
      const bounded =
        Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_AUDIT_LIMIT) : DEFAULT_AUDIT_LIMIT;

      const rows = deps.db
        .prepare(
          `SELECT access_log.ts AS ts, api_keys.name AS keyName, access_log.tool AS tool,
                  access_log.target AS target, access_log.allowed AS allowed
           FROM access_log
           LEFT JOIN api_keys ON api_keys.id = access_log.key_id
           ORDER BY access_log.id DESC
           LIMIT ?`,
        )
        .all(bounded) as AuditRow[];

      return {
        entries: rows.map((row) => ({
          ts: row.ts,
          keyName: row.keyName,
          tool: row.tool,
          target: row.target,
          allowed: row.allowed === 1,
        })),
      };
    },
  );

  app.get("/api/v1/graph", async () => {
    return buildGraph(deps.db);
  });

  // MCP Streamable HTTP (agent-key auth, not session cookie — see the onRequest exemption
  // in server.ts and createMcpHandler's own 401 handling).
  app.all("/mcp", createMcpHandler(deps));
}
