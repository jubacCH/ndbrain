/**
 * The provider against a fake server that speaks the real protocol.
 *
 * The server side here is `y-protocols` too, so the messages crossing the fake
 * socket are the same bytes the real server sends. What is faked is the
 * transport and nothing above it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { CLOSE, MESSAGE_CONTROL, MESSAGE_SYNC } from '../../shared/collab';
import { CollabProvider } from '../src/collab/provider';

/** A server room in the test: one doc, an epoch, any number of fake sockets. */
class FakeServer {
  doc = new Y.Doc();
  sockets = new Set<FakeSocket>();
  hello = { canWrite: true, persistedHash: 'h0' };

  constructor(
    public epoch: string,
    text: string,
  ) {
    this.doc.getText('content').insert(0, text);
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MESSAGE_SYNC);
      syncProtocol.writeUpdate(e, update);
      for (const s of this.sockets) if (s !== origin) s.deliver(encoding.toUint8Array(e));
    });
  }

  accept(socket: FakeSocket): void {
    this.sockets.add(socket);
    this.control(socket, { type: 'hello', epoch: this.epoch, ...this.hello });
    const step1 = encoding.createEncoder();
    encoding.writeVarUint(step1, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(step1, this.doc);
    socket.deliver(encoding.toUint8Array(step1));
  }

  control(socket: FakeSocket, message: unknown): void {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MESSAGE_CONTROL);
    encoding.writeVarString(e, JSON.stringify(message));
    socket.deliver(encoding.toUint8Array(e));
  }

  receive(socket: FakeSocket, data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return;
    const reply = encoding.createEncoder();
    encoding.writeVarUint(reply, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, reply, this.doc, socket);
    if (encoding.length(reply) > 1) socket.deliver(encoding.toUint8Array(reply));
  }

  text(): string {
    return this.doc.getText('content').toString();
  }
}

let server: FakeServer | null = null;
let refuseWith: number | null = null;
let opened = 0;

class FakeSocket {
  static readonly OPEN = 1;
  readyState = 0;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(public url: string) {
    opened += 1;
    setTimeout(() => {
      if (refuseWith !== null || server === null) {
        this.readyState = 3;
        this.onclose?.({ code: refuseWith ?? 1006 });
        return;
      }
      this.readyState = 1;
      this.onopen?.();
      server.accept(this);
    }, 0);
  }

  deliver(data: Uint8Array): void {
    setTimeout(() => this.onmessage?.({ data: data.slice().buffer as ArrayBuffer }), 0);
  }

  send(data: Uint8Array): void {
    const s = server;
    setTimeout(() => s?.receive(this, data), 0);
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    server?.sockets.delete(this);
    setTimeout(() => this.onclose?.({ code }), 0);
  }
}

const until = async (check: () => boolean, ms = 5000): Promise<void> => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const make = (): CollabProvider =>
  new CollabProvider({
    owner: 'julian',
    path: 'N.md',
    url: 'ws://test',
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
  });

beforeEach(() => {
  server = null;
  refuseWith = null;
  opened = 0;
});

afterEach(() => {
  server = null;
});

