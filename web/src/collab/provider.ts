/**
 * The browser end of a live note.
 *
 * Nothing is sent until the server's hello has been read, because the hello
 * carries the room's epoch and a doc from an earlier epoch must never be
 * synced into a new room. Both sides inserted the whole text as their own
 * operations, so merging them shows the note twice. On an epoch change the
 * provider stops and reports `rebase`; the hook then sends the text through
 * the ordinary save path and starts a fresh provider.
 *
 * Note that "nothing is sent" does not mean "nothing may be typed": local
 * edits made before or between connections live in the local `Y.Doc` and are
 * sent as operations once the hello confirms the room is the same one.
 */

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import {
  CLOSE,
  COLLAB_PATH,
  Control,
  MESSAGE_AWARENESS,
  MESSAGE_CONTROL,
  MESSAGE_SYNC,
} from '../../../shared/collab';

export type CollabStatus =
  /** Trying, and nothing has arrived yet. */
  | 'connecting'
  /** Synced with the room: what is typed here is what everybody sees. */
  | 'live'
  /** Was live, is not now, and expects to be again. Typing is kept. */
  | 'offline'
  /** There is no live path for this note; the editor saves the old way. */
  | 'unavailable'
  /** Refused or missing — the two are the same answer. */
  | 'gone'
  | 'deleted'
  /** The room was rebuilt while this tab was away; the text is owed to it. */
  | 'rebase';

export interface ProviderOptions {
  owner: string;
  path: string;
  /** For tests; the real one is built from `location`. */
  url?: string;
  WebSocketImpl?: typeof WebSocket;
}

interface Events {
  status: (status: CollabStatus) => void;
  control: (control: Control) => void;
  synced: () => void;
}

/**
 * How many failed attempts before the editor is told to save the old way.
 *
 * Hangs on what a failure means: a proxy that does not pass upgrades, a kill
 * switch, or a note too large fails the same way every time, and the person is
 * waiting to type. Two attempts is enough to ride out a server restart that
 * happens to land on the first one, and short enough that nobody watches a
 * locked editor.
 */
const FAILED_ATTEMPTS_BEFORE_FALLBACK = 2;
const FIRST_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

/**
 * Close codes that no amount of retrying will change.
 *
 * A note bigger than the socket's frame (1009) is not going to shrink, and a
 * process out of rooms is not going to find one for this tab by being asked
 * again straight away. Both mean: save the way you did before.
 */
const HOPELESS = new Set<number>([1009, CLOSE.limit, CLOSE.full]);

export class CollabProvider {
  readonly doc = new Y.Doc();
  readonly text: Y.Text;
  readonly awareness: awarenessProtocol.Awareness;
  status: CollabStatus = 'connecting';
  canWrite = false;
  synced = false;
  /** The hash of the last version the server said it wrote to the file. */
  persistedHash: string | null = null;
  /** Typed while not connected: owed to the server if this room is gone. */
  dirtyOffline = false;

