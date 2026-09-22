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
import { InvalidShareError, type Need, type Share, type ShareService } from '../auth/shares.js';
import type { SettingsService } from '../auth/settings.js';
import type { History, Version } from '../vault/history.js';
import { DeletedNotes } from '../notes/deleted.js';
import { SessionService, UnknownUserError, UserService, type User } from '../auth/users.js';
import { registerMcpEndpoint } from '../mcp/endpoint.js';
import type { Config } from '../config.js';
import type { Database } from '../db/database.js';
import type { ReconcileState } from '../index/watcher.js';
import { missingNotes } from '../index/queries.js';
import { HealthProbe } from './health.js';
import { toProblem } from './errors.js';
import { NoteNotFoundError } from '../errors.js';
import { isNotePath, normalizeVaultPath } from '../vault/paths.js';
import { LoginThrottle } from './throttle.js';
import { ZipFile } from 'yazl';
import type { ZodType } from 'zod';
import * as S from '../../../shared/schema.js';

export const SESSION_COOKIE = 'ndbrain_session';

/**
 * The bytes of an upload, or `null` if this body cannot faithfully become bytes.
 *
 * A Buffer is the normal path. A string can still arrive from a parser this
 * server did not register, and encoding it back as UTF-8 is exact. A parsed
 * object cannot be turned back into the bytes that produced it — key order and
 * whitespace are already gone — so it is refused rather than silently written as
 * something subtly different from what was uploaded.
 */
function uploadBytes(body: unknown): Buffer | null {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body === undefined || body === null) return Buffer.alloc(0);
  return null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the authentication hook; absent on public routes. */
    user?: User;
  }
}

export interface ServerDeps {
  app: App;
  /** For the health check's cheap read; no route touches it directly. */
  db: Database;
  users: UserService;
  sessions: SessionService;
  keys: ApiKeyService;
  shares: ShareService;
  settings: SettingsService;
  history: History;
  config: Config;
  throttle?: LoginThrottle;
  /**
   * Where the log goes. Left out, it goes where Fastify sends it.
   *
   * Only a test passes one, and only because some of what this server says is
   * said to nobody else: a refused login writes a warning and answers with a
   * deliberately empty "later", so the line in the log is the whole of the
   * evidence. A test that cannot read it cannot check it exists.
   */
  logStream?: NodeJS.WritableStream;
  /** The watcher, so the health check can ask when it last reconciled. */
  watcher?: { reconcileState(now?: number): ReconcileState };
}

