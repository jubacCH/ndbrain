import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
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
import { createCollabServer, type CollabServerOptions } from "../collab/server.js";
import type { DocumentManager } from "../collab/document-manager.js";

// Test-only: capture the last WebSocket created in handleUpgrade for testing
// error handling in tests. Access via (globalThis as any)._ndbrain_test_lastWs
if (globalThis.process?.env?.NODE_ENV !== "production") {
  if (!(globalThis as any)._ndbrain_test_sockets) {
    (globalThis as any)._ndbrain_test_sockets = [];
  }
}

export interface ServerDeps {
  notes: NoteService;
  auth: AuthService;
  db: Database;
  git: VaultGit;
  indexer: Indexer;
  vault: Vault;
  apiKeys: ApiKeyService;
  documents: DocumentManager;
  /** Overrides for the Hocuspocus config (e.g. shorter `debounce`/`maxDebounce`
   *  in tests). Not used in production. */
  collabOptions?: CollabServerOptions;
}

/** Builds a Fetch-API `Request` (Node 22 global) from a raw WS-upgrade
 *  `http.IncomingMessage`, matching what Hocuspocus expects as the `request`
 *  argument to `handleConnection` (verified: NOT `http.IncomingMessage`, see
 *  Task 1 spike / `onAuthenticatePayload.request: Request`). */
function toFetchRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  return new Request(url, { headers, method: req.method ?? "GET" });
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  // coerceTypes off so schema type mismatches (e.g. numeric content) are rejected, not coerced.
  const app = Fastify({ logger: false, ajv: { customOptions: { coerceTypes: false } } });
  app.register(cookie);

  app.addHook("onRequest", async (req, reply) => {
    // Parse pathname once: req.url includes the query string, so split on '?' first.
    // /api/v1/auth/login, /mcp and /collab should all be exempted from session auth:
    // - login authenticates by credentials (username/password), not session
    // - MCP uses agent-key auth (Bearer -> ApiKeyService.validate), not the session cookie
    // (see mcp/server.ts's own 401 handling).
    // - /collab authenticates inside Hocuspocus's own onAuthenticate hook (see
    // authenticateCollab), over the WebSocket wire protocol, not this HTTP hook. In
    // practice a real WS upgrade never reaches this hook at all once the raw
    // 'upgrade' handler below is registered (Node routes upgrade requests away from
    // the 'request' event entirely) - this exemption only matters for a stray plain
    // HTTP request to /collab (no Upgrade header), which should 404, not 401.
    const pathname = req.url.split("?", 1)[0];
    if (pathname === "/api/v1/auth/login" || pathname === "/mcp" || pathname === "/collab") return;
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
  mountCollab(app, deps);
  return app;
}

/**
 * Forwards WebSocket upgrades on `/collab` into Hocuspocus's `handleConnection`.
 *
 * Verified approach (no `@fastify/websocket` installed/needed): Fastify owns a
 * plain Node `http.Server` at `app.server`, available synchronously right after
 * `Fastify()` (confirmed: 0 listeners on its 'upgrade' event before this runs).
 * We attach our own 'upgrade' listener directly, using `ws`'s
 * `WebSocketServer({ noServer: true })` + `wss.handleUpgrade` to complete the
 * handshake ourselves, then hand the resulting `ws` instance to
 * `hocuspocus.handleConnection(ws, request)`.
 *
 * `hocuspocus.handleConnection` does NOT itself subscribe to the socket's
 * `message`/`close` events (verified against the installed
 * `@hocuspocus/server@4.3.0` source: `ClientConnection` exposes `handleMessage`/
 * `handleClose` as methods the *caller* must drive — the real `Server` class's
 * own crossws-based wiring does exactly this forwarding, which we mirror here
 * with `ws` instead of `crossws`).
 *
 * Once any 'upgrade' listener is registered on a Node `http.Server`, Node no
 * longer auto-rejects upgrade requests on other paths — we own all of them now,
 * so non-`/collab` upgrades are explicitly rejected (never silently hung).
 */
function mountCollab(app: FastifyInstance, deps: ServerDeps): void {
  const hocuspocus = createCollabServer(
    { auth: deps.auth, apiKeys: deps.apiKeys, documents: deps.documents },
    deps.collabOptions,
  );
  const wss = new WebSocketServer({ noServer: true });

  app.server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const pathname = (req.url ?? "").split("?", 1)[0];
    if (pathname !== "/collab") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const request = toFetchRequest(req);
      const connection = hocuspocus.handleConnection(ws, request);
      // The Hocuspocus wire protocol is always binary frames; `ws` delivers
      // message data as a `Buffer` (a `Uint8Array` subclass) by default.
      ws.on("message", (data: Buffer) => {
        connection.handleMessage(new Uint8Array(data));
      });
      ws.on("close", (code: number, reason: Buffer) => {
        connection.handleClose({ code, reason: reason.toString() });
      });
      // Critical: handle socket errors to prevent process crash. Without this handler,
      // any socket fault (ECONNRESET, TCP RST, protocol error) emits an uncaughtException
      // that terminates the entire server. This mirrors the error handling in the
      // reference Hocuspocus crossws server implementation.
      ws.on("error", (err) => {
        console.error("WebSocket error on /collab connection:", err.message);
        // Do not rethrow: the error is logged and the individual connection
        // tears down cleanly; the server process continues.
      });
      // Test-only: capture ws for error handling tests
      if ((globalThis as any)._ndbrain_test_sockets) {
        (globalThis as any)._ndbrain_test_sockets.push(ws);
      }
    });
  });
}
