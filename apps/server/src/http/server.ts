import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type { Database } from "../db/database.js";
import type { Indexer } from "../index/indexer.js";
import type { NoteService } from "../notes/service.js";
import type { Vault } from "../vault/files.js";
import { VaultPathError } from "../vault/files.js";
import { NoteExistsError, NoteNotFoundError } from "../notes/errors.js";
import type { VaultGit } from "../vault/git.js";
import type { ApiKeyService } from "../keys/service.js";
import type { AuthService } from "./auth.js";
import { registerRoutes } from "./routes.js";

export interface ServerDeps {
  notes: NoteService;
  auth: AuthService;
  db: Database;
  git: VaultGit;
  indexer: Indexer;
  vault: Vault;
  apiKeys: ApiKeyService;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  // coerceTypes off so schema type mismatches (e.g. numeric content) are rejected, not coerced.
  const app = Fastify({ logger: false, ajv: { customOptions: { coerceTypes: false } } });
  app.register(cookie);

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/api/v1/auth/login") return;
    // MCP uses agent-key auth (Bearer -> ApiKeyService.validate), not the session cookie —
    // see mcp/server.ts's own 401 handling.
    if (req.url === "/mcp") return;
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const token = bearer ?? req.cookies["ndbrain_session"];
    const session = token ? deps.auth.validateSession(token) : null;
    if (!session) return reply.code(401).send({ error: { code: "unauthorized", message: "login required" } });
    (req as any).session = session;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof VaultPathError)
      return reply.code(400).send({ error: { code: "bad_path", message: err.message } });
    if (err instanceof NoteNotFoundError)
      return reply.code(404).send({ error: { code: "not_found", message: err.message } });
    if (err instanceof NoteExistsError)
      return reply.code(409).send({ error: { code: "conflict", message: err.message } });
    // Fastify client-side errors (validation, malformed body, unknown route): pass the
    // status through with a generic message, never the raw error text.
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500)
      return reply.code(status).send({ error: { code: "bad_request", message: "bad request" } });
    // Anything else is an unexpected internal fault: log server-side, never leak the message.
    req.log.error(err);
    return reply.code(500).send({ error: { code: "internal", message: "internal error" } });
  });

  registerRoutes(app, deps);
  return app;
}