/** Routes reachable without a session. Everything else is closed by default. */
const PUBLIC_ROUTES = new Set(['/api/v1/auth/login', '/api/v1/health']);

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { app, users, sessions, keys, shares, settings, history, config } = deps;
  const throttle = deps.throttle ?? new LoginThrottle();
  const deleted = new DeletedNotes(app, shares, history);

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

  /**
   * The check `target` just made, packaged to be made again inside the note's
   * lock — after `confirm` has had its say about the file on that path.
   *
   * Between the route's decision and the write, `confirm` may withdraw the very
   * note share the route said yes to: a file replaced behind ndBrain's back is
   * recognised only under the lock, and until the watcher reports it (250 ms at
   * best, five minutes when the event was lost) the share still stands out
   * here. See `Authorized` in `notes/service.ts` for what rides on this.
   */
  function recheck(caller: string, owner: string, path: string, need: Need): () => void {
    return () => shares.check(caller, owner, path, need);
  }

  /**
   * `target` for a read of a note's content, by somebody else than its owner.
   *
   * A note share names one file. If that file was replaced behind ndBrain's
   * back and the watcher has not said so yet, the share is withdrawn here,
   * before the check — so the grantee is never shown the replacement, not even
   * in the moment before the watcher catches up.
   *
   * Only for a caller who holds a note share on exactly this path. Done for
   * every signed-in caller it was a clock anybody could read: a shared path
   * cost a lock, a `stat` and a hash of the file, an unshared one a single
   * query, and the difference told a stranger which of the owner's paths are
   * shared with somebody. For the grantee herself the confirmation costs what
   * it costs and reveals only what she already holds.
   */
  async function readTarget(request: FastifyRequest): Promise<{ owner: string; path: string }> {
    const caller = requireUser(request).id;
    const path = notePathOf(request);
    const owner = ownerOf(request, caller);
    if (owner !== caller) {
      let canonical: string | null = null;
      try {
        canonical = normalizeVaultPath(path);
      } catch {
        // A malformed path is `target`'s to refuse, with its usual answer.
      }
      if (canonical !== null && isNotePath(canonical) && shares.hasNoteShare(caller, owner, canonical)) {
        await app.noteChanged(owner, canonical);
      }
    }
    return target(request, 'read');
  }

  const fastify = Fastify({
    logger: deps.logStream === undefined
      ? { level: config.logLevel }
      : { level: 'warn', stream: deps.logStream },
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

  /**
   * Raw bytes for file uploads.
   *
   * Fastify ships parsers for `application/json` *and* `text/plain`. The second
   * one is the trap: it hands the route a decoded string, so an upload arrived
   * as `Buffer.isBuffer(body) === false` and was written as zero bytes. That is
   * exactly the common case — importing `.md` and `.txt`, for which a browser
   * sets a text content type — so every text file imported through the browser
   * would have been silently emptied.
   *
   * Removing it lets text fall through to the wildcard below and arrive as
   * bytes. JSON keeps its parser, because the rest of the API is JSON; an upload
   * announcing that type is refused in the route rather than being re-serialised
   * into something that is no longer the file the caller sent.
   */
  fastify.removeContentTypeParser('text/plain');
  fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, payload, done) => {
    done(null, payload);
  });

  fastify.addHook('onSend', async (request, reply) => {
    // A notes server has no business being framed, sniffed or used as a referrer
    // source for a URL that contains a note name.
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');

    // Nothing behind the session gate may be cached. Two reasons, and the second
    // is the one that bit: vault contents are private, and they are mutable —
    // replacing a file and downloading it handed back the *previous* bytes from
    // the browser cache, because a 200 with no cache directives is fair game for
    // heuristic caching. Static assets keep their own caching; this is /api only.
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store, private');
    }
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
    // A space never signs in, so a session naming one cannot be real. Refused
    // here as well as at login: `/auth/me` and every route after it must never
    // run as a space, however such a row came to exist.
    if (user === undefined || user.disabled || user.kind !== 'person') {
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
    // The type is set explicitly because of the one route that answers with
    // something else: a failure while the export stream is being built reaches
    // this handler with `application/zip` already on the reply, and serialising
    // a problem object under that type throws inside Fastify — where nothing
    // can catch it, so the process goes down instead of the request.
    void reply
      .code(problem.status)
      .type('application/json; charset=utf-8')
      .send({ code: problem.code, message: problem.message });
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

  /**
   * A request body, checked against its schema.
   *
   * Replaces the hand-written `typeof body.x === 'string' ? body.x : ''` dance
   * that ran at the top of every mutating route. That pattern silently turned a
   * wrong type into a default, so a client sending `{ paths: "a.md" }` instead of
   * an array got "nothing selected" rather than being told what was wrong with
   * the request — and every new route had to remember to repeat it.
   *
   * Throws `ZodError`, which the error handler renders as a 400 naming the field.
   */
  const body = <T>(request: { body?: unknown }, schema: ZodType<T>): T =>
    schema.parse(request.body ?? {});

  // ---- health -------------------------------------------------------------
  //
  // Public, so it says whether the server works and roughly what is wrong, and
  // nothing else; see `health.ts` for the whole of what it may reveal. Sent as
  // formatted JSON because the first reader is usually a person who opened the
  // URL in a browser after something went quiet.
  const probe = new HealthProbe({
    db: deps.db,
    users,
    history,
    config,
    ...(deps.watcher === undefined ? {} : { watcher: deps.watcher }),
  });

  fastify.get('/api/v1/health', async (_request, reply) => {
    const report = await probe.check();
    return reply
      .code(report.status === 'failing' ? 503 : 200)
      .type('application/json')
      .send(`${JSON.stringify(report, null, 2)}\n`);
  });

  // ---- MCP ----------------------------------------------------------------
  //
  // Sits outside /api/ and outside the session gate on purpose: it authenticates
  // with its own bearer key, not with a browser cookie. Keeping it off the
  // cookie path also means a malicious page cannot reach it with the user's
  // ambient credentials.
  registerMcpEndpoint(fastify, { app, keys, deleted });

  // ---- authentication -----------------------------------------------------
  fastify.post('/api/v1/auth/login', async (request, reply) => {
    const { user: id, password } = body(request, S.LoginRequest);

    const wait = throttle.retryAfter(request.ip, id);
    if (wait > 0) {
      // Said out loud, because the brake can shut out the very person it
      // protects: the account budget is spent by anybody who knows the name,
      // and the answer comes before the password is checked, so it cannot tell
      // the owner from the guesser. Somebody has to be able to see that this
      // is happening, and the reply itself deliberately says nothing beyond
      // "later". The marker is fixed so an operator can grep for it.
      request.log.warn({ account: id, seconds: wait }, 'login refused: too many attempts');
      return reply
        .code(429)
        .header('Retry-After', String(wait))
        .send({ code: 'too_many_attempts', message: 'too many attempts, try again later' });
    }

    const user = await users.authenticate(id, password);
    if (user === null) {
      throttle.recordFailure(request.ip, id);
      // One message for a wrong name and a wrong password: telling them apart
      // turns the login form into an account-name oracle.
      return reply.code(401).send({ code: 'invalid_credentials', message: 'wrong name or password' });
    }

    throttle.recordSuccess(request.ip, id);
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
    const caller = requireUser(request).id;
    return {
      ...(await app.tree(shares.view(caller))),
      // Who the roots belong to and what to call them: a space is a root of
      // its own, not somebody's vault.
      owners: shares.visibleOwners(caller),
    };
  });

  fastify.get('/api/v1/notes/*', async (request) => {
    const { owner, path } = await readTarget(request);
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
    const { content, baseMtimeMs, ifAbsent } = body(request, S.PutNoteRequest);

    // "Make sure it exists": the one form of this request that may never write
    // over anything, so it does not take a base version and cannot make a copy.
    const authorize = recheck(caller, owner, path, 'write');

    if (ifAbsent === true) {
      const result = await app.createNoteIfAbsent(owner, path, content, caller, { authorize });
      return reply.code(result.created ? 201 : 200).send(result);
    }

    // Optional and only meaningful for a shared note: see App.putNote.
    const options =
      baseMtimeMs !== undefined && baseMtimeMs > 0 ? { baseMtimeMs, authorize } : { authorize };

    const result = await app.putNote(owner, path, content, caller, options);
    // The copy of the displaced version sits beside the note, but a note share
    // covers the note and not its neighbours: its path is named only to
    // somebody who may read it. The copy is made either way.
    if (result.conflictCopy !== undefined && !shares.allows(caller, owner, result.conflictCopy, 'read')) {
      const { conflictCopy: _hidden, ...visible } = result;
      return reply.code(result.created ? 201 : 200).send(visible);
    }
    return reply.code(result.created ? 201 : 200).send(result);
  });

  /**
   * Adds text to a note, creating it when the caller says what it starts with.
   *
   * The route is `append` followed by the path, rather than the note's own
   * route followed by `append`, which is the spelling this wanted to be:
   * find-my-way refuses a wildcard that is not the last character of a route,
   * and a vault path is a wildcard. So the operation takes the shape the other
   * per-path routes here already have — `props`, `backlinks`, `history`, each
   * followed by the path — and `target()` reads the path exactly as it does
   * for them, which is the point: there is no second permission check.
   *
   * It exists because the alternative is a read-modify-write from the browser,
   * and the note being added to is very often the one open in the editor with
   * text that has not been saved yet. See `NoteService.appendNote`.
   */
  fastify.post('/api/v1/append/*', async (request, reply) => {
    const { owner, path } = target(request, 'write');
    const caller = requireUser(request).id;
    const { content, section, ifAbsent } = body(request, S.AppendNoteRequest);

    const result = await app.appendNote(owner, path, content, caller, {
      ...(section === undefined ? {} : { section }),
      ...(ifAbsent === undefined ? {} : { ifAbsent }),
      authorize: recheck(caller, owner, path, 'write'),
    });
    return reply.code(result.created ? 201 : 200).send(result);
  });

  fastify.delete('/api/v1/notes/*', async (request, reply) => {
    const { owner, path } = target(request, 'write');
    const caller = requireUser(request).id;
    await app.deleteNote(owner, path, caller, { authorize: recheck(caller, owner, path, 'write') });
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

    // The caller's view goes along, and only the report is bounded by it. The
    // rewrite itself still covers the whole of the owner's vault — see
    // App.renameNote — because links the grantee cannot see still have to keep
    // working for the person whose notes they are.
    return app.renameNote(owner, from, to, {
      view: shares.view(caller),
      actor: caller,
      // Both ends again in the lock: a note share on the source withdrawn by
      // `confirm` is exactly the one that would otherwise walk a stranger's
      // file into a folder the caller keeps.
      authorizeSource: recheck(caller, owner, from, 'write'),
      authorizeTarget: recheck(caller, owner, to, 'write'),
    });
  });

  // ---- folders ------------------------------------------------------------
  //
  // In the caller's own vault, or in another one — a space, typically — under
  // a share that gives write access to the folder's path. The check is the one
  // notes go through, on the folder path itself: a write share on `Projekt/`
  // covers `Projekt/Neu` and `Projekt/A` → `Projekt/B`, and nothing beside it.
  // A folder operation moves everything below the folder, and everything below
  // a path inside a folder share is inside that share, so a grantee can never
  // move notes she was not given. A note share never covers a folder path.
  //
  // The folder shared itself is not renamed or removed by its grantee: its
  // path is not *inside* the share, and letting it be would move the share's
  // own root out from under the owner.
  //
  // `checkFolder`, not `check`: a note share names one note and never a
  // folder. Asked about a folder path that happens to be spelled like a shared
  // note (`Archiv/x.md`), `check` would say yes — and a folder renamed to that
  // name carries everything below it out of the grantee's region.
  fastify.post('/api/v1/folders', async (request, reply) => {
    const caller = requireUser(request).id;
    const { path: dir, owner: named } = body(request, S.CreateFolderRequest);
    const owner = named ?? caller;

    if (dir.trim() === '') {
      return reply.code(400).send({ code: 'no_path', message: 'name the folder' });
    }
    shares.checkFolder(caller, owner, dir, 'write');
    return reply.code(201).send({ folder: await app.createFolder(owner, dir) });
  });

  fastify.post('/api/v1/folders/rename', async (request) => {
    const caller = requireUser(request).id;
    const { from, to, owner: named } = body(request, S.RenameFolderRequest);
    const owner = named ?? caller;

    // Both ends, as for a note: a folder may not be carried out of the region.
    shares.checkFolder(caller, owner, from, 'write');
    shares.checkFolder(caller, owner, to, 'write');

    // The caller's view bounds what is reported about links, exactly as a
    // note rename does.
    return app.renameFolder(owner, from, to, { view: shares.view(caller), actor: caller });
  });

  fastify.delete('/api/v1/folders/*', async (request, reply) => {
    const caller = requireUser(request).id;
    const dir = notePathOf(request);
    const owner = ownerOf(request, caller);

    shares.checkFolder(caller, owner, dir, 'write');
    await app.deleteFolder(owner, dir);
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

  /**
   * The caller's own activity per day, for the home view's "today" and its
   * two-week trace.
   *
   * `bounds` is a comma-separated list of ascending timestamps — the client's
   * local midnights; n + 1 of them make n days. Own vault only, like the pulse:
   * an `owner` in the query is not read at all, so asking about somebody else
   * answers exactly what asking about nobody does.
   */
  fastify.get('/api/v1/activity/days', async (request, reply) => {
    const owner = requireUser(request).id;
    const query = (request.query ?? {}) as { bounds?: unknown };
    const bounds = parseDayBounds(query.bounds);
    if (bounds === null) {
      return reply.code(400).send({
        code: 'bad_bounds',
        message: `bounds must be 2 to ${MAX_DAY_BOUNDS} ascending timestamps, comma-separated, each day at most ${MAX_DAY_HOURS} hours and all of them at most ${MAX_SPAN_DAYS} days`,
      });
    }
    return { days: app.queries.dailyActivity(owner, bounds) };
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
        // Zero where tagging is not a convention here; see untaggedFindings.
        untagged: app.queries.untaggedFindings(caller).length,
        deadLinks: app.queries.deadLinks(caller).length,
        // The threshold is the caller's, not a number this file picked.
        stale: app.queries.stale(caller, settings.get(caller).staleDays).length,
        conflicts: app.queries.conflictCopies(caller).length,
        // Notes, not findings — the five above overlap heavily. See attentionCount.
        attention: app.queries.attentionCount(caller, settings.get(caller).staleDays),
        tagsInUse: app.queries.tagsInUse(caller),
      },
      recent: app.queries.recentNotes(view, 12),
      tasks: app.queries.openTasks(view).slice(0, 50),
      tags: app.queries.tagCounts(view).slice(0, 30),
      activity: app.queries.activity(view, since, 20),
    };
  });

  /**
   * The full task list behind the overview tile: every `- [ ]` the caller may
   * read, with the folder filter and "include done" toggle the overview's
   * `slice(0, 50)` has no room for.
   */
  fastify.get('/api/v1/tasks', async (request) => {
    const view = shares.view(requireUser(request).id);
    const query = (request.query ?? {}) as Record<string, unknown>;

    const filter: Parameters<typeof app.queries.tasks>[1] = {
      limit: clamp(Number(query['limit']) || 1000, 1, 5000),
    };
    if (typeof query['dir'] === 'string' && query['dir'] !== '') filter.dir = query['dir'];
    if (query['includeDone'] === 'true' || query['includeDone'] === '1') filter.includeDone = true;

    const tasks = app.queries.tasks(view, filter);
    const total = app.queries.taskCount(view, filter);

    return { tasks, total, truncated: total > tasks.length };
  });

  /**
   * Ticks or unticks one task, verified against the line it is expected to
   * still be — see `App.toggleTask` for why. A mismatch answers 409, not a
   * silent no-op or a guess at the right line.
   */
  fastify.post('/api/v1/tasks/toggle', async (request) => {
    const caller = requireUser(request).id;
    const { path, line, expectedText, expectedDone, done } = body(request, S.ToggleTaskRequest);
    const owner = ownerOf(request, caller);

    shares.check(caller, owner, path, 'write');

    return app.toggleTask(owner, path, line, { text: expectedText, done: expectedDone }, done, caller, {
      authorize: recheck(caller, owner, path, 'write'),
    });
  });

  /* ---- files ---------------------------------------------------------------
   *
   * The vault is a folder of files; until now the API only admitted the `.md`
   * ones. Anything else on disk was invisible through the tool that owns the
   * folder, which also made it unremovable.
   *
   * Two rules hold this together, and both are about the same origin serving the
   * bundle:
   *
   *  1. **Nothing from a vault is served as a document.** Every download goes out
   *     as `application/octet-stream` with `Content-Disposition: attachment`,
   *     except a short allowlist of image types shown inline. An uploaded
   *     `.html` served as `text/html` on this origin would be stored XSS with
   *     the session cookie right there — the file browser would become the
   *     account-takeover route.
   *  2. **Permission is checked per path, not per listing.** Every route goes
   *     through `target()` like the note routes, so a share's prefix bounds file
   *     access exactly as it bounds note access.
   */

  fastify.get('/api/v1/files', async (request) => {
    const caller = requireUser(request).id;
    const query = (request.query ?? {}) as { owner?: unknown };
    const owner = typeof query.owner === 'string' && query.owner !== '' ? query.owner : caller;

    // Somebody else's vault — a space, typically — lists exactly what the
    // caller's shares on it cover, by the rule every note query uses: a
    // grantee of `Homelab/` sees the files below it and nothing beside it. No
    // share on that vault reads exactly like a vault that does not exist.
    if (owner !== caller) {
      const listed = await app.listFilesIn(caller, owner);
      if (listed === null) throw new NoteNotFoundError('note does not exist');
      return { ...listed, files: listed.files.map((file) => ({ ...file, owner })) };
    }

    const { files, dirs, truncated } = await app.listFiles(owner);
    return {
      files: files.map((file) => ({ ...file, owner })),
      dirs,
      truncated,
    };
  });

  /** Image types safe to render inline. Everything else downloads. */
  const INLINE_TYPES = new Map([
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'],
    ['.webp', 'image/webp'],
    ['.svg', 'image/svg+xml'],
  ]);

  fastify.get('/api/v1/files/*', async (request, reply) => {
    const { owner, path: filePath } = await readTarget(request);
    const bytes = await app.readFile(owner, filePath);

    const name = filePath.slice(filePath.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    const extension = dot === -1 ? '' : name.slice(dot).toLowerCase();

    // SVG is an image and also a script host. Inline would mean same-origin
    // script execution, so it is the one image type that only ever downloads.
    const inline = extension !== '.svg' ? INLINE_TYPES.get(extension) : undefined;

    return reply
      .header('content-type', inline ?? 'application/octet-stream')
      .header(
        'content-disposition',
        `${inline === undefined ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      )
      // Belt and braces: even if a content type slipped through, nothing here is
      // allowed to run.
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(bytes);
  });

  /**
   * Uploads or replaces one file.
   *
   * The body is the raw bytes rather than multipart. Multipart would mean a
   * parser, a temp-file lifecycle and a size accounting of its own, for the sole
   * benefit of putting several files in one request — and the browser can just
   * as easily send several requests, which also reports failures per file
   * instead of collapsing them into one.
   */
  fastify.post('/api/v1/files/*', async (request, reply) => {
    const { owner, path: filePath } = target(request, 'write');
    const bytes = uploadBytes(request.body);

    if (bytes === null) {
      return reply.code(415).send({
        code: 'unsupported_media_type',
        message:
          'send the file as application/octet-stream — a JSON content type is parsed, ' +
          'and re-serialising it would not give back the bytes you sent',
      });
    }

    const caller = requireUser(request).id;
    const result = await app.writeFile(owner, filePath, bytes, caller, {
      authorize: recheck(caller, owner, filePath, 'write'),
    });
    return reply.code(result.replaced ? 200 : 201).send({ ...result, ok: true });
  });

  fastify.delete('/api/v1/files/*', async (request, reply) => {
    const { owner, path: filePath } = target(request, 'write');
    const caller = requireUser(request).id;
    await app.deleteFile(owner, filePath, caller, {
      authorize: recheck(caller, owner, filePath, 'write'),
    });
    return reply.code(204).send();
  });

  /**
   * The whole vault as one zip.
   *
   * The answer to "can I get my data out", which for a tool holding the only
   * copy of somebody's notes is not a feature but a condition of trusting it.
   * Streamed rather than assembled in memory: a vault is unbounded, and building
   * the archive as a Buffer would make export the thing that runs the container
   * out of memory.
   *
   * Own vault only. Zipping a share would quietly hand somebody a permanent copy
   * of a folder that was lent to them, and revoking the share afterwards would
   * not take it back.
   */
  fastify.get('/api/v1/export', async (request, reply) => {
    const owner = requireUser(request).id;
    const { files } = await app.listFiles(owner, 100_000);

    // Resolved first, then handed over as paths: `addFile` opens a file only
    // when that entry's turn to be written comes and pipes it into the output
    // stream, so the archive costs one file's chunks at a time. `addBuffer`
    // would cost the whole vault, which is what the paragraph above promises
    // it does not.
    const onDisk: { real: string; entry: string; mtimeMs: number }[] = [];
    for (const file of files) {
      onDisk.push({
        real: await app.fileOnDisk(owner, file.path),
        entry: file.path,
        mtimeMs: file.mtimeMs,
      });
    }

    const zip = new ZipFile();
    // A file listed a moment ago can be gone by the time its turn comes, and
    // yazl reports that as an `error` event rather than a rejected promise.
    // Unhandled, an `error` on an EventEmitter takes the process down — and the
    // output stream would never end, so the request would hang instead of
    // failing. Passing it to the stream Fastify is sending is what turns it
    // back into a failed response: a 500 while nothing has been written yet, a
    // cut connection once bytes are on the wire. An archive that quietly omits
    // a file it could not read is the one outcome to avoid; it is not a backup.
    zip.on('error', (error: unknown) => {
      zip.outputStream.emit('error', error instanceof Error ? error : new Error(String(error)));
    });
    for (const file of onDisk) {
      zip.addFile(file.real, file.entry, { mtime: new Date(file.mtimeMs) });
    }
    zip.end();

    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="ndbrain-${owner}-${stamp}.zip"`)
      .send(zip.outputStream);
  });

  /* ---- account and settings ------------------------------------------------
   *
   * Changing a password required shell access on the box until now, which meant
   * in practice that nobody changed one. A credential that cannot be rotated
   * without a sysadmin is a credential that stays put after it leaks.
   */

  fastify.get('/api/v1/settings', async (request) => {
    return { settings: settings.get(requireUser(request).id) };
  });

  fastify.put('/api/v1/settings', async (request) => {
    const patch = body(request, S.SettingsRequest);
    return { settings: settings.set(requireUser(request).id, patch) };
  });

  /**
   * Changes the name the interface calls the caller.
   *
   * No password confirmation, unlike the one below: this changes a label, and
   * asking for a credential to edit a label trains people to type their password
   * at prompts that do not need it.
   */
  fastify.put('/api/v1/account/profile', async (request) => {
    const caller = requireUser(request).id;
    const { displayName } = body(request, S.ProfileRequest);
    return { user: publicUser(users.setDisplayName(caller, displayName)) };
  });

  /**
   * Changes the caller's own password.
   *
   * The current one is required even though the caller is already signed in.
   * A session cookie proves that somebody signed in at some point, not that the
   * person at the keyboard right now is the account holder — an unattended
   * laptop is exactly the case this stops from becoming a permanent takeover.
   *
   * Throttled on the same limiter as login, since this is a second place to
   * guess a password at.
   */
  fastify.post('/api/v1/account/password', async (request, reply) => {
    const user = requireUser(request);
    const { currentPassword, newPassword } = body(request, S.ChangePasswordRequest);

    const wait = throttle.retryAfter(request.ip, user.id);
    if (wait > 0) {
      return reply
        .code(429)
        .header('Retry-After', String(wait))
        .send({ code: 'too_many_attempts', message: 'too many attempts, try again later' });
    }

    const confirmed = await users.authenticate(user.id, currentPassword);
    if (confirmed === null) {
      throttle.recordFailure(request.ip, user.id);
      return reply.code(403).send({ code: 'wrong_password', message: 'the current password is wrong' });
    }
    throttle.recordSuccess(request.ip, user.id);

    await users.setPassword(user.id, newPassword);

    // Every other session is ended, including any an attacker may hold — a
    // password change that leaves old sessions alive changes nothing for the
    // person it was meant to lock out. The session making the change is replaced
    // rather than kept, so the cookie in this browser is one the old password
    // never saw.
    sessions.destroyAllFor(user.id);
    const { token, expiresAt } = sessions.create(user.id);

    return reply
      .setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        secure: config.cookieSecure,
        sameSite: config.cookieSameSite,
        path: '/',
        expires: new Date(expiresAt),
      })
      .send({ ok: true });
  });

  /**
   * Ends every session but this one.
   *
   * The answer to "I signed in on a machine I no longer have". Deliberately
   * keeps the caller signed in: the alternative is a button that logs you out
   * for pressing it, which nobody presses when they need it.
   */
  fastify.post('/api/v1/account/sessions/revoke', async (request, reply) => {
    const user = requireUser(request);
    sessions.destroyAllFor(user.id);
    const { token, expiresAt } = sessions.create(user.id);

    return reply
      .setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        secure: config.cookieSecure,
        sameSite: config.cookieSameSite,
        path: '/',
        expires: new Date(expiresAt),
      })
      .send({ ok: true });
  });

  /* ---- history -------------------------------------------------------------
   *
   * The sidecar repository has been recording every vault every two minutes for
   * weeks, and nothing in the application could see it: a note somebody
   * overwrote was recoverable only by somebody with a shell on the box. These
   * three routes are the whole feature — list, read, put back.
   *
   * Read-only against git. A restore is an ordinary write of old text, so it
   * goes through `putNote` like any other edit: it is indexed, it is logged in
   * `edits`, and the version it replaced is committed by the next tick. Undoing
   * a restore is therefore just another restore, and no history is ever rewritten.
   */

  /**
   * The versions of one note the caller may see.
   *
   * The history belongs to a path. For a caller holding only a note share it
   * starts when that share came to name the path — before then, the versions
   * under this name may be another note's, one deleted or renamed away, and a
   * share on this note is not a key to that one. A version outside the window
   * reads exactly like one that was never there.
   */
  async function visibleVersions(caller: string, owner: string, path: string): Promise<Version[]> {
    const from = shares.pastVisibleFrom(caller, owner, path);
    return (await history.versions(owner, path)).filter((version) => version.at >= from);
  }

  async function visibleContentAt(caller: string, owner: string, path: string, version: string): Promise<string> {
    if (!(await visibleVersions(caller, owner, path)).some((known) => known.id === version)) {
      throw new NoteNotFoundError('no such version of this note');
    }
    return history.contentAt(owner, path, version);
  }

  fastify.get('/api/v1/history/*', async (request) => {
    const { owner, path } = await readTarget(request);
    const caller = requireUser(request).id;
    const query = (request.query ?? {}) as { version?: unknown };

    // One route, two questions: the list, or one version's text.
    if (typeof query.version === 'string' && query.version !== '') {
      return { content: await visibleContentAt(caller, owner, path, query.version) };
    }

    return {
      available: await history.available(owner),
      versions: await visibleVersions(caller, owner, path),
    };
  });

  fastify.post('/api/v1/history/restore', async (request) => {
    const caller = requireUser(request).id;
    const { owner, path, version } = body(request, S.RestoreRequest);

    // The same gate every write goes through; a share that is read-only cannot
    // be rolled back by the person it was lent to.
    shares.check(caller, owner, path, 'write');

    const content = await visibleContentAt(caller, owner, path, version);
    const result = await app.putNote(owner, path, content, caller, {
      authorize: recheck(caller, owner, path, 'write'),
    });
    return { note: result.note, created: result.created };
  });

  /* ---- recently deleted ----------------------------------------------------
   *
   * The way back for a deleted note, which the history above cannot offer: it
   * hangs off an open note. Everything about who may see and restore what is in
   * `DeletedNotes`; these routes only carry the caller in.
   */

  fastify.get('/api/v1/deleted', async (request) => {
    const caller = requireUser(request).id;
    return { notes: await deleted.list(caller) };
  });

  fastify.post('/api/v1/deleted/restore', async (request) => {
    const caller = requireUser(request).id;
    const { owner, path } = body(request, S.RestoreDeletedRequest);
    const result = await deleted.restore(caller, owner, path);
    return { note: result.note, samePath: result.samePath };
  });

  /** Asked before a delete is confirmed, so the question can be honest about the way back. */
  fastify.post('/api/v1/deleted/preview', async (request) => {
    const caller = requireUser(request).id;
    const { owner, paths } = body(request, S.DeletePreviewRequest);
    return deleted.preview(caller, owner, paths);
  });

  /* ---- topics --------------------------------------------------------------
   *
   * Offered, never performed unasked. The vault this was written for has 53
   * notes carrying their metadata as prose and no tags at all, so an entire axis
   * of the tool is dark for want of a translation — but the notes are the
   * person's, and a migration that runs on its own is a tool editing writing it
   * was not asked to edit.
   */

  fastify.get('/api/v1/topics', async (request) => {
    const owner = requireUser(request).id;
    return { proposals: await app.topicProposals(owner) };
  });

  fastify.post('/api/v1/topics/apply', async (request) => {
    const caller = requireUser(request).id;
    const { paths } = body(request, S.ApplyTopicsRequest);
    return { applied: await app.applyTopics(caller, paths, caller) };
  });

  /* ---- administration ------------------------------------------------------
   *
   * Accounts and agent keys, both of which required a shell on the box until
   * now. See the module header in the CLI for what these replace.
   *
   * The guard is applied per route rather than by hiding a menu entry: a
   * navigation item that is not rendered is not a permission, and this is the
   * one place in the application where the difference is worth real money.
   */

  /** Refuses anybody who is not an administrator. */
  function requireAdmin(request: FastifyRequest): User {
    const user = requireUser(request);
    if (user.role !== 'admin') {
      // Deliberately the same answer an unknown route gives. Confirming that an
      // admin surface exists is information a non-admin has no use for.
      throw new NoteNotFoundError('no such endpoint');
    }
    return user;
  }

  fastify.get('/api/v1/admin/users', async (request) => {
    requireAdmin(request);
    return {
      // People only. Spaces have their own list; shown here they would offer a
      // password reset for an account that has no password.
      users: users.list().filter((user) => user.kind === 'person').map((user) => ({
        id: user.id,
        displayName: user.displayName,
        role: user.role,
        disabled: user.disabled,
        createdAt: user.createdAt,
        notes: app.queries.countNotes(user.id),
        keys: keys.list(user.id).filter((key) => !key.revoked).length,
      })),
    };
  });

  fastify.post('/api/v1/admin/users', async (request, reply) => {
    requireAdmin(request);
    const { id, password, displayName, role } = body(request, S.CreateUserRequest);

    const created = await users.create(id, password, {
      ...(displayName === undefined ? {} : { displayName }),
      ...(role === undefined ? {} : { role }),
    });
    return reply.code(201).send({ user: publicUser(created) });
  });

  fastify.post('/api/v1/admin/users/:id/password', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const { password } = body(request, S.AdminPasswordRequest);

    await users.setPassword(id, password);
    // Every session of that account ends: an administrator resetting a password
    // is usually doing it because the old one is not trusted any more, and
    // leaving the existing sessions alive would defeat the point.
    sessions.destroyAllFor(id);
    return { ok: true };
  });

  fastify.post('/api/v1/admin/users/:id/disabled', async (request, reply) => {
    const caller = requireAdmin(request);
    const { id } = request.params as { id: string };
    const { disabled } = body(request, S.DisableUserRequest);

    if (disabled) {
      // Two ways to lock everybody out, both refused. An interface that lets an
      // administrator remove the only way back in has a hole where a
      // confirmation dialog was.
      if (id === caller.id) {
        return reply
          .code(400)
          .send({ code: 'self_disable', message: 'you cannot disable your own account' });
      }
      const admins = users.list().filter((u) => u.role === 'admin' && !u.disabled);
      if (admins.length <= 1 && admins[0]?.id === id) {
        return reply
          .code(400)
          .send({ code: 'last_admin', message: 'this is the only administrator left' });
      }
    }

    users.setDisabled(id, disabled);
    if (disabled) sessions.destroyAllFor(id);
    return { ok: true };
  });

  fastify.get('/api/v1/admin/keys', async (request) => {
    requireAdmin(request);
    const query = (request.query ?? {}) as { owner?: unknown };
    const owner = typeof query.owner === 'string' ? query.owner : requireUser(request).id;

    return { keys: keys.list(owner) };
  });

  /**
   * Creates an agent key.
   *
   * The secret comes back in this response and nowhere else, ever — only its
   * SHA-256 is stored. That is the whole security model of the thing, so the
   * response says so and the interface has to make it impossible to miss.
   */
  fastify.post('/api/v1/admin/keys', async (request, reply) => {
    requireAdmin(request);
    const { owner, name, scope, canWrite } = body(request, S.CreateKeyRequest);

    if (users.get(owner) === undefined) {
      return reply.code(404).send({ code: 'unknown_user', message: 'no such account' });
    }

    const created = keys.create(owner, name, {
      ...(scope === undefined ? {} : { scope }),
      canWrite: canWrite ?? false,
    });
    // Flattened: the service hands back { key, secret }, and the secret belongs
    // beside the key rather than one level up from it.
    return reply.code(201).send({ ...created.key, secret: created.secret });
  });

  fastify.delete('/api/v1/admin/keys/:id', async (request, reply) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    keys.revoke(id);
    return reply.code(204).send();
  });

  /* ---- spaces --------------------------------------------------------------
   *
   * A space is a vault several people share, owned by nobody who signs in. It
   * is an account row of kind `space` with a vault like any other, and its
   * members are ordinary shares with the space as owner — so reading and
   * writing in it go through exactly the checks every other share does. What
   * is special is only who hands out those shares: an administrator, here.
   *
   * Every route answers a non-administrator like an unknown route, and a name
   * that is not a space — a person included — like a space that does not
   * exist.
   */

  /** The space named in the route, or a 404 that says nothing about the name. */
  function requireSpace(request: FastifyRequest): User {
    const { id } = request.params as { id: string };
    const space = users.get(id);
    if (space === undefined || space.kind !== 'space') throw new UnknownUserError('no such space');
    return space;
  }

  function spaceRow(space: User): S.AdminSpace {
    return {
      id: space.id,
      displayName: space.displayName,
      disabled: space.disabled,
      noteCount: app.queries.countNotes(space.id),
      members: shares.byOwner(space.id).length,
    };
  }

  fastify.get('/api/v1/admin/spaces', async (request) => {
    requireAdmin(request);
    return { spaces: users.list().filter((user) => user.kind === 'space').map(spaceRow) };
  });

  fastify.post('/api/v1/admin/spaces', async (request, reply) => {
    requireAdmin(request);
    const { id, displayName } = body(request, S.CreateSpaceRequest);
    const space = await users.createSpace(id, displayName);
    return reply.code(201).send(spaceRow(space));
  });

  fastify.patch('/api/v1/admin/spaces/:id', async (request) => {
    requireAdmin(request);
    const space = requireSpace(request);
    const { displayName, disabled } = body(request, S.UpdateSpaceRequest);

    if (displayName !== undefined) users.setDisplayName(space.id, displayName);
    if (disabled !== undefined) users.setDisabled(space.id, disabled);

    return spaceRow(requireSpace(request));
  });

  fastify.get('/api/v1/admin/spaces/:id/members', async (request) => {
    requireAdmin(request);
    return { members: shares.byOwner(requireSpace(request).id) };
  });

  fastify.post('/api/v1/admin/spaces/:id/members', async (request, reply) => {
    requireAdmin(request);
    const space = requireSpace(request);
    const granted = await grantFromBody(space.id, request, reply);
    if ('share' in granted) return reply.code(201).send(granted.share);
    return granted;
  });

  /**
   * What is in a space, as paths and titles — so an administrator can grant a
   * folder or a note without being a member.
   *
   * No note text, no sizes, no dates: choosing what to share needs the shape
   * of the space, and reading it is what membership is for.
   */
  fastify.get('/api/v1/admin/spaces/:id/tree', async (request) => {
    requireAdmin(request);
    const space = requireSpace(request);
    const tree = await app.tree(space.id);
    return {
      dirs: tree.dirs.map((dir) => dir.path),
      notes: tree.notes
        .map((note) => ({ path: note.path, title: note.title }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
  });

  fastify.delete('/api/v1/admin/spaces/:id/members/:shareId', async (request, reply) => {
    requireAdmin(request);
    const space = requireSpace(request);
    const { shareId } = request.params as { shareId: string };
    const share = shares.get(shareId);

    // A share of some other vault is not this space's member, whoever asks.
    if (share === undefined || share.owner !== space.id) {
      return reply.code(404).send({ code: 'not_found', message: 'no such share' });
    }
    shares.revoke(shareId);
    return reply.code(204).send();
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

    const inLock = (path: string): void => shares.check(caller, owner, path, 'write');

    const merge = async (run: Promise<BulkResult>): Promise<BulkResult> => {
      const result = await run;
      return { ok: result.ok, failed: [...result.failed, ...refused] };
    };

    switch (action) {
      case 'move':
        // The destination is checked per note, on the path each one would get
        // (`App.bulkMove`) — otherwise a grantee could walk notes out of the
        // shared folder into the rest of the vault. The caller's view, not the
        // owner's: this route takes an `owner` from the body, so a bulk move is
        // routinely made by somebody else, and a rename reports which notes its
        // links were rewritten in.
        return merge(app.bulkMove(owner, allowed, dir, { view: shares.view(caller), actor: caller, caller }));
      // The other three take the same check as a function of the path: each
      // note is authorized again inside its own lock, after `confirm`.
      case 'tag':
        if (tag === '') {
          return reply.code(400).send({ code: 'no_tag', message: 'no tag given' });
        }
        return merge(app.bulkTag(owner, allowed, tag, caller, inLock));
      case 'untag':
        if (tag === '') {
          return reply.code(400).send({ code: 'no_tag', message: 'no tag given' });
        }
        return merge(app.bulkUntag(owner, allowed, tag, caller, inLock));
      case 'delete':
        return merge(app.bulkDelete(owner, allowed, caller, inLock));
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
  /**
   * The findings, bounded and honest about it.
   *
   * Each list is capped and the response says whether anything was left out. A
   * silent cap is the worse failure here: this view exists to be worked through,
   * and a table that quietly stops at 500 reads as "that was all of them" — so
   * the tidying looks finished when it is not.
   *
   * The tree, by contrast, is deliberately *not* capped. It is the navigation,
   * and a tree that omits notes is worse than a large response.
   */
  fastify.get('/api/v1/tidy', async (request) => {
    const owner = requireUser(request).id;
    const query = (request.query ?? {}) as { limit?: unknown };
    const limit = clamp(Number(query.limit) || 500, 1, 5000);

    const orphans = app.queries.orphans(owner);
    const deadLinks = app.queries.deadLinks(owner);
    const stale = app.queries.stale(owner, settings.get(owner).staleDays);
    // The same rule the overview applies, from the same function — so the count
    // and the list can never disagree about what counts as a finding.
    const untagged = app.queries.untaggedFindings(owner);
    const conflicts = app.queries.conflictCopies(owner);
    // Grouped from the whole dead-link list, above the cap. "Four notes ask for
    // this name" counted off a truncated page would be a smaller number handed
    // over as if it were the answer — and this is the one number in the reply
    // whose point is how many notes stand behind it.
    const missing = missingNotes(deadLinks);

    return {
      orphans: orphans.slice(0, limit),
      untagged: untagged.slice(0, limit),
      deadLinks: deadLinks.slice(0, limit),
      stale: stale.slice(0, limit),
      conflicts: conflicts.slice(0, limit),
      missing: missing.slice(0, limit),
      truncated:
        orphans.length > limit ||
        untagged.length > limit ||
        deadLinks.length > limit ||
        stale.length > limit ||
        conflicts.length > limit ||
        missing.length > limit,
      /** The real totals, so a capped list can still report what it stands for. */
      totals: {
        orphans: orphans.length,
        untagged: untagged.length,
        deadLinks: deadLinks.length,
        stale: stale.length,
        conflicts: conflicts.length,
        missing: missing.length,
      },
    };
  });

  // ---- shares -------------------------------------------------------------
  fastify.get('/api/v1/shares', async (request) => {
    const caller = requireUser(request).id;
    return { granted: shares.byOwner(caller), received: shares.toGrantee(caller) };
  });

  /**
   * Grants a share on `owner`'s vault from a request body.
   *
   * One implementation for a person sharing their own vault and an
   * administrator adding a member to a space — the two differ in who may ask,
   * never in what a grant is. Takes `{ grantee, kind, path, canWrite }`, or the
   * `{ grantee, prefix, canWrite }` every client sent before kinds existed.
   */
  async function grantFromBody(
    owner: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | { share: Share }> {
    const input = body(request, S.GrantShareRequest);
    const grantee = input.grantee.trim();

    if (grantee === '') {
      return reply.code(400).send({ code: 'no_grantee', message: 'name somebody to share with' });
    }
    // A space is not somebody to share with, and it answers exactly like a
    // name that does not exist: whether a space of that name exists is not the
    // caller's to learn from this form.
    const recipient = users.get(grantee);
    if (recipient === undefined || recipient.kind !== 'person') {
      return reply.code(404).send({ code: 'no_such_user', message: 'no such account' });
    }

    const target =
      input.kind === undefined ? (input.prefix ?? input.path ?? '') : { kind: input.kind, path: input.path ?? input.prefix ?? '' };

    try {
      return { share: await app.grantShare(owner, grantee, target, input.canWrite === true) };
    } catch (error) {
      if (error instanceof InvalidShareError) {
        return reply.code(400).send({ code: 'invalid_share', message: error.message });
      }
      throw error;
    }
  }

  fastify.post('/api/v1/shares', async (request, reply) => {
    // Only ever grants access to the caller's *own* vault: a share the caller
    // holds is not theirs to pass on. A note share must name a note that is
    // there, in that vault — a note of somebody else's answers as missing.
    return grantFromBody(requireUser(request).id, request, reply);
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

/** A month and a day of boundaries: enough for any trace a view draws. */
export const MAX_DAY_BOUNDS = 32;
/** The longest a day can be: 24 hours, one more at a clock change, one of slack. */
export const MAX_DAY_HOURS = 26;
/** The longest window all the days together may cover. */
export const MAX_SPAN_DAYS = 32;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Reads `bounds` for the per-day activity: 2 to `MAX_DAY_BOUNDS` whole,
 * non-negative, strictly ascending timestamps, no day longer than
 * `MAX_DAY_HOURS` and all of them within `MAX_SPAN_DAYS`. Anything else is
 * `null` rather than a guess — a silently repaired boundary would count a day's
 * edits into its neighbour.
 *
 * The count alone did not bound the work: `0,9000000000000000` is two bounds
 * and one "day" holding every edit the vault ever had.
 */
export function parseDayBounds(raw: unknown): number[] | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const parts = raw.split(',');
  if (parts.length < 2 || parts.length > MAX_DAY_BOUNDS) return null;

  const bounds: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,16}$/.test(part)) return null;
    const value = Number(part);
    const previous = bounds[bounds.length - 1];
    if (!Number.isSafeInteger(value) || (previous !== undefined && value <= previous)) return null;
    if (previous !== undefined && value - previous > MAX_DAY_HOURS * HOUR_MS) return null;
    bounds.push(value);
  }
  if (bounds[bounds.length - 1]! - bounds[0]! > MAX_SPAN_DAYS * 24 * HOUR_MS) return null;
  return bounds;
}

export function replyProblem(reply: FastifyReply, error: unknown): FastifyReply {
  const problem = toProblem(error);
  return reply.code(problem.status).send({ code: problem.code, message: problem.message });
}
