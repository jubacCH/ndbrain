/**
 * The `/api/v1/collab` socket, spoken to with the real protocol.
 *
 * The client here is the wire contract and nothing else: it decodes what the
 * server sends with `y-protocols` and answers the same way a browser does, so
 * a change in the encoding fails here rather than in production.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import type WebSocket from 'ws';

import {
  CLOSE,
  COLLAB_PATH,
  Control,
  MESSAGE_AWARENESS,
  MESSAGE_CONTROL,
  MESSAGE_SYNC,
} from '../../shared/collab.js';
import { startHarness, type Harness } from './support/harness.js';

let h: Harness;
let julian: string;
let ramona: string;

beforeEach(async () => {
  h = await startHarness('collab-socket', { collab: true });
  julian = (await h.runtime.users.create('julian', 'ein gutes passwort', { displayName: 'Julian' })).id;
  ramona = (await h.runtime.users.create('ramona', 'ihr gutes passwort', { displayName: 'Ramona' })).id;
  await h.login('julian', 'ein gutes passwort');
  await h.login('ramona', 'ihr gutes passwort');
  await h.runtime.app.createNote(julian, 'N.md', 'hello\n');
});

afterEach(async () => {
  await h.close();
});

interface Client {
  ws: WebSocket;
  doc: Y.Doc;
  awareness: Awareness;
  controls: Control[];
  closed: Promise<{ code: number; reason: string }>;
}

async function connect(user: string, target: string, origin = 'http://localhost:80'): Promise<Client> {
  const ws = await h.server.injectWS(target, {
    headers: { cookie: h.cookieOf(user), origin, host: 'localhost:80' },
  });
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalState(null);
  const controls: Control[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString('utf8') }));
  });

  ws.on('message', (data: Buffer) => {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_CONTROL) {
      const control = Control.parse(JSON.parse(decoding.readVarString(decoder)));
      controls.push(control);
      if (control.type === 'hello') {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(encoder, doc);
        ws.send(encoding.toUint8Array(encoder));
      }
    } else if (type === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, doc, 'server');
      if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
    } else if (type === MESSAGE_AWARENESS) {
      applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), 'server');
    }
  });

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === 'server') return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    ws.send(encoding.toUint8Array(encoder));
  });

  return { ws, doc, awareness, controls, closed };
}

/** Sends an awareness state the way the browser does, claiming a client id. */
function sendAwareness(client: Client, state: Record<string, unknown>): void {
  client.awareness.setLocalState(state);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(client.awareness, [client.doc.clientID]));
  client.ws.send(encoding.toUint8Array(encoder));
}

const until = async (check: () => boolean, ms = 5000): Promise<void> => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const url = (owner: string, notePath: string): string =>
  `${COLLAB_PATH}?owner=${encodeURIComponent(owner)}&path=${encodeURIComponent(notePath)}`;

const textOf = (client: Client): string => client.doc.getText('content').toString();

