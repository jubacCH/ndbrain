import type { FastifyInstance } from "fastify";
import { backlinksOf, searchNotes } from "../index/search.js";
import type { ServerDeps } from "./server.js";

const wildcardPath = (req: any): string => decodeURIComponent(req.params["*"]);
const actor = (req: any): string => req.session.username;

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

  app.put("/api/v1/notes/*", async (req, reply) => {
    const path = deps.vault.assertSafePath(wildcardPath(req));
    const { content } = req.body as { content: string };
    await deps.notes.write(path, content, actor(req));
    return reply.code(204).send();
  });

  app.delete("/api/v1/notes/*", async (req, reply) => {
    const path = deps.vault.assertSafePath(wildcardPath(req));
    const removed = await deps.notes.remove(path, actor(req));
    return reply.code(removed ? 204 : 404).send();
  });

  // Body-based move (from/to) instead of a path wildcard: Fastify forbids mid-path wildcards.
  app.post("/api/v1/notes-move", async (req, reply) => {
    const { from, to } = req.body as { from: string; to: string };
    await deps.notes.move(deps.vault.assertSafePath(from), deps.vault.assertSafePath(to), actor(req));
    return reply.code(204).send();
  });

  app.get("/api/v1/search", async (req) => {
    const { q } = req.query as { q: string };
    return { hits: searchNotes(deps.db, q) };
  });

  app.get("/api/v1/backlinks/*", async (req) => {
    return { backlinks: backlinksOf(deps.db, deps.vault.assertSafePath(wildcardPath(req))) };
  });

  app.get("/api/v1/history/*", async (req) => {
    return { history: await deps.git.historyFor(deps.vault.assertSafePath(wildcardPath(req))) };
  });

  app.post("/api/v1/reindex", async () => {
    return { count: await deps.indexer.reindexAll(deps.vault) };
  });
}
