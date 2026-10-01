/**
 * A live session against a running ndBrain, for the acceptance runs beside this.
 *
 * These scripts exist because live collaboration has no CI and cannot be proved
 * by unit tests alone: what they check is whether two browsers on one note
 * actually agree, over a real socket, through whatever proxy sits in front of the
 * server. The server's own tests check the server; this checks the wire.
 *
 * `yjs` and `y-protocols` are imported rather than reimplemented, deliberately.
 * A hand-rolled protocol here could fail in a way that looks like a product
 * defect — and did, on the first attempt: a client that synced a document from
 * an old room into a rebuilt one duplicated the text and reported it as a bug in
 * the server. The real browser refuses that, and so does `open` below.
 *
 * Nothing in here names a host or an account. Run it as:
 *
 *   NDBRAIN_URL=https://notes.example NDBRAIN_USER=somebody \
 *     node acceptance/two-sessions.mjs < password-on-stdin
 */

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

const MESSAGE_SYNC = 0;
const MESSAGE_CONTROL = 2;

export const HOST = (process.env['NDBRAIN_URL'] ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
export const OWNER = process.env['NDBRAIN_USER'] ?? '';
if (OWNER === '') {
  console.error('set NDBRAIN_USER to the account to sign in as');
  process.exit(2);
}
const WS = HOST.replace(/^http/, 'ws');

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failed = false;

/** One line of result. A failure sets the exit code rather than throwing. */
export function say(ok, what, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${what}${detail === '' ? '' : `  — ${detail}`}`);
  if (!ok) {
    failed = true;
    process.exitCode = 1;
  }
}

export function done() {
  console.log(failed ? '\nSOMETHING FAILED' : '\nall checks passed');
}

/**
 * The password, read from stdin.
 *
 * Never an argument and never a file in the repository: arguments land in shell
 * history and in `ps`, which is the same rule `ndbrain-user` follows.
 */
export async function readPassword() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const password = Buffer.concat(chunks).toString('utf8').trim();
  if (password === '') {
    console.error('no password on stdin — pipe it in, do not pass it as an argument');
    process.exit(2);
  }
  return password;
}

export async function signIn(password) {
  const reply = await fetch(`${HOST}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: OWNER, password }),
  });
  if (!reply.ok) throw new Error(`login answered ${reply.status}`);
  const cookie = reply.headers.getSetCookie().find((c) => c.startsWith('ndbrain_session='));
  if (cookie === undefined) {
    // The case the operations note warns about: a 200 with no cookie, which a
    // browser produces silently over plain HTTP against a secure-cookie server.
    throw new Error('login answered 200 with no session cookie — http against a secure-cookie server?');
  }
  return cookie.split(';')[0];
}

export const notePath = (path) => `${HOST}/api/v1/notes/${encodeURIComponent(path)}`;

export async function write(cookie, path, content) {
  return fetch(notePath(path), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ content, owner: OWNER }),
  });
}

export async function read(cookie, path) {
  const reply = await fetch(`${notePath(path)}?owner=${encodeURIComponent(OWNER)}`, { headers: { cookie } });
  if (!reply.ok) return null;
  return (await reply.json()).note.content;
}

export async function remove(cookie, path) {
  return fetch(`${notePath(path)}?owner=${encodeURIComponent(OWNER)}`, { method: 'DELETE', headers: { cookie } });
}

/**
 * Opens a live session, behaving as `web/src/collab/provider.ts` does.
 *
 * Two parts of that behaviour are load-bearing and easy to leave out:
 *
 *  - nothing of ours is sent before the server's hello has been read, because
 *    the hello says which room this is
 *  - a document carried over from an earlier room is never synced into a new
 *    one; `expectEpoch` makes that refusal happen, and the call returns
 *    `{ rebase: true }` instead of a session
 *
 * Without the second, a reconnect after a server restart inserts the whole text
 * a second time — both sides hold it as their own operations — and the note
 * reads twice. That is a defect in the client, not in the server, and this
 * module exists partly so nobody has to rediscover it.
 */
export async function open(cookie, path, { doc = new Y.Doc(), expectEpoch = null } = {}) {
  const url = `${WS}/api/v1/collab?owner=${encodeURIComponent(OWNER)}&path=${encodeURIComponent(path)}`;
  const socket = new WebSocket(url, { headers: { cookie, origin: HOST } });
  socket.binaryType = 'arraybuffer';

  const control = [];
  let closed = null;
  let helloSeen = false;
  let rebase = false;

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => {
      const out = encoding.createEncoder();
      encoding.writeVarUint(out, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(out, doc);
      socket.send(encoding.toUint8Array(out));
    });
    socket.addEventListener('message', (event) => {
      const input = decoding.createDecoder(new Uint8Array(event.data));
      const kind = decoding.readVarUint(input);
      if (kind === MESSAGE_SYNC) {
        const out = encoding.createEncoder();
        encoding.writeVarUint(out, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(input, out, doc, 'remote');
        if (encoding.length(out) > 1) socket.send(encoding.toUint8Array(out));
      } else if (kind === MESSAGE_CONTROL) {
        const message = JSON.parse(decoding.readVarString(input));
        control.push(message);
        if (message.type === 'hello') {
          if (expectEpoch !== null && message.epoch !== expectEpoch) {
            rebase = true;
            socket.close(1000);
            resolve();
            return;
          }
          helloSeen = true;
          resolve();
        }
      }
    });
    socket.addEventListener('close', (event) => {
      closed = { code: event.code, reason: event.reason };
      reject(new Error(`socket closed ${event.code} ${event.reason}`));
    });
    socket.addEventListener('error', () => reject(new Error('socket error')));
  });

  doc.on('update', (update, origin) => {
    if (origin === 'remote' || !helloSeen || socket.readyState !== 1) return;
    const out = encoding.createEncoder();
    encoding.writeVarUint(out, MESSAGE_SYNC);
    syncProtocol.writeUpdate(out, update);
    socket.send(encoding.toUint8Array(out));
  });

  await ready;
  if (rebase) return { rebase: true, doc };

  const text = doc.getText('content');
  return {
    rebase: false,
    doc,
    socket,
    control,
    epoch: control.find((m) => m.type === 'hello')?.epoch,
    canWrite: control.find((m) => m.type === 'hello')?.canWrite,
    text: () => text.toString(),
    type: (what) => text.insert(text.length, what),
    isClosed: () => closed !== null,
    closedAs: () => closed,
    close: () => {
      try {
        socket.close();
      } catch {
        /* already gone */
      }
    },
  };
}

export { Y };