describe('CollabProvider', () => {
  it('syncs the room and goes live', async () => {
    server = new FakeServer('e1', 'hello');
    const p = make();
    await until(() => p.synced);
    expect(p.status).toBe('live');
    expect(p.text.toString()).toBe('hello');
    expect(p.canWrite).toBe(true);
    expect(p.persistedHash).toBe('h0');
    p.destroy();
  });

  it('sends local typing to the room', async () => {
    server = new FakeServer('e1', 'hello');
    const p = make();
    await until(() => p.synced);
    p.text.insert(0, '> ');
    await until(() => server!.text() === '> hello');
    p.destroy();
  });

  it('keeps what was typed before the hello, and converges on it', async () => {
    server = new FakeServer('e1', 'hello');
    const p = make();
    // Typed into a doc that has never met the room. Nothing may go out yet —
    // the epoch is unknown — but the insert is not lost either.
    p.text.insert(0, 'early ');
    await until(() => p.synced);
    await until(() => server!.text() === p.text.toString());

    // Both pieces survive and both sides agree. Not which order: two inserts
    // at position 0 in docs that had never met are concurrent, and Yjs settles
    // that by client id, which is why the editor stays locked until the first
    // sync rather than inviting anybody to type into this window.
    expect(p.text.toString()).toContain('early ');
    expect(p.text.toString()).toContain('hello');
    expect(p.text.toString()).toHaveLength('early hello'.length);
    p.destroy();
  });

  it('reconnects with the same epoch and keeps what was typed offline', async () => {
    server = new FakeServer('e1', 'hello');
    const p = make();
    await until(() => p.synced);
    for (const s of [...server.sockets]) s.close(1006);
    await until(() => p.status === 'offline');

    p.text.insert(5, ' offline');
    expect(p.dirtyOffline).toBe(true);
    await until(() => p.status === 'live');
    await until(() => server!.text() === 'hello offline');
    expect(p.dirtyOffline).toBe(false);
    expect(p.status).toBe('live');
    p.destroy();
  });

  it('new epoch rebases instead of syncing', async () => {
    server = new FakeServer('e1', 'hello');
    const p = make();
    await until(() => p.synced);
    for (const s of [...server.sockets]) s.close(1006);
    await until(() => p.status === 'offline');
    p.text.insert(5, ' offline');

    // The room was thrown away and built again from the file — a server
    // restart, or a laptop that slept for an hour. Both sides inserted the
    // whole text as their own operations, so syncing them shows it twice.
    server = new FakeServer('e2', 'hello');
    const rebuilt = server;

    // Settle rather than wait for the status: the promise under test is that
    // nothing of the old room's doc reaches the new one, and a test that only
    // waits for `rebase` passes by timing out on a provider that duplicated
    // the text first.
    // Long enough to cover the reconnect backoff, so the provider really has
    // met the new room by the time this looks.
    await until(() => p.status === 'rebase' || rebuilt.sockets.size > 0);
    await new Promise((r) => setTimeout(r, 300));

    expect(rebuilt.text()).toBe('hello');
    expect(rebuilt.text()).not.toContain('hellohello');
    expect(p.status).toBe('rebase');
    // Nothing offline was lost: the hook owes this text to the save path.
    expect(p.dirtyOffline).toBe(true);
    expect(p.text.toString()).toBe('hello offline');
    p.destroy();
  });

  it('falls back when no socket ever connects', async () => {
    refuseWith = 1006;
    const p = make();
    await until(() => p.status === 'unavailable');
    p.destroy();
  });

  it('falls back at once for a note too big for the socket', async () => {
    // 1009 is "message too big". Retrying cannot make the note smaller, so the
    // editor is told to save the way it did before rather than to keep trying.
    refuseWith = 1009;
    const p = make();
    await until(() => p.status === 'unavailable');
    expect(opened).toBe(1);
    p.destroy();
  });

  it('falls back at once when the process is out of rooms', async () => {
    refuseWith = CLOSE.full;
    const p = make();
    await until(() => p.status === 'unavailable');
    expect(opened).toBe(1);
    p.destroy();
  });

  it('reports a note that is gone, and stops trying', async () => {
    refuseWith = CLOSE.gone;
    const p = make();
    await until(() => p.status === 'gone');
    const after = opened;
    await new Promise((r) => setTimeout(r, 300));
    expect(opened).toBe(after);
    p.destroy();
  });

  it('reports a note that was deleted', async () => {
    refuseWith = CLOSE.deleted;
    const p = make();
    await until(() => p.status === 'deleted');
    p.destroy();
  });

  it('passes moved, deleted and access on to its listener', async () => {
    server = new FakeServer('e1', 'hello');
    const p = make();
    const seen: string[] = [];
    p.on('control', (control) => seen.push(control.type));
    await until(() => p.synced);

    const socket = [...server.sockets][0]!;
    server.control(socket, { type: 'access', canWrite: false });
    await until(() => !p.canWrite);
    server.control(socket, { type: 'persisted', hash: 'h1' });
    await until(() => p.persistedHash === 'h1');
    server.control(socket, { type: 'moved', owner: 'julian', path: 'Ordner/N.md' });
    await until(() => seen.includes('moved'));
    p.destroy();
  });

  it('never reports live for a room it has not synced with', async () => {
    server = new FakeServer('e1', 'hello');
    const p = make();
    const statuses: string[] = [];
    p.on('status', (status) => statuses.push(status));
    await until(() => p.synced);
    expect(statuses[statuses.length - 1]).toBe('live');
    // Never claimed to be live before the text had arrived.
    expect(statuses.indexOf('live')).toBe(statuses.length - 1);
    p.destroy();
  });

  it('stops for good once destroyed', async () => {
    server = new FakeServer('e1', 'hello');
    const p = make();
    await until(() => p.synced);
    p.destroy();
    const after = opened;
    for (const s of [...server.sockets]) s.close(1006);
    await new Promise((r) => setTimeout(r, 300));
    expect(opened).toBe(after);
    expect(p.status).not.toBe('offline');
  });
});
