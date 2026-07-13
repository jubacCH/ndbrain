import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Database } from "../db/database.js";
import type { Indexer } from "../index/indexer.js";
import type { NoteService } from "../notes/service.js";
import type { Vault } from "../vault/files.js";
import { VaultPathError } from "../vault/files.js";
import { NoteBusyError, NoteExistsError, NoteNotFoundError } from "../notes/errors.js";
import type { VaultGit } from "../vault/git.js";
import { DuplicateKeyNameError, InvalidKeyNameError, InvalidExpiryError, type ApiKeyService } from "../keys/service.js";
import type { AuthService } from "./auth.js";
import { registerRoutes } from "./routes.js";
import type { Hocuspocus } from "@hocuspocus/server";
import { createCollabServer, type CollabServerOptions } from "../collab/server.js";
import type { DocumentManager } from "../collab/document-manager.js";
import { registerStatic } from "./static.js";

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
  /** Test-only observation hook: called with every `ws` completed on `/collab`, so tests
   *  can reach into the server-side socket (e.g. to simulate a raw socket error) without
   *  the production code path retaining any reference to it. Never passed in production -
   *  no prod code path may accumulate sockets (see I4: this replaces a NODE_ENV-gated
   *  global that leaked every socket forever outside Docker, where NODE_ENV is unset). */
  onCollabSocket?: (ws: WebSocket) => void;
  /** Overrides where the built web app is served from (see `http/static.ts`).
   *  Tests point this at a temp fixture dir, or at a nonexistent path to
   *  exercise the no-dist-yet guard; production leaves it unset and gets the
   *  real `apps/web/dist`. */
  webDistDir?: string;
}

/** Builds the same-origin URL for a raw upgrade `req`, tolerating a malformed `Host`
 *  header instead of letting `new URL` throw. A raw TCP client controls every byte of
 *  the Host header field (e.g. a literal space), and this runs on every unauthenticated
 *  `/collab` upgrade attempt - it must never crash the process (see C1 hardening). Falls
 *  back to `localhost` as the authority when the client-supplied host doesn't parse. */
function safeUpgradeUrl(req: IncomingMessage): URL {
  const host = req.headers.host ?? "localhost";
  try {
    return new URL(req.url ?? "/", `http://${host}`);
  } catch {
    return new URL(req.url ?? "/", "http://localhost");
  }
}

/** Builds a Fetch-API `Request` (Node 22 global) from a raw WS-upgrade
 *  `http.IncomingMessage`, matching what Hocuspocus expects as the `request`
 *  argument to `handleConnection` (verified: NOT `http.IncomingMessage`, see
 *  Task 1 spike / `onAuthenticatePayload.request: Request`). */
