/**
 * The HTTP layer.
 *
 * Thin on purpose: it decodes a request, names the caller, calls into `App`, and
 * maps errors. Every rule about what a user may see lives one layer down, so
 * there is one place to check rather than one per route.
 *
 * The **caller** is *always* taken from the session, never from anything the
 * client sent. Since sharing arrived a request may also name an **owner** — the
 * vault the note lives in — and that one does come from the client, which is
 * exactly why it may not be used raw.
 *
 * So every route that addresses a note goes through `target()`, and there is no
 * other way for a route to obtain an owner and a path. That is structural rather
 * than a rule to remember: a route that skipped the permission check would have
 * nothing to operate on.
 */

import { existsSync } from 'node:fs';

import cookiePlugin from '@fastify/cookie';
import staticPlugin from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import type { App, BulkResult } from '../app.js';
import type { ApiKeyService } from '../auth/keys.js';
import { InvalidShareError, type Need, type ShareService } from '../auth/shares.js';
import { SessionService, UserService, type User } from '../auth/users.js';
import { registerMcpEndpoint } from '../mcp/endpoint.js';
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
  keys: ApiKeyService;
  shares: ShareService;
  config: Config;
  throttle?: LoginThrottle;
}

/** Routes reachable without a session. Everything else is closed by default. */
const PUBLIC_ROUTES = new Set(['/api/v1/auth/login', '/api/v1/health']);

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { app, users, sessions, keys, shares, config } = deps;
  const throttle = deps.throttle ?? new LoginThrottle();

  /**
   * Resolves what a request is addressing, and whether the caller may.
   *
   * The only way a route gets an owner and a path. `owner` comes from the query
   * string or the body and defaults to the caller, so every existing single-user
   * request keeps its exact meaning; naming somebody else's vault is checked
   * against the shares table, and a refusal is indistinguishable from a missing
   * note.
   */
  function target(request: FastifyRequest, need: Need): { owner: string; path: string } {
    const caller = requireUser(request).id;
    const path = notePathOf(request);
    const owner = ownerOf(request, caller);

    shares.check(caller, owner, path, need);
    return { owner, path };
  }

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

    if (!pathname.startsWith('/api/')) return; // static assets and /mcp
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

  // ---- MCP ----------------------------------------------------------------
  //
  // Sits outside /api/ and outside the session gate on purpose: it authenticates
  // with its own bearer key, not with a browser cookie. Keeping it off the
  // cookie path also means a malicious page cannot reach it with the user's
  // ambient credentials.
  registerMcpEndpoint(fastify, { app, keys });

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
    return app.tree(shares.view(requireUser(request).id));
  });

  fastify.get('/api/v1/notes/*', async (request) => {
    const { owner, path } = target(request, 'read');
    const caller = requireUser(request).id;

    return {
      note: await app.notes.getNote(owner, path),
      // Told to the client so the editor can say whose note this is and go
      // read-only, rather than letting somebody type into a note they cannot save.
      owner,
      canWrite: shares.allows(caller, owner, path, 'write'),
    };
  });

  fastify.put('/api/v1/notes/*', async (request, reply) => {
    const { owner, path } = target(request, 'write');
    const caller = requireUser(request).id;
    const body = (request.body ?? {}) as { content?: unknown; baseMtimeMs?: unknown };
    const content = typeof body.content === 'string' ? body.content : '';

    // Optional and only meaningful for a shared note: see App.putNote.
    const base = Number(body.baseMtimeMs);
    const options = Number.isFinite(base) && base > 0 ? { baseMtimeMs: base } : {};

    const result = await app.putNote(owner, path, content, caller, options);
    return reply.code(result.created ? 201 : 200).send(result);
  });

  fastify.delete('/api/v1/notes/*', async (request, reply) => {
    const { owner, path } = target(request, 'write');
    await app.deleteNote(owner, path, requireUser(request).id);
    return reply.code(204).send();
  });

  fastify.post('/api/v1/rename', async (request) => {
    const caller = requireUser(request).id;
    const body = (request.body ?? {}) as { from?: unknown; to?: unknown; owner?: unknown };
    const from = typeof body.from === 'string' ? body.from : '';
    const to = typeof body.to === 'string' ? body.to : '';
    const owner = typeof body.owner === 'string' && body.owner !== '' ? body.owner : caller;

    // Both ends: moving a note *out* of a shared folder would otherwise let a
    // grantee walk it into a part of the vault they were never given.
    shares.check(caller, owner, from, 'write');
    shares.check(caller, owner, to, 'write');

    return app.renameNote(owner, from, to, caller);
  });

  // ---- folders ------------------------------------------------------------
  //
  // Own vault only, and deliberately so. A folder operation moves everything
  // under it, and the write-shared region a guest holds is a *part* of a vault:
  // renaming a folder that straddles its edge would either move notes the guest
  // may not touch or silently move only half of them. Neither is a good answer,
  // so the question is not asked.
  fastify.post('/api/v1/folders', async (request, reply) => {
    const owner = requireUser(request).id;
    const body = (request.body ?? {}) as { path?: unknown };
    const dir = typeof body.path === 'string' ? body.path : '';

    if (dir.trim() === '') {
      return reply.code(400).send({ code: 'no_path', message: 'name the folder' });
    }
    return reply.code(201).send({ folder: await app.createFolder(owner, dir) });
  });

  fastify.post('/api/v1/folders/rename', async (request) => {
    const owner = requireUser(request).id;
    const body = (request.body ?? {}) as { from?: unknown; to?: unknown };
    const from = typeof body.from === 'string' ? body.from : '';
    const to = typeof body.to === 'string' ? body.to : '';

    return app.renameFolder(owner, from, to, owner);
  });

  fastify.delete('/api/v1/folders/*', async (request, reply) => {
    const owner = requireUser(request).id;
    await app.deleteFolder(owner, notePathOf(request));
    return reply.code(204).send();
  });

  // ---- librarian ----------------------------------------------------------
  fastify.get('/api/v1/search', async (request) => {
    const view = shares.view(requireUser(request).id);
    const query = (request.query ?? {}) as Record<string, unknown>;

    const q = typeof query['q'] === 'string' ? query['q'] : '';
    const propKey = typeof query['prop'] === 'string' ? query['prop'] : '';
    const propValue = typeof query['propValue'] === 'string' ? query['propValue'] : '';
    const options: Parameters<typeof app.queries.search>[2] = {
      limit: clamp(Number(query['limit']) || 40, 1, 200),
    };

    if (typeof query['tag'] === 'string' && query['tag'] !== '') options.tag = query['tag'];
    if (typeof query['dir'] === 'string' && query['dir'] !== '') options.dir = query['dir'];

    // `days=7` rather than a timestamp: the client asks a question in the terms
    // a person uses, and the server owns what "now" means.
    const days = Number(query['days']);
    if (Number.isFinite(days) && days > 0) {
      options.sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
    }

    // `?prop=status` asks which notes declare a status at all; adding
    // `?propValue=aktiv` narrows it to one.
    if (propKey !== '') {
      options.prop = propValue === '' ? { key: propKey } : { key: propKey, value: propValue };
    }

    return { hits: app.queries.search(view, q, options) };
  });

  fastify.get('/api/v1/quickfind', async (request) => {
    const view = shares.view(requireUser(request).id);
    const query = (request.query ?? {}) as { q?: unknown };
    const q = typeof query.q === 'string' ? query.q : '';

    return { notes: app.queries.quickFind(view, q, 12) };
  });

  /**
   * The whole vault as one line per note — no bodies.
   *
   * Cheap enough to ask for before deciding what to read, which is the point:
   * it is the overview a person gets from the tree in a second and a client
   * previously had no way to obtain at all.
   */
  fastify.get('/api/v1/map', async (request) => {
    const view = shares.view(requireUser(request).id);
    const query = (request.query ?? {}) as { limit?: unknown };
    const limit = Number(query.limit);

    return {
      notes: app.queries.vaultMap(view, Number.isFinite(limit) && limit > 0 ? limit : 5000),
      props: app.queries.propKeys(view),
    };
  });

  fastify.get('/api/v1/props/*', async (request) => {
    const view = shares.view(requireUser(request).id);
    return { values: app.queries.propValues(view, notePathOf(request)) };
  });

  /**
   * What is happening in the vault right now.
   *
   * Polled, not streamed. A persistent connection would mean reconnect logic,
   * proxy timeouts and a second lifecycle to reason about, and this is a tool
   * with one person and the occasional agent — asking every couple of seconds
   * costs a query against two indexed tables and survives every restart and
   * every proxy without special handling.
   *
   * `now` comes back with the events so the client can ask for exactly what it
   * has not seen yet, without trusting its own clock.
   */
  fastify.get('/api/v1/graph', async (request) => {
    return app.queries.graph(shares.view(requireUser(request).id));
  });

  fastify.get('/api/v1/pulse', async (request) => {
    const owner = requireUser(request).id;
    const query = (request.query ?? {}) as { since?: unknown; limit?: unknown };

    const since = Number(query.since);
    const now = Date.now();
    // A client without a starting point gets the last five minutes rather than
    // the whole history — enough to fill the view on load, never a full dump.
    const from = Number.isFinite(since) && since > 0 ? since : now - 5 * 60 * 1000;

    return {
      now,
      events: app.queries.pulse(owner, from, clamp(Number(query.limit) || 200, 1, 500)),
    };
  });

  fastify.get('/api/v1/tags', async (request) => {
    return { tags: app.queries.tagCounts(shares.view(requireUser(request).id)) };
  });

  fastify.get('/api/v1/backlinks/*', async (request) => {
    const { owner, path } = target(request, 'read');
    const view = shares.view(requireUser(request).id);

    return {
      backlinks: app.queries.backlinks(view, owner, path),
      outgoing: app.queries.outgoingLinks(view, owner, path),
    };
  });

  fastify.get('/api/v1/overview', async (request) => {
    const caller = requireUser(request).id;
    const view = shares.view(caller);
    const query = (request.query ?? {}) as { days?: unknown };
    const days = Number(query.days);
    const since = Date.now() - (Number.isFinite(days) && days > 0 ? days : 1) * 24 * 60 * 60 * 1000;

    return {
      counts: {
        // What you can see spans the shares; what is *yours to tidy* does not.
        // The findings deliberately match the tidy view, which is own-vault
        // only: counting a stranger's untagged notes here produced a headline
        // number ("2 brauchen Aufmerksamkeit") whose list was empty when it was
        // clicked, because there was nothing there for this person to do.
        notes: app.queries.countNotes(view),
        orphans: app.queries.orphans(caller).length,
        untagged: app.queries.untagged(caller).length,
        deadLinks: app.queries.deadLinks(caller).length,
        stale: app.queries.stale(caller).length,
        // Notes, not findings — the four above overlap heavily. See attentionCount.
        attention: app.queries.attentionCount(caller),
        tagsInUse: app.queries.tagsInUse(caller),
      },
      recent: app.queries.recentNotes(view, 12),
      tasks: app.queries.openTasks(view).slice(0, 50),
      tags: app.queries.tagCounts(view).slice(0, 30),
      activity: app.queries.activity(view, since, 20),
    };
  });

  // ---- bulk tidy-up -------------------------------------------------------
  //
  // The differentiator. Each returns per-note results rather than failing
  // wholesale — see App.#overSelection for why that is not a transaction.
  fastify.post('/api/v1/bulk', async (request, reply) => {
    const caller = requireUser(request).id;
    const body = (request.body ?? {}) as Record<string, unknown>;
    // One vault per request. A selection spanning two vaults would have to report
    // two different reasons for the same-looking failure, and "move these into
    // Archiv" has no meaning across a boundary.
    const owner = typeof body['owner'] === 'string' && body['owner'] !== '' ? body['owner'] : caller;

    const paths = Array.isArray(body['paths'])
      ? body['paths'].filter((value): value is string => typeof value === 'string')
      : [];
    const action = typeof body['action'] === 'string' ? body['action'] : '';

    if (paths.length === 0) {
      return reply.code(400).send({ code: 'no_selection', message: 'nothing selected' });
    }
    // A cap, so one request cannot occupy the process for minutes. Announced
    // rather than silently truncating the selection.
    if (paths.length > 500) {
      return reply
        .code(400)
        .send({ code: 'selection_too_large', message: 'at most 500 notes at a time' });
    }

    // Trimmed before the emptiness check: a tag of spaces would otherwise pass
    // here, be ignored downstream, and report success for a no-op.
    const tag = typeof body['tag'] === 'string' ? body['tag'].trim().replace(/^#/, '').trim() : '';
    const dir = typeof body['dir'] === 'string' ? body['dir'] : '';

    // Checked per note rather than once for the selection: a write-shared folder
    // is a region, not a vault, and a selection may reach past its edge. Failing
    // the whole request would also tell the caller which single path was the
    // problem, so each one is left to fail on its own in the per-note result.
    const allowed = paths.filter((path) => shares.allows(caller, owner, path, 'write'));
    const refused = paths
      .filter((path) => !allowed.includes(path))
      .map((path) => ({ path, reason: 'note does not exist' }));

    const merge = async (run: Promise<BulkResult>): Promise<BulkResult> => {
      const result = await run;
      return { ok: result.ok, failed: [...result.failed, ...refused] };
    };

    switch (action) {
      case 'move':
        // The destination too — otherwise a grantee could walk notes out of the
        // shared folder into the rest of the vault.
        if (!shares.allows(caller, owner, `${dir}/x.md`.replace(/^\/+/, ''), 'write')) {
          return reply.code(404).send({ code: 'not_found', message: 'no such note' });
        }
        return merge(app.bulkMove(owner, allowed, dir, caller));
      case 'tag':
        if (tag === '') {
          return reply.code(400).send({ code: 'no_tag', message: 'no tag given' });
        }
        return merge(app.bulkTag(owner, allowed, tag, caller));
      case 'untag':
        if (tag === '') {
          return reply.code(400).send({ code: 'no_tag', message: 'no tag given' });
        }
        return merge(app.bulkUntag(owner, allowed, tag, caller));
      case 'delete':
        return merge(app.bulkDelete(owner, allowed, caller));
      default:
        return reply.code(400).send({ code: 'unknown_action', message: 'unknown bulk action' });
    }
  });

  /**
   * The tidy-up view is the caller's own vault only.
   *
   * Not a permission limit — the search and overview views do span shares. It is
   * a product judgement: "orphaned", "untagged" and "stale" are verdicts on how
   * somebody keeps their notes, and offering a stranger a checkbox list to bulk
   * delete another person's notes by that verdict is the wrong default.
   */
  fastify.get('/api/v1/tidy', async (request) => {
    const owner = requireUser(request).id;
    return {
      orphans: app.queries.orphans(owner),
      untagged: app.queries.untagged(owner),
      deadLinks: app.queries.deadLinks(owner),
      stale: app.queries.stale(owner),
    };
  });

  // ---- shares -------------------------------------------------------------
  fastify.get('/api/v1/shares', async (request) => {
    const caller = requireUser(request).id;
    return { granted: shares.byOwner(caller), received: shares.toGrantee(caller) };
  });

  fastify.post('/api/v1/shares', async (request, reply) => {
    const caller = requireUser(request).id;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const grantee = typeof body['grantee'] === 'string' ? body['grantee'].trim() : '';
    const prefix = typeof body['prefix'] === 'string' ? body['prefix'] : '';

    if (grantee === '') {
      return reply.code(400).send({ code: 'no_grantee', message: 'name somebody to share with' });
    }
    if (users.get(grantee) === undefined) {
      // Named accounts only, and the caller already knows who they typed, so
      // there is no oracle here to protect.
      return reply.code(404).send({ code: 'no_such_user', message: 'no such account' });
    }

    try {
      // Only ever grants access to the caller's *own* vault: a share the caller
      // holds is not theirs to pass on.
      return { share: shares.grant(caller, prefix, grantee, body['canWrite'] === true) };
    } catch (error) {
      if (error instanceof InvalidShareError) {
        return reply.code(400).send({ code: 'invalid_share', message: error.message });
      }
      throw error;
    }
  });

  fastify.delete('/api/v1/shares/:id', async (request, reply) => {
    const caller = requireUser(request).id;
    const { id } = request.params as { id: string };
    const share = shares.get(id);

    // Either side may end it: the owner withdraws, the grantee declines. Anybody
    // else is told it does not exist.
    if (share === undefined || (share.owner !== caller && share.grantee !== caller)) {
      return reply.code(404).send({ code: 'not_found', message: 'no such share' });
    }

    shares.revoke(id);
    return reply.code(204).send();
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

/**
 * The vault a request is aimed at, defaulting to the caller's own.
 *
 * Taken from the query string or the body — never from the path, where it would
 * be indistinguishable from a folder called `ramona`. The value is untrusted and
 * is only ever handed to `shares.check`, which decides whether it means anything.
 */
function ownerOf(request: FastifyRequest, caller: string): string {
  const fromQuery = (request.query ?? {}) as { owner?: unknown };
  if (typeof fromQuery.owner === 'string' && fromQuery.owner !== '') return fromQuery.owner;

  const fromBody = (request.body ?? {}) as { owner?: unknown };
  if (typeof fromBody.owner === 'string' && fromBody.owner !== '') return fromBody.owner;

  return caller;
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
