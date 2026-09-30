/**
 * `/api/v1/collab`: one WebSocket per open editor.
 *
 * Authentication is the session cookie, checked by the same `onRequest` hook as
 * every other `/api/` route. Because browsers send that cookie on cross-site
 * WebSocket upgrades too — there is no preflight to stop them — the `Origin`
 * header is checked before anything else, and an upgrade without one is
 * refused rather than trusted.
 *
 * The permission check is the note's: read to join, write to change. A refusal
 * closes exactly like a missing note, the same code and the same reason, so the
 * socket cannot be used to find out which notes exist. Access is checked again
 * whenever shares, sessions or accounts change, and every `recheckMs` as a
 * backstop.
 */

import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import type WebSocket from 'ws';

import { CLOSE, COLLAB_PATH, MESSAGE_AWARENESS, MESSAGE_SYNC } from '../../../shared/collab.js';
import type { App } from '../app.js';
import type { ShareService } from '../auth/shares.js';
import type { SessionService, UserService } from '../auth/users.js';
import { SESSION_COOKIE } from '../http/cookie.js';
import type { Config } from '../config.js';
import { isNotePath, normalizeVaultPath } from '../vault/paths.js';
import { personLook, sanitizeAwareness, type Look } from './awareness.js';
import { encodeAwareness, type Peer, type Room } from './room.js';
import { RoomLimitError, type RoomRegistry } from './rooms.js';

export interface CollabDeps {
  app: App;
  rooms: RoomRegistry;
  shares: ShareService;
  sessions: SessionService;
  users: UserService;
  config: Config;
  recheckMs?: number;
}

/**
 * The largest frame this server will read, 8 MiB.
 *
 * Hangs on the first sync: joining a room delivers the whole note in one
 * message, so this is the ceiling on a note that can be edited live at all. A
 * note above it closes the socket and the editor saves the old way instead —
 * which is why the number may be lowered without anybody losing text, and why
 * raising it costs memory per socket rather than buying a feature.
 */
const MAX_PAYLOAD = 8 * 1024 * 1024;

/**
 * The message rate one socket may sustain, and the burst it may spend at once.
 *
 * Hangs on what typing actually produces: `y-codemirror.next` sends one small
 * frame per keystroke and per cursor move, so a fast typist with a trackpad
 * sits in the low tens per second. Two hundred is an order of magnitude above
 * that, and the burst covers a reconnect replaying what happened offline. Both
 * would need raising if the client ever started sending per-character
 * awareness for a selection drag.
 */
const RATE_PER_SECOND = 200;
const RATE_BURST = 400;

/**
 * How many Yjs client ids one socket may speak for.
 *
 * Hangs on how many docs one tab has: one for the editor, and the
 * `y-codemirror.next` undo manager does not add its own, so one is the honest
 * answer and four is slack for a client that reloads its doc without
 * reconnecting. A cap at all is the point — without one a single socket could
 * fill the room's awareness map with invented peers, each with a name and a
 * cursor.
 */
const MAX_CLIENT_IDS = 4;

interface Connection extends Peer {
  token: string;
  room: Room;
  /** Leaky bucket, in messages. */
  tokens: number;
  refilledAt: number;
}

/**
 * Whether this upgrade came from a page the server itself serves.
 *
 * A missing `Origin` is refused, not waved through: every browser sends one on
 * a WebSocket upgrade — there is no preflight, and the session cookie travels
 * cross-site — so its absence is not a browser.
 *
 * The comparison is host and port, plus the scheme only when something
 * trustworthy says what it is. `request.protocol` is deliberately not used:
 * on a WebSocket upgrade it is `undefined`, because Fastify derives it from a
 * raw socket the upgrade does not have in the usual shape, and a check built
 * on it refuses every legitimate connection. `x-forwarded-proto` is the
 * reverse proxy's own statement and is believed when present (`trustProxy` is
 * on for this server); with nothing to go on, http and https over the
 * server's own host are both accepted.
 *
 * Accepting either scheme for the right host is not the weak part of this
 * check. A cross-site attacker's page is on a *different* host, which is
 * exactly what is refused; a page on this server's own host over the wrong
 * scheme is not an attacker this server could tell apart in the first place.
 * `NDBRAIN_ALLOWED_ORIGINS` pins the origin exactly where a setup needs it.
 */
function ownOrigin(request: FastifyRequest, config: Config): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin === '') return false;
  if (config.allowedOrigins.includes(origin)) return true;

  const host = request.host;
  if (typeof host !== 'string' || host === '') return false;

  const forwarded = request.headers['x-forwarded-proto'];
  const scheme = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  if (scheme === 'http' || scheme === 'https') return origin === `${scheme}://${host}`;
  return origin === `http://${host}` || origin === `https://${host}`;
}