function toFetchRequest(req: IncomingMessage): Request {
  const url = safeUpgradeUrl(req);
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

/** A built server exposes the underlying live Hocuspocus instance and a way to force-
 *  close every raw `/collab` socket, alongside the plain Fastify app (see C2), so
 *  `main.ts`/`shutdown.ts` can disconnect clients, flush pending collab-doc stores and
 *  unblock `app.close()` on shutdown - `mountCollab` otherwise keeps both trapped in its
 *  own local scope with no way out. */
export type NdbrainServer = FastifyInstance & CollabMount;

export function buildServer(deps: ServerDeps): NdbrainServer {
  // coerceTypes off so schema type mismatches (e.g. numeric content) are rejected, not coerced.
  const app = Fastify({ logger: false, ajv: { customOptions: { coerceTypes: false } } });
  app.register(cookie);

  app.addHook("onRequest", async (req, reply) => {
    // Parse pathname once: req.url includes the query string, so split on '?' first.
    // Decode it too (once - do NOT loop-decode): find-my-way (the router) matches routes
    // against the DECODED path, so a raw comparison here would disagree with the router
    // on requests like "/%61pi/v1/notes" - it doesn't start with "/api/" raw, so this hook
    // would return early (skip auth), while the router decodes "%61" -> "a" and runs the
    // real /api/v1/notes handler completely unauthenticated (see C1). A single decode
    // aligns this gate with the router's single decode; double-encoding (e.g. "%2561")
    // decodes once to the literal "%61", which still won't match "/api/" either way, so
    // there is no bypass left to close by decoding more than once.
    let pathname = req.url.split("?", 1)[0];
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // Malformed percent-encoding: leave pathname as the raw (undecoded) string. It
      // won't match "/api/" or any of the exemptions below, and find-my-way will itself
      // fail to route it too (same malformed input), so this falls through to a 404 -
      // never an auth bypass.
    }
    // /mcp and /collab authenticate themselves, not via this session-cookie hook:
    // - MCP uses agent-key auth (Bearer -> ApiKeyService.validate, see mcp/server.ts's
    //   own 401 handling).
    // - /collab authenticates inside Hocuspocus's own onAuthenticate hook (see
    //   authenticateCollab), over the WebSocket wire protocol. In practice a real WS
    //   upgrade never reaches this hook at all once the raw 'upgrade' handler below is
    //   registered (Node routes upgrade requests away from the 'request' event
    //   entirely) - this exemption only matters for a stray plain HTTP request to
    //   /collab (no Upgrade header), which should 404, not 401.
    if (pathname === "/mcp" || pathname === "/collab") return;
    // Everything outside /api/* is either a built web asset or the SPA fallback (see
    // static.ts) - both must be reachable unauthenticated. The SPA's own login screen
    // is itself one of those assets, so gating them on a session would make it
    // impossible to ever load the page that lets you create one.
    if (!pathname.startsWith("/api/")) return;
    // Login authenticates by credentials (username/password), not session.
    if (pathname === "/api/v1/auth/login") return;
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
    // I1: move/remove of a note currently open in a live collab doc - same 409 status as
    // NoteExistsError (both are "can't do this mutation right now"), distinct code so a
    // REST client can tell "try again shortly" (busy) apart from "target already exists".
    if (err instanceof NoteBusyError)
      return reply.code(409).send({ error: { code: "busy", message: err.message } });
    if (err instanceof InvalidKeyNameError)
      return reply.code(400).send({ error: { code: "invalid_key_name", message: err.message } });
    if (err instanceof InvalidExpiryError)
      return reply.code(400).send({ error: { code: "invalid_expiry", message: err.message } });
    if (err instanceof DuplicateKeyNameError)
      return reply.code(409).send({ error: { code: "duplicate_key_name", message: err.message } });
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
  const collab = mountCollab(app, deps);
  // Registered last: its `setNotFoundHandler` fallback only ever runs for a request
  // nothing above already matched, and this ordering keeps that intent explicit (see
  // static.ts's own doc comment on why /api/* and friends can never actually be
  // shadowed by it regardless of order).
  registerStatic(app, deps.webDistDir);
  return Object.assign(app, collab);
}

/** Return value of `mountCollab`: the live Hocuspocus instance plus a way to forcibly
 *  close every currently-open raw `/collab` socket (see C2 and `closeCollabSockets`'s
 *  own doc comment on why this is necessary at all). */
export interface CollabMount {
  hocuspocus: Hocuspocus;
  closeCollabSockets(): void;
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
function mountCollab(app: FastifyInstance, deps: ServerDeps): CollabMount {
  const hocuspocus = createCollabServer(
    { auth: deps.auth, apiKeys: deps.apiKeys, documents: deps.documents },
    deps.collabOptions,
  );
  const wss = new WebSocketServer({ noServer: true });
  // Tracks every currently-open raw `/collab` socket (see C2): Node's own
  // `server.closeAllConnections()` was verified (empirically, against a real upgraded
  // socket) to NOT reach a socket that has gone through an 'upgrade' event - it stays
  // reported as an open connection indefinitely, which is exactly what makes Fastify
  // 5's `app.close()` hang. We own this upgrade wiring ourselves (no
  // `@fastify/websocket`), so we track and close these sockets ourselves too, instead
  // of relying on Hocuspocus's `closeConnections()` (which only closes its *logical*
  // per-document `Connection`, never the underlying socket - see `ShutdownDeps.app`'s
  // doc comment in `shutdown.ts`) or Node's built-in connection tracking.
  const liveSockets = new Set<WebSocket>();

  // C1 hardening: a raw TCP client controls every byte of this callback's inputs before
  // any auth runs (Host header, WS handshake headers, ...). `new URL` inside
  // `toFetchRequest` (a malformed Host, e.g. containing a space) or anything else in this
  // path throwing synchronously must never escape as an uncaughtException - that would
  // crash the whole process for every connected client on one bad unauthenticated
  // request. Every branch below is therefore wrapped; on any failure we log and destroy
  // the socket instead of rethrowing.
  app.server.on("upgrade", (req: IncomingMessage, socket, head) => {
    try {
      const pathname = (req.url ?? "").split("?", 1)[0];
      if (pathname !== "/collab") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        try {
          const request = toFetchRequest(req);
          const connection = hocuspocus.handleConnection(ws, request);
          // The Hocuspocus wire protocol is always binary frames; `ws` delivers
          // message data as a `Buffer` (a `Uint8Array` subclass) by default.
          ws.on("message", (data: Buffer) => {
            connection.handleMessage(new Uint8Array(data));
          });
          liveSockets.add(ws);
          ws.on("close", (code: number, reason: Buffer) => {
            liveSockets.delete(ws);
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
          deps.onCollabSocket?.(ws);
        } catch (err) {
          console.error("Error completing /collab upgrade:", err);
          ws.close();
        }
      });
    } catch (err) {
      console.error("Error handling /collab upgrade:", err);
      socket.destroy();
    }
  });

  return {
    hocuspocus,
    closeCollabSockets: () => {
      for (const ws of liveSockets) ws.terminate();
      liveSockets.clear();
    },
  };
}