describe('the collab socket', () => {
  it('syncs the note and says hello first', async () => {
    const c = await connect('julian', url(julian, 'N.md'));
    await until(() => textOf(c) === 'hello\n');
    expect(c.controls[0]?.type).toBe('hello');
    expect(c.controls[0]).toMatchObject({ canWrite: true, persistedHash: expect.any(String) });
  });

  it('carries typing from one editor to another and into the file', async () => {
    const a = await connect('julian', url(julian, 'N.md'));
    const b = await connect('julian', url(julian, 'N.md'));
    await until(() => textOf(b).length > 0);
    a.doc.getText('content').insert(0, 'A: ');
    await until(() => textOf(b) === 'A: hello\n');
    // `terminate`, not `close`: `injectWS` connects the two ends with a pair of
    // PassThrough streams, which never carry the closing handshake through, so
    // a graceful `close()` leaves the server holding a peer forever. A dropped
    // connection is also the case that actually happens — a laptop going to
    // sleep does not send a close frame either.
    a.ws.terminate();
    b.ws.terminate();
    await until(() => h.runtime.rooms!.size === 0);
    expect((await h.runtime.app.notes.getNote(julian, 'N.md')).content).toBe('A: hello\n');
  });

  it('refuses a foreign origin', async () => {
    await expect(connect('julian', url(julian, 'N.md'), 'https://evil.example')).rejects.toThrow();
  });

  it('refuses an upgrade with no origin at all', async () => {
    await expect(
      h.server.injectWS(url(julian, 'N.md'), { headers: { cookie: h.cookieOf('julian'), host: 'localhost:80' } }),
    ).rejects.toThrow();
  });

  it('answers a missing and a forbidden note byte-identically', async () => {
    const missing = await connect('ramona', url(ramona, 'Nope.md'));
    const forbidden = await connect('ramona', url(julian, 'N.md'));
    const a = await missing.closed;
    const b = await forbidden.closed;
    // Not merely both 4404: refusal looks like absence down to the reason string.
    expect(a).toEqual({ code: CLOSE.gone, reason: 'not found' });
    expect(b).toEqual(a);
  });

  it('answers a path that is not a note the same way', async () => {
    const c = await connect('julian', url(julian, 'Folder/'));
    expect(await c.closed).toEqual({ code: CLOSE.gone, reason: 'not found' });
  });

  it('drops updates from a read-only share but still syncs it the text', async () => {
    h.runtime.shares.grant(julian, '', ramona, false);
    const reader = await connect('ramona', url(julian, 'N.md'));
    await until(() => reader.controls.some((c) => c.type === 'hello'));
    expect(reader.controls[0]).toMatchObject({ type: 'hello', canWrite: false });
    await until(() => textOf(reader) === 'hello\n');

    reader.doc.getText('content').insert(0, 'sneaky ');
    await new Promise((r) => setTimeout(r, 150));
    expect(h.runtime.rooms!.get(julian, 'N.md')!.text.toString()).toBe('hello\n');
  });

  it('closes when the share is withdrawn', async () => {
    const share = h.runtime.shares.grant(julian, '', ramona, true);
    const c = await connect('ramona', url(julian, 'N.md'));
    await until(() => c.controls.length > 0);
    h.runtime.shares.revoke(share.id);
    expect(await c.closed).toEqual({ code: CLOSE.gone, reason: 'not found' });
  });

  it('downgrades to read-only when a share loses write', async () => {
    h.runtime.shares.grant(julian, '', ramona, true);
    const c = await connect('ramona', url(julian, 'N.md'));
    await until(() => c.controls.length > 0);
    h.runtime.shares.grant(julian, '', ramona, false);
    await until(() => c.controls.some((m) => m.type === 'access' && !m.canWrite));

    await until(() => textOf(c).length > 0);
    c.doc.getText('content').insert(0, 'after the downgrade ');
    await new Promise((r) => setTimeout(r, 150));
    expect(h.runtime.rooms!.get(julian, 'N.md')!.text.toString()).toBe('hello\n');
  });

  it('closes on logout', async () => {
    const c = await connect('julian', url(julian, 'N.md'));
    await until(() => c.controls.length > 0);
    await h.as('julian', { method: 'POST', url: '/api/v1/auth/logout' });
    expect(await c.closed).toEqual({ code: CLOSE.gone, reason: 'not found' });
  });

  it('closes when the account is disabled', async () => {
    h.runtime.shares.grant(julian, '', ramona, true);
    const c = await connect('ramona', url(julian, 'N.md'));
    await until(() => c.controls.length > 0);
    h.runtime.users.setDisabled(ramona, true);
    expect(await c.closed).toEqual({ code: CLOSE.gone, reason: 'not found' });
  });

  it('shows an agent append live, marked as a robot', async () => {
    const c = await connect('julian', url(julian, 'N.md'));
    await until(() => textOf(c).length > 0);
    await h.runtime.app.appendNote(julian, 'N.md', 'agent line', 'claude-code', { agent: true });
    await until(() => textOf(c).includes('agent line'));
    await until(() =>
      [...c.awareness.getStates().values()].some(
        (state) => (state as { user?: { name?: string } }).user?.name === '🤖 claude-code',
      ),
    );
  });

  it("overwrites a forged awareness name and colour with the session's own", async () => {
    const watcher = await connect('julian', url(julian, 'N.md'));
    const forger = await connect('julian', url(julian, 'N.md'));
    await until(() => watcher.controls.length > 0 && forger.controls.length > 0);

    sendAwareness(forger, {
      cursor: { anchor: 1, head: 1 },
      user: { name: '🤖 Administrator', color: '#000000' },
    });
    await until(() => watcher.awareness.getStates().has(forger.doc.clientID));
    const seen = watcher.awareness.getStates().get(forger.doc.clientID) as {
      user: { name: string; color: string };
      cursor: unknown;
    };
    // The robot marker is the server's alone, and the name is the session's.
    expect(seen.user.name).toBe('Julian');
    expect(seen.user.color).not.toBe('#000000');
    // What a client may say about itself survives: where its cursor is.
    expect(seen.cursor).toEqual({ anchor: 1, head: 1 });
  });

  it('gives two tabs of one account the same colour', async () => {
    // A third socket does the looking: a client is not sent the server's
    // sanitised version of its *own* state back into its awareness map, so
    // neither tab can see what the room made of it.
    const watcher = await connect('julian', url(julian, 'N.md'));
    const a = await connect('julian', url(julian, 'N.md'));
    const b = await connect('julian', url(julian, 'N.md'));
    await until(() => watcher.controls.length > 0 && a.controls.length > 0 && b.controls.length > 0);
    sendAwareness(a, { cursor: null });
    sendAwareness(b, { cursor: null });
    await until(
      () => watcher.awareness.getStates().has(a.doc.clientID) && watcher.awareness.getStates().has(b.doc.clientID),
    );

    const seen = [a, b].map(
      (tab) =>
        (watcher.awareness.getStates().get(tab.doc.clientID) as { user: { name: string; color: string } }).user,
    );
    expect(seen).toHaveLength(2);
    expect(new Set(seen.map((look) => look.color)).size).toBe(1);
    expect(seen.every((look) => look.name === 'Julian')).toBe(true);
  });

  it('refuses a further editor for one account before it opens a socket', async () => {
    // Two rather than the shipped twenty: the number under test is the
    // configured one, and twenty-one upgrades are slow enough to make the test
    // about the harness instead.
    const small = await startHarness('collab-sockets', { collab: true, collabMaxSocketsPerUser: 2 });
    try {
      const smallJulian = (await small.runtime.users.create('julian', 'ein gutes passwort')).id;
      await small.login('julian', 'ein gutes passwort');
      await small.runtime.app.createNote(smallJulian, 'N.md', 'hello\n');
      const open = (): Promise<WebSocket> =>
        small.server.injectWS(url(smallJulian, 'N.md'), {
          headers: { cookie: small.cookieOf('julian'), origin: 'http://localhost:80', host: 'localhost:80' },
        });

      const first = await open();
      const second = await open();
      // `injectWS` resolves the moment the client is open, which is before the
      // route handler has finished joining the room; wait for the room to
      // actually hold both before taking one away.
      await until(() => small.runtime.rooms!.get(smallJulian, 'N.md')?.peers.size === 2);
      await expect(open()).rejects.toThrow('429');

      // The cap counts what is open now, not what has ever connected.
      second.terminate();
      await until(() => small.runtime.rooms!.get(smallJulian, 'N.md')?.peers.size === 1);
      const third = await open();
      expect(third.readyState).toBe(third.OPEN);

      first.terminate();
      third.terminate();
    } finally {
      await small.close();
    }
  }, 30_000);

  it('refuses a room beyond the process limit with its own code', async () => {
    const small = await startHarness('collab-rooms', { collab: true, collabMaxRooms: 1 });
    try {
      const smallJulian = (await small.runtime.users.create('julian', 'ein gutes passwort')).id;
      await small.login('julian', 'ein gutes passwort');
      await small.runtime.app.createNote(smallJulian, 'One.md', '1\n');
      await small.runtime.app.createNote(smallJulian, 'Two.md', '2\n');

      const first = await small.server.injectWS(
        `${COLLAB_PATH}?owner=${smallJulian}&path=One.md`,
        { headers: { cookie: small.cookieOf('julian'), origin: 'http://localhost:80', host: 'localhost:80' } },
      );
      const second = await small.server.injectWS(
        `${COLLAB_PATH}?owner=${smallJulian}&path=Two.md`,
        { headers: { cookie: small.cookieOf('julian'), origin: 'http://localhost:80', host: 'localhost:80' } },
      );
      const code = await new Promise<number>((resolve) => second.on('close', (c: number) => resolve(c)));
      expect(code).toBe(CLOSE.full);
      first.close();
    } finally {
      await small.close();
    }
  });

  it('does not exist at all when collaboration is off', async () => {
    const off = await startHarness('collab-off', { collab: false });
    try {
      const offJulian = (await off.runtime.users.create('julian', 'ein gutes passwort')).id;
      await off.login('julian', 'ein gutes passwort');
      await off.runtime.app.createNote(offJulian, 'N.md', 'hello\n');
      expect(off.runtime.rooms).toBeNull();
      const reply = await off.as('julian', { url: url(offJulian, 'N.md') });
      expect(reply.status).toBe(404);
    } finally {
      await off.close();
    }
  });
});
