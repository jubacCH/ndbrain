/**
 * The HTTP layer.
 *
 * Thin on purpose: it decodes a request, names the owner, calls into `App`, and
 * maps errors. Every rule about what a user may see lives one layer down, so
 * there is one place to check rather than one per route.
 *
 * The owner of a request is *always* taken from the session, never from anything
 * the client sent. There is no `?user=` and no owner in a path.
 */

import { existsSync } from 'node:fs';

import cookiePlugin from '@fastify/cookie';
import staticPlugin from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import type { App } from '../app.js';
import { SessionService, UserService, type User } from '../auth/users.js';
import type { Config } from '../config.js';
import { toProblem } from './errors.js';
import { LoginThrottle } from './throttle.js';

export const SESSION_COOKIE = 'ndbrain_session';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the authentication hook; absent on public routes. */
    user?: User;
  }
}

export interface ServerDeps {
  app: App;
  users: UserService;
  sessions: SessionService;
  config: Config;
  throttle?: LoginThrottle;
}

/** Routes reachable without a session. Everything else is closed by default. */
const PUBLIC_ROUTES = new Set(['/api/v1/auth/login', '/api/v1/health']);

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { app, users, sessions, config } = deps;
  const throttle = deps.throttle ?? new LoginThrottle();

  const fastify = Fastify({
    logger: { level: config.logLevel },
    routerOptions: {
      // Vault paths may nest arbitrarily and carry spaces and unicode; the
      // default 100-character limit would reject legitimate note paths.
      maxParamLength: 1024,
    },
    bodyLimit: 32 * 1024 * 1024,
    // Behind the reverse proxy, so that rate limiting and logs see the real
    // client address rather than the proxy's.
    trustProxy: true,
  });

  await fastify.register(cookiePlugin);

  fastify.addHook('onSend', async (_request, reply) => {
    // A notes server has no business being framed, sniffed or used as a referrer
    // source for a URL that contains a note name.
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
  });

  /**
   * Authentication gate.
   *
   * Compares against `routerPath`-independent, already-decoded pathnames. v1
   * shipped a hole here: the check ran against the raw URL, so a `%2e%2e` or a
   * percent-encoded route name slipped past the gate and was decoded afterwards.
   * Decoding once, before the comparison, is the fix — and the reason nothing
   * downstream decodes a second time.
   */
  fastify.addHook('onRequest', async (request, reply) => {
    const pathname = decodeOnce(new URL(request.url, 'http://localhost').pathname);

    if (!pathname.startsWith('/api/')) return; // static assets, handled elsewhere
    if (PUBLIC_ROUTES.has(pathname)) return;

    const token = request.cookies[SESSION_COOKIE];
    const session = token === undefined ? null : sessions.resolve(token);
    if (session === null) {
      await reply.code(401).send({ code: 'unauthenticated', message: 'sign in first' });
      return reply;
    }

    const user = users.get(session.userId);
    if (user === undefined || user.disabled) {
      sessions.destroy(token ?? '');
      await reply.code(401).send({ code: 'unauthenticated', message: 'sign in first' });
      return reply;
    }

    request.user = user;
    return;
  });

  fastify.setErrorHandler((error, request, reply) => {
    const problem = toProblem(error);
    if (problem.status === 500) {
      request.log.error({ err: error }, 'unhandled error');
    }
    void reply.code(problem.status).send({ code: problem.code, message: problem.message });
  });

  // ---- the web UI ---------------------------------------------------------
  //
  // Served by the same origin as the API, which is why there is no CORS
  // configuration and no base URL to set: the cookie simply travels with the
  // request. `webRoot` is absent in tests and during API-only development.
  const serveWeb = config.webRoot !== undefined && existsSync(config.webRoot);
  if (serveWeb && config.webRoot !== undefined) {
    await fastify.register(staticPlugin, { root: config.webRoot, wildcard: false });
  }

  fastify.setNotFoundHandler((request, reply) => {
    const pathname = decodeOnce(new URL(request.url, 'http://localhost').pathname);

    // An unknown API route is an error. An unknown *page* is the single-page app
    // being deep-linked, so it gets index.html and sorts the route out itself.
    if (!pathname.startsWith('/api/') && serveWeb && request.method === 'GET') {
      return reply.sendFile('index.html');
    }

    return reply.code(404).send({ code: 'not_found', message: 'no such endpoint' });
  });

  // ---- health -------------------------------------------------------------
  fastify.get('/api/v1/health', async () => ({ status: 'ok' }));

  // ---- authentication -----------------------------------------------------
  fastify.post('/api/v1/auth/login', async (request, reply) => {
    const body = (request.body ?? {}) as { user?: unknown; password?: unknown };
    const id = typeof body.user === 'string' ? body.user : '';
    const password = typeof body.password === 'string' ? body.password : '';

    const key = `${request.ip}|${id}`;
    const wait = throttle.retryAfter(key);
    if (wait > 0) {
      return reply
        .code(429)
        .header('Retry-After', String(wait))
        .send({ code: 'too_many_attempts', message: 'too many attempts, try again later' });
    }

    const user = await users.authenticate(id, password);
    if (user === null) {
      throttle.recordFailure(key);
      // One message for a wrong name and a wrong password: telling them apart
      // turns the login form into an account-name oracle.
      return reply.code(401).send({ code: 'invalid_credentials', message: 'wrong name or password' });
    }

    throttle.recordSuccess(key);
    const { token, expiresAt } = sessions.create(user.id);

    return reply
      .setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        secure: config.cookieSecure,
        sameSite: config.cookieSameSite,
        path: '/',
        expires: new Date(expiresAt),
      })
      .send({ user: publicUser(user) });
  });

  fastify.post('/api/v1/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token !== undefined) sessions.destroy(token);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ ok: true });
  });

  fastify.get('/api/v1/auth/me', async (request) => ({ user: publicUser(requireUser(request)) }));

  // ---- notes --------------------------------------------------------------
  fastify.get('/api/v1/tree', async (request) => {
    const owner = requireUser(request).id;
    return app.tree(owner);
  });

  fastify.get('/api/v1/notes/*', async (request) => {
    const owner = requireUser(request).id;
    return { note: await app.notes.getNote(owner, notePathOf(request)) };
  });

  fastify.put('/api/v1/notes/*', async (request, reply) => {
    const owner = requireUser(request).id;
    const notePath = notePathOf(request);
    const body = (request.body ?? {}) as { content?: unknown };
    const content = typeof body.content === 'string' ? body.content : '';

    const { note, created } = await app.putNote(owner, notePath, content);
    return reply.code(created ? 201 : 200).send({ note });
  });

  fastify.delete('/api/v1/notes/*', async (request, reply) => {
    const owner = requireUser(request).id;
    await app.deleteNote(owner, notePathOf(request));
    return reply.code(204).send();
  });

  fastify.post('/api/v1/rename', async (request) => {
    const owner = requireUser(request).id;
    const body = (request.body ?? {}) as { from?: unknown; to?: unknown };
    const from = typeof body.from === 'string' ? body.from : '';
    const to = typeof body.to === 'string' ? body.to : '';

    return app.renameNote(owner, from, to);
  });

  // ---- librarian ----------------------------------------------------------
  fastify.get('/api/v1/search', async (request) => {
    const owner = requireUser(request).id;
    const query = (request.query ?? {}) as { q?: unknown; limit?: unknown };
    const q = typeof query.q === 'string' ? query.q : '';
    const limit = clamp(Number(query.limit) || 30, 1, 200);

    return { hits: app.queries.search(owner, q, limit) };
  });

  fastify.get('/api/v1/backlinks/*', async (request) => {
    const owner = requireUser(request).id;
    const notePath = notePathOf(request);
    return {
      backlinks: app.queries.backlinks(owner, notePath),
      outgoing: app.queries.outgoingLinks(owner, notePath),
    };
  });

  fastify.get('/api/v1/overview', async (request) => {
    const owner = requireUser(request).id;
    return {
      counts: {
        notes: app.queries.countNotes(owner),
        orphans: app.queries.orphans(owner).length,
        untagged: app.queries.untagged(owner).length,
        deadLinks: app.queries.deadLinks(owner).length,
        stale: app.queries.stale(owner).length,
      },
      recent: app.queries.recentNotes(owner, 12),
      tasks: app.queries.openTasks(owner).slice(0, 50),
      tags: app.queries.tagCounts(owner).slice(0, 30),
    };
  });

  fastify.get('/api/v1/tidy', async (request) => {
    const owner = requireUser(request).id;
    return {
      orphans: app.queries.orphans(owner),
      untagged: app.queries.untagged(owner),
      deadLinks: app.queries.deadLinks(owner),
      stale: app.queries.stale(owner),
    };
  });

  return fastify;
}

function publicUser(user: User): Pick<User, 'id' | 'displayName' | 'role'> {
  return { id: user.id, displayName: user.displayName, role: user.role };
}

function requireUser(request: FastifyRequest): User {
  // The hook guarantees this; the check exists so a future public route cannot
  // silently start returning another user's data.
  if (request.user === undefined) {
    throw Object.assign(new Error('unauthenticated'), { statusCode: 401 });
  }
  return request.user;
}

/**
 * The note path from a wildcard route.
 *
 * Fastify has already decoded the parameter once. It is *not* decoded again:
 * decoding twice is what turns `%252e%252e` into real traversal, and the vault
 * layer is entitled to assume it receives a literal path.
 */
function notePathOf(request: FastifyRequest): string {
  const params = request.params as Record<string, string | undefined>;
  return params['*'] ?? '';
}

/** Decodes once, tolerating malformed sequences rather than throwing on them. */
function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function replyProblem(reply: FastifyReply, error: unknown): FastifyReply {
  const problem = toProblem(error);
  return reply.code(problem.status).send({ code: problem.code, message: problem.message });
}
