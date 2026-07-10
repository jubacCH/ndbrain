import type { FastifyInstance } from "fastify";
import { backlinksOf, searchNotes } from "../index/search.js";
import { buildGraph } from "../index/graph.js";
import { createMcpHandler } from "../mcp/server.js";
import type { ServerDeps } from "./server.js";

const wildcardPath = (req: any): string => decodeURIComponent(req.params["*"]);
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
    reply.setCookie("ndbrain_session", token, { httpOnly: true, sameSite: "lax", path: "/" });
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
      return { hits: searchNotes(deps.db, q) };
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