  readonly #options: ProviderOptions;
  readonly #listeners: { [K in keyof Events]: Set<Events[K]> } = {
    status: new Set(),
    control: new Set(),
    synced: new Set(),
  };
  #ws: WebSocket | null = null;
  #epoch: string | null = null;
  #helloSeen = false;
  #everLive = false;
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #destroyed = false;

  constructor(options: ProviderOptions) {
    this.#options = options;
    this.text = this.doc.getText('content');
    this.awareness = new awarenessProtocol.Awareness(this.doc);

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      // Not what the server just told us; that is already in the room.
      if (origin === this) return;
      if (this.status !== 'live') this.dirtyOffline = true;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MESSAGE_SYNC);
      syncProtocol.writeUpdate(e, update);
      this.#send(encoding.toUint8Array(e));
    });

    this.awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        // Only this tab's own state is ours to announce.
        const mine = [...added, ...updated, ...removed].filter((id) => id === this.doc.clientID);
        if (mine.length === 0) return;
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, mine));
        this.#send(encoding.toUint8Array(e));
      },
    );

    this.#connect();
  }

  on<K extends keyof Events>(event: K, fn: Events[K]): () => void {
    this.#listeners[event].add(fn);
    return () => {
      this.#listeners[event].delete(fn);
    };
  }

  destroy(): void {
    this.#destroyed = true;
    if (this.#retry !== null) clearTimeout(this.#retry);
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
    this.#ws?.close(1000);
    this.#ws = null;
    this.awareness.destroy();
    this.doc.destroy();
  }

  #setStatus(status: CollabStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const fn of this.#listeners.status) fn(status);
  }

  #url(): string {
    if (this.#options.url !== undefined) return this.#options.url;
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const query = `owner=${encodeURIComponent(this.#options.owner)}&path=${encodeURIComponent(this.#options.path)}`;
    return `${scheme}//${location.host}${COLLAB_PATH}?${query}`;
  }

  #send(message: Uint8Array): void {
    // Nothing leaves before the hello: see the file comment.
    if (!this.#helloSeen) return;
    const ws = this.#ws;
    if (ws === null || ws.readyState !== 1) return;
    // `lib0` types its output as `Uint8Array<ArrayBufferLike>`, and the DOM's
    // `send` wants the buffer narrowed to `ArrayBuffer`. The encoder allocates
    // its own plain buffer, so the narrowing is true here; it is asserted in
    // this one place rather than threaded through every encode.
    ws.send(message as Uint8Array<ArrayBuffer>);
  }

  #connect(): void {
    if (this.#destroyed) return;
    this.#retry = null;
    const Impl = this.#options.WebSocketImpl ?? WebSocket;
    const ws = new Impl(this.#url());
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;
    this.#helloSeen = false;

    ws.onmessage = (event: MessageEvent) => this.#receive(new Uint8Array(event.data as ArrayBuffer));
    ws.onclose = (event: CloseEvent) => {
      if (this.#ws === ws) this.#closed(event.code);
    };
  }

  #receive(data: Uint8Array): void {
    if (this.#destroyed) return;
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);

    if (type === MESSAGE_CONTROL) {
      let control: Control;
      try {
        control = Control.parse(JSON.parse(decoding.readVarString(decoder)));
      } catch {
        // A control message this client cannot read is not one to act on.
        return;
      }
      this.#control(control);
      for (const fn of this.#listeners.control) fn(control);
      return;
    }

    // Sync and awareness both belong to a room this client has identified.
    if (!this.#helloSeen) return;

    if (type === MESSAGE_SYNC) {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MESSAGE_SYNC);
      const subtype = syncProtocol.readSyncMessage(decoder, e, this.doc, this);
      if (encoding.length(e) > 1) this.#send(encoding.toUint8Array(e));
      if (subtype === syncProtocol.messageYjsSyncStep2) this.#inSync();
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
    }
  }

  #control(control: Control): void {
    if (control.type === 'hello') {
      if (this.#epoch !== null && control.epoch !== this.#epoch) {
        // A different room wearing the same name. Stop, and let the hook hand
        // the text over through the save path instead of the CRDT.
        this.#ws?.close(1000);
        this.#ws = null;
        this.#destroyed = true;
        this.#setStatus('rebase');
        return;
      }
      this.#epoch = control.epoch;
      this.#helloSeen = true;
      this.canWrite = control.canWrite;
      this.persistedHash = control.persistedHash;
      this.#failures = 0;

      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(e, this.doc);
      this.#send(encoding.toUint8Array(e));

      // Whatever was typed while away is an operation in the local doc; send
      // it now that the room is known to be the same one.
      const pending = encoding.createEncoder();
      encoding.writeVarUint(pending, MESSAGE_SYNC);
      syncProtocol.writeUpdate(pending, Y.encodeStateAsUpdate(this.doc));
      this.#send(encoding.toUint8Array(pending));
      return;
    }
    if (control.type === 'persisted') this.persistedHash = control.hash;
    else if (control.type === 'access') this.canWrite = control.canWrite;
  }

  /** The room's state has arrived and ours has gone out: this is live. */
  #inSync(): void {
    this.#everLive = true;
    this.dirtyOffline = false;
    if (!this.synced) {
      this.synced = true;
      this.#setStatus('live');
      for (const fn of this.#listeners.synced) fn();
      return;
    }
    this.#setStatus('live');
  }

  #closed(code: number): void {
    this.#ws = null;
    this.#helloSeen = false;
    if (this.#destroyed) return;
    // Refused, missing or deleted: an answer, not a failure. Nothing to retry.
    if (code === CLOSE.gone) return this.#setStatus('gone');
    if (code === CLOSE.deleted) return this.#setStatus('deleted');
    if (HOPELESS.has(code)) return this.#setStatus('unavailable');

    this.#failures += 1;
    if (!this.#everLive && this.#failures >= FAILED_ATTEMPTS_BEFORE_FALLBACK) {
      return this.#setStatus('unavailable');
    }
    if (this.#everLive) this.#setStatus('offline');

    const delay = Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** Math.min(this.#failures - 1, 5));
    this.#retry = setTimeout(() => this.#connect(), delay);
  }
}
