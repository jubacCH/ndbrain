import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type { Database } from "../db/database.js";
import type { Indexer } from "../index/indexer.js";
import type { NoteService } from "../notes/service.js";
import type { Vault } from "../vault/files.js";
import { VaultPathError } from "../vault/files.js";
import type { VaultGit } from "../vault/git.js";
import type { AuthService } from "./auth.js";
import { registerRoutes } from "./routes.js";

export interface ServerDeps {
  notes: NoteService;
  auth: AuthService;
  db: Database;
  git: VaultGit;
  indexer: Indexer;
  vault: Vault;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(cookie);

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/api/v1/auth/login") return;
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const token = bearer ?? req.cookies["ndbrain_session"];
    const session = token ? deps.auth.validateSession(token) : null;
    if (!session) return reply.code(401).send({ error: { code: "unauthorized", message: "login required" } });
    (req as any).session = session;
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof VaultPathError)
      return reply.code(400).send({ error: { code: "bad_path", message: err.message } });
    return reply.code(500).send({ error: { code: "internal", message: (err as Error).message } });
  });

  registerRoutes(app, deps);
  return app;
}