export async function registerCollab(fastify: FastifyInstance, deps: CollabDeps): Promise<void> {
  const { app, rooms, shares, sessions, users, config } = deps;
  const connections = new Set<Connection>();

  /**
   * Upgrades accepted per account and not yet closed.
   *
   * Counted here rather than off `connections`, which is only filled once the
   * route handler has awaited the room open: two upgrades arriving together
   * would both have looked at a count that had not yet grown, and an account
   * reconnecting in a loop could hold far more sockets than the cap names.
   * A reservation is taken in `preValidation` and released by the handler,
   * which always runs once `preValidation` has let a request through.
   */
  const held = new Map<string, number>();
  const hold = (userId: string): void => {
    held.set(userId, (held.get(userId) ?? 0) + 1);
  };
  const release = (userId: string): void => {
    const now = (held.get(userId) ?? 1) - 1;
    if (now <= 0) held.delete(userId);
    else held.set(userId, now);
  };

  await fastify.register(websocket, { options: { maxPayload: MAX_PAYLOAD } });

  /**
   * Closes or downgrades every connection whose access changed.
   *
   * Deliberately one pass over all sockets with its own memo: `node:sqlite` is
   * synchronous, so every query here stops the whole process for everybody.
   * Two tabs on one note ask the shares table once, not twice, and a session is
   * resolved once per token however many sockets hold it. The pass is also
   * coalesced (see `askForRecheck`), because one bulk share operation fires the
   * change signal many times in a single tick and an un-coalesced pass would
   * multiply that by the number of open sockets.
   */
  const recheck = (): void => {
    const sessionOk = new Map<string, boolean>();
    const rights = new Map<string, { read: boolean; write: boolean }>();

    for (const conn of connections) {
      let alive = sessionOk.get(conn.token);
      if (alive === undefined) {
        const session = sessions.resolve(conn.token);
        const user = session === null ? undefined : users.get(session.userId);
        alive = user !== undefined && !user.disabled && user.kind === 'person' && user.id === conn.userId;
        sessionOk.set(conn.token, alive);
      }
      if (!alive) {
        conn.close(CLOSE.gone, 'not found');
        continue;
      }

      const key = `${conn.userId}\u0000${conn.room.owner}\u0000${conn.room.path}`;
      let right = rights.get(key);
      if (right === undefined) {
        right = {
          read: shares.allows(conn.userId, conn.room.owner, conn.room.path, 'read'),
          write: shares.allows(conn.userId, conn.room.owner, conn.room.path, 'write'),
        };
        rights.set(key, right);
      }

      if (!right.read) {
        conn.close(CLOSE.gone, 'not found');
        continue;
      }
      if (right.write !== conn.canWrite) {
        conn.canWrite = right.write;
        conn.room.control({ type: 'access', canWrite: right.write }, conn);
      }
    }
  };

  // One pass per tick at most. The signals fire synchronously from inside the
  // mutation, and several of them land in the same tick.
  let pending: NodeJS.Immediate | null = null;
  const askForRecheck = (): void => {
    if (pending !== null) return;
    pending = setImmediate(() => {
      pending = null;
      recheck();
    });
    pending.unref?.();
  };

  const unsubscribe = [
    shares.onChange(askForRecheck),
    sessions.onChange(askForRecheck),
    users.onChange(askForRecheck),
  ];
  const backstop = setInterval(recheck, deps.recheckMs ?? 60_000);
  backstop.unref();
  fastify.addHook('onClose', async () => {
    clearInterval(backstop);
    if (pending !== null) clearImmediate(pending);
    for (const off of unsubscribe) off();
  });

  fastify.get(
    COLLAB_PATH,
    {
      websocket: true,
      preValidation: async (request: FastifyRequest, reply: FastifyReply) => {
        if (!ownOrigin(request, config)) {
          await reply.code(403).send({ code: 'forbidden_origin', message: 'wrong origin' });
          return reply;
        }

        // The per-account cap is answered here rather than by closing an
        // accepted socket: refusing the upgrade never allocates a WebSocket,
        // a `Y.Doc` or a room for a connection that is not going to be
        // allowed, and the browser treats a failed upgrade exactly as it
        // treats a socket that closes — it saves the way it did before.
        const caller = request.user;
        if (caller !== undefined) {
          if ((held.get(caller.id) ?? 0) >= config.collabMaxSocketsPerUser) {
            await reply.code(429).send({ code: 'too_many_connections', message: 'too many open editors' });
            return reply;
          }
          hold(caller.id);
        }
        return;
      },
    },
    async (socket: WebSocket, request: FastifyRequest) => {
      const user = request.user;
      // The `onRequest` gate has already refused an unauthenticated `/api/`
      // request; this is the belt to that braces, not a second policy.
      if (user === undefined) {
        socket.close(CLOSE.gone, 'not found');
        return;
      }

      // Registered before anything that can fail, and before the first await:
      // every way out of this handler from here on has to give the
      // reservation `preValidation` took back, or the account's cap would
      // shrink by one for the life of the process.
      let released = false;
      const giveBack = (): void => {
        if (released) return;
        released = true;
        release(user.id);
      };
      socket.on('close', giveBack);

      const token = request.cookies[SESSION_COOKIE] ?? '';
      const query = request.query as { owner?: string; path?: string };
      const owner = typeof query.owner === 'string' && query.owner !== '' ? query.owner : user.id;

      const gone = (): void => socket.close(CLOSE.gone, 'not found');

      let notePath: string;
      try {
        notePath = normalizeVaultPath(String(query.path ?? ''));
        if (!isNotePath(notePath)) throw new Error('not a note');
        // A note share names a file, not a path: confirm the binding before
        // trusting it, exactly as a REST read of a shared note does.
        if (owner !== user.id && shares.hasNoteShare(user.id, owner, notePath)) {
          await app.noteChanged(owner, notePath);
        }
        shares.check(user.id, owner, notePath, 'read');
      } catch {
        gone();
        return;
      }

      let room: Room;
      try {
        room = await rooms.open(owner, notePath);
      } catch (error) {
        // "Too many notes open" is a capacity answer, not a refusal: the editor
        // is told to save the old way rather than that the note is missing.
        if (error instanceof RoomLimitError) socket.close(CLOSE.full, 'too many open notes');
        else gone();
        return;
      }

      const look: Look = personLook(user.id, user.displayName);
      const conn: Connection = {
        userId: user.id,
        token,
        room,
        canWrite: shares.allows(user.id, owner, notePath, 'write'),
        clientIds: new Set<number>(),
        tokens: RATE_BURST,
        refilledAt: Date.now(),
        send: (message) => {
          if (socket.readyState === socket.OPEN) socket.send(message);
        },
        close: (code, reason) => socket.close(code, reason),
      };
      connections.add(conn);
      room.join(conn);

      // Hello first: the client checks the epoch before it syncs anything.
      room.control(
        { type: 'hello', epoch: room.epoch, canWrite: conn.canWrite, persistedHash: room.lastPersisted.hash },
        conn,
      );
      const step1 = encoding.createEncoder();
      encoding.writeVarUint(step1, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(step1, room.doc);
      conn.send(encoding.toUint8Array(step1));
      const states = [...room.awareness.getStates().keys()];
      if (states.length > 0) conn.send(encodeAwareness(encodeAwarenessUpdate(room.awareness, states)));

      /**
       * Whether this socket may speak for `clientID`.
       *
       * First come, first served: a client id another socket in the room has
       * already claimed is not this one's to move, or one tab could plant a
       * cursor under another person's name.
       */
      const claim = (clientID: number): boolean => {
        if (conn.clientIds.has(clientID)) return true;
        for (const other of room.peers) if (other !== conn && other.clientIds.has(clientID)) return false;
        if (conn.clientIds.size >= MAX_CLIENT_IDS) return false;
        conn.clientIds.add(clientID);
        return true;
      };

      socket.on('message', (data: Buffer) => {
        const now = Date.now();
        conn.tokens = Math.min(RATE_BURST, conn.tokens + ((now - conn.refilledAt) / 1000) * RATE_PER_SECOND);
        conn.refilledAt = now;
        if (conn.tokens < 1) {
          socket.close(CLOSE.limit, 'too many messages');
          return;
        }
        conn.tokens -= 1;

        try {
          const decoder = decoding.createDecoder(new Uint8Array(data));
          const type = decoding.readVarUint(decoder);
          // `conn.room` rather than the captured `room`: after a rename the
          // registry re-keys the same room, and this is where a late message
          // finds out which one it belongs to.
          const current = conn.room;
          if (current.closed) return;

          if (type === MESSAGE_SYNC) {
            // Peek at the sync subtype: a reader may ask for the state
            // (step 1) but never send changes (step 2, or an update).
            const subtype = decoding.peekVarUint(decoder);
            if (!conn.canWrite && subtype !== syncProtocol.messageYjsSyncStep1) return;
            const reply = encoding.createEncoder();
            encoding.writeVarUint(reply, MESSAGE_SYNC);
            syncProtocol.readSyncMessage(decoder, reply, current.doc, conn);
            if (encoding.length(reply) > 1) conn.send(encoding.toUint8Array(reply));
          } else if (type === MESSAGE_AWARENESS) {
            const clean = sanitizeAwareness(decoding.readVarUint8Array(decoder), claim, look);
            // Applied through y-protocols so the room broadcasts it like any other.
            if (clean !== null) applyAwarenessUpdate(current.awareness, clean, conn);
          }
        } catch {
          // A frame this server cannot read is not something to guess at.
          socket.close(CLOSE.gone, 'not found');
        }
      });

      socket.on('close', () => {
        connections.delete(conn);
        void conn.room.leave(conn);
      });
    },
  );
}
