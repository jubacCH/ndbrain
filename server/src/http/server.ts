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
import type { SettingsService } from '../auth/settings.js';
import type { History } from '../vault/history.js';
import { SessionService, UserService, type User } from '../auth/users.js';
import { registerMcpEndpoint } from '../mcp/endpoint.js';
import type { Config } from '../config.js';
import { toProblem } from './errors.js';
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
  users: UserService;
  sessions: SessionService;
  keys: ApiKeyService;
  shares: ShareService;
  settings: SettingsService;
  history: History;
  config: Config;
  throttle?: LoginThrottle;
}

/** Routes reachable without a session. Everything else is closed by default. */
const PUBLIC_ROUTES = new Set(['/api/v1/auth/login', '/api/v1/health']);

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { app, users, sessions, keys, shares, settings, history, config } = deps;
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
    const { user: id, password } = body(request, S.LoginRequest);

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
    const { content, baseMtimeMs } = body(request, S.PutNoteRequest);

    // Optional and only meaningful for a shared note: see App.putNote.
    const options = baseMtimeMs !== undefined && baseMtimeMs > 0 ? { baseMtimeMs } : {};

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
    const { path: dir } = body(request, S.CreateFolderRequest);

    if (dir.trim() === '') {
      return reply.code(400).send({ code: 'no_path', message: 'name the folder' });
    }
    return reply.code(201).send({ folder: await app.createFolder(owner, dir) });
  });

  fastify.post('/api/v1/folders/rename', async (request) => {
    const owner = requireUser(request).id;
    const { from, to } = body(request, S.RenameFolderRequest);

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
        // Zero where tagging is not a convention here; see untaggedFindings.
        untagged: app.queries.untaggedFindings(caller).length,
        deadLinks: app.queries.deadLinks(caller).length,
        // The threshold is the caller's, not a number this file picked.
        stale: app.queries.stale(caller, settings.get(caller).staleDays).length,
        // Notes, not findings — the four above overlap heavily. See attentionCount.
        attention: app.queries.attentionCount(caller, settings.get(caller).staleDays),
        tagsInUse: app.queries.tagsInUse(caller),
      },
      recent: app.queries.recentNotes(view, 12),
      tasks: app.queries.openTasks(view).slice(0, 50),
      tags: app.queries.tagCounts(view).slice(0, 30),
      activity: app.queries.activity(view, since, 20),
    };
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

    // A foreign vault is only listable where something in it has been shared;
    // the per-file rules are enforced again on download and on write.
    if (owner !== caller) shares.check(caller, owner, '', 'read');

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
    const { owner, path: filePath } = target(request, 'read');
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

    const result = await app.writeFile(owner, filePath, bytes, requireUser(request).id);
    return reply.code(result.replaced ? 200 : 201).send({ ...result, ok: true });
  });

  fastify.delete('/api/v1/files/*', async (request, reply) => {
    const { owner, path: filePath } = target(request, 'write');
    await app.deleteFile(owner, filePath, requireUser(request).id);
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

    const zip = new ZipFile();
    for (const file of files) {
      zip.addBuffer(await app.readFile(owner, file.path), file.path, {
        mtime: new Date(file.mtimeMs),
      });
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

    const key = `${request.ip}|${user.id}`;
    const wait = throttle.retryAfter(key);
    if (wait > 0) {
      return reply
        .code(429)
        .header('Retry-After', String(wait))
        .send({ code: 'too_many_attempts', message: 'too many attempts, try again later' });
    }

    const confirmed = await users.authenticate(user.id, currentPassword);
    if (confirmed === null) {
      throttle.recordFailure(key);
      return reply.code(403).send({ code: 'wrong_password', message: 'the current password is wrong' });
    }
    throttle.recordSuccess(key);

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

  fastify.get('/api/v1/history/*', async (request) => {
    const { owner, path } = target(request, 'read');
    const query = (request.query ?? {}) as { version?: unknown };

    // One route, two questions: the list, or one version's text.
    if (typeof query.version === 'string' && query.version !== '') {
      return { content: await history.contentAt(owner, path, query.version) };
    }

    return {
      available: await history.available(owner),
      versions: await history.versions(owner, path),
    };
  });

  fastify.post('/api/v1/history/restore', async (request) => {
    const caller = requireUser(request).id;
    const { owner, path, version } = body(request, S.RestoreRequest);

    // The same gate every write goes through; a share that is read-only cannot
    // be rolled back by the person it was lent to.
    shares.check(caller, owner, path, 'write');

    const content = await history.contentAt(owner, path, version);
    const result = await app.putNote(owner, path, content, caller);
    return { note: result.note, created: result.created };
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

    return {
      orphans: orphans.slice(0, limit),
      untagged: untagged.slice(0, limit),
      deadLinks: deadLinks.slice(0, limit),
      stale: stale.slice(0, limit),
      truncated:
        orphans.length > limit ||
        untagged.length > limit ||
        deadLinks.length > limit ||
        stale.length > limit,
      /** The real totals, so a capped list can still report what it stands for. */
      totals: {
        orphans: orphans.length,
        untagged: untagged.length,
        deadLinks: deadLinks.length,
        stale: stale.length,
      },
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
