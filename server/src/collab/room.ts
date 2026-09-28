/**
 * One note while somebody has it open.
 *
 * The Y.Doc here is a working copy in memory, never a store: it is filled from
 * the file when the room opens, written back to the file through the ordinary
 * write path at most `persistDelayMs` after the last change, and thrown away
 * when the last editor leaves. The file stays the truth.
 *
 * Every change to the text has exactly one way in, `transform`, which runs a
 * function on the live text and applies the difference. Because the difference
 * is computed against the live text at that instant, it is exact — there is no
 * guessing about what a writer meant, only about stale writers, which is what
 * `merge` is for.
 */

import { randomUUID } from 'node:crypto';

import * as encoding from 'lib0/encoding';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { CLOSE, MESSAGE_AWARENESS, MESSAGE_CONTROL, MESSAGE_SYNC, type Control } from '../../../shared/collab.js';
import { contentHash } from '../auth/noteBindings.js';
import { NoteNotFoundError } from '../errors.js';
import type { Note } from '../notes/service.js';
import { noteTitle } from '../vault/paths.js';
import { agentLook, encodeAwarenessState } from './awareness.js';
import { applyTextChange, threeWay } from './merge.js';

export interface Persisted {
  text: string;
  hash: string;
}

/** Who caused a change: an account id, or an agent key's name. */
export interface By {
  actor: string;
  agent?: boolean;
}

/** One connected editor, as the room sees it. */
export interface Peer {
  readonly userId: string;
  canWrite: boolean;
  readonly clientIds: Set<number>;
  send(message: Uint8Array): void;
  close(code: number, reason: string): void;
}

export interface RoomDeps {
  persist(owner: string, path: string, text: string, baseHash: string, actors: string[]): Promise<Persisted>;
  readDisk(owner: string, path: string): Promise<Persisted | null>;
  conflictCopy(owner: string, path: string, text: string, actor: string): Promise<string>;
  onClosed(room: Room): void;
  persistDelayMs?: number;
  agentPresenceMs?: number;
  log?(error: unknown): void;
}

export function encodeControl(message: Control): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_CONTROL);
  encoding.writeVarString(encoder, JSON.stringify(message));
  return encoding.toUint8Array(encoder);
}

export function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

export function encodeAwareness(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** Origin of changes the server makes on nobody's behalf in particular. */
const SERVER = Symbol('server');

interface AgentPresence {
  clientID: number;
  clock: number;
  timer: NodeJS.Timeout;
}

export class Room {
  readonly epoch = randomUUID();
  readonly doc = new Y.Doc();
  readonly text: Y.Text;
  readonly awareness: Awareness;
  readonly peers = new Set<Peer>();
  owner: string;
  path: string;
  lastPersisted: Persisted;
  closed = false;

  readonly #deps: RoomDeps;
  readonly #actors = new Set<string>();
  readonly #agents = new Map<string, AgentPresence>();
  #timer: NodeJS.Timeout | null = null;
  #chain: Promise<void> = Promise.resolve();

  constructor(owner: string, path: string, initial: Persisted, deps: RoomDeps) {
    this.owner = owner;
    this.path = path;
    this.lastPersisted = initial;
    this.#deps = deps;
    this.text = this.doc.getText('content');
    this.doc.transact(() => this.text.insert(0, initial.text), SERVER);

    this.awareness = new Awareness(this.doc);
    // The internal "who is still around" sweep must never keep the process
    // (or a test run) alive on its own.
    (this.awareness as unknown as { _checkInterval?: NodeJS.Timeout })._checkInterval?.unref?.();
    // The server has no cursor of its own.
    this.awareness.setLocalState(null);

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (this.closed) return;
      const message = encodeSyncUpdate(update);
      for (const peer of this.peers) if (peer !== origin) peer.send(message);
      if (origin === SERVER) return;
      const actor = actorOf(origin);
      if (actor !== null) this.#actors.add(actor);
      this.#schedule();
    });

    this.awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        const changed = [...added, ...updated, ...removed];
        if (changed.length === 0 || this.closed) return;
        const message = encodeAwareness(encodeAwarenessUpdate(this.awareness, changed));
        for (const peer of this.peers) peer.send(message);
      },
    );
  }

  /** The live text as a note, for callers that answer with one. */
  note(): Note {
    const content = this.text.toString();
    return {
      path: this.path,
      title: noteTitle(this.path),
      content,
      size: Buffer.byteLength(content, 'utf8'),
      mtimeMs: Date.now(),
      hash: contentHash(content),
    };
  }

  /**
   * Runs `fn` on the live text and applies the difference.
   *
   * `fn` may throw to refuse (a task that moved, a text that is not there);
   * the text is then untouched, because nothing is applied before it returns.
   */
  transform(fn: (live: string) => string, by: By): void {
    if (this.closed) throw new NoteNotFoundError('note does not exist');
    const live = this.text.toString();
    const next = fn(live);
    if (next === live) return;
    let at: number | null = null;
    this.doc.transact(() => {
      at = applyTextChange(this.text, live, next);
    }, by);
    if (by.agent === true && at !== null) this.#showAgent(by.actor, at);
  }

  /** Merges a writer who started from `base`; see `threeWay`. */
  async merge(base: string, incoming: string, by: By): Promise<{ conflictCopy?: string }> {
    const live = this.text.toString();
    const { text, clean } = threeWay(base, incoming, live);
    if (text !== live) this.transform(() => text, by);
    if (clean) return {};
    return { conflictCopy: await this.#deps.conflictCopy(this.owner, this.path, incoming, by.actor) };
  }

  /** A writer whose starting point is unknown: kept beside the note, never merged. */
  async keepAsConflict(incoming: string, by: By): Promise<{ conflictCopy: string }> {
    return { conflictCopy: await this.#deps.conflictCopy(this.owner, this.path, incoming, by.actor) };
  }

  join(peer: Peer): void {
    this.peers.add(peer);
  }

  async leave(peer: Peer): Promise<void> {
    if (!this.peers.delete(peer)) return;
    removeAwarenessStates(this.awareness, [...peer.clientIds], SERVER);
    if (this.peers.size > 0) return;
    await this.flush();
    if (this.peers.size === 0 && !this.closed) this.destroy();
  }

  control(message: Control, only?: Peer): void {
    const bytes = encodeControl(message);
    if (only !== undefined) only.send(bytes);
    else for (const peer of this.peers) peer.send(bytes);
  }

  rekey(path: string): void {
    this.path = path;
    this.control({ type: 'moved', owner: this.owner, path });
  }

  closeDeleted(by: string): void {
    if (this.closed) return;
    this.control({ type: 'deleted', by });
    for (const peer of this.peers) peer.close(CLOSE.deleted, 'deleted');
    this.destroy();
  }

  /**
   * Writes the live text now, after taking in whatever changed on disk.
   *
   * Serialised: two flushes never overlap, so `lastPersisted` always names
   * what the file held when the next one starts.
   */
  flush(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#chain = this.#chain.then(() => this.#persistNow()).catch((error) => this.#deps.log?.(error));
    return this.#chain;
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    for (const agent of this.#agents.values()) clearTimeout(agent.timer);
    this.#agents.clear();
    this.awareness.destroy();
    this.doc.destroy();
    this.peers.clear();
    this.#deps.onClosed(this);
  }

  #schedule(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, this.#deps.persistDelayMs ?? 1000);
    this.#timer.unref?.();
  }

  async #persistNow(): Promise<void> {
    if (this.closed) return;

    const disk = await this.#deps.readDisk(this.owner, this.path);
    if (disk === null) {
      this.closeDeleted(this.owner);
      return;
    }
    if (disk.hash !== this.lastPersisted.hash) {
      // Somebody wrote the file outside the room (vim, rsync, git). Their
      // change is merged in as the owner's, and the file is the new base.
      await this.merge(this.lastPersisted.text, disk.text, { actor: this.owner });
      this.lastPersisted = disk;
    }

    const text = this.text.toString();
    const actors = [...this.#actors];
    this.#actors.clear();
    if (text === this.lastPersisted.text) return;

    try {
      this.lastPersisted = await this.#deps.persist(this.owner, this.path, text, this.lastPersisted.hash, actors);
    } catch (error) {
      if (error instanceof NoteNotFoundError) {
        this.closeDeleted(this.owner);
        return;
      }
      for (const actor of actors) this.#actors.add(actor);
      this.#schedule();
      throw error;
    }
    this.control({ type: 'persisted', hash: this.lastPersisted.hash });
  }

  #showAgent(keyName: string, index: number): void {
    const existing = this.#agents.get(keyName);
    if (existing !== undefined) clearTimeout(existing.timer);
    const presence: AgentPresence = existing ?? {
      clientID: Math.floor(Math.random() * 0x7fffffff),
      clock: 0,
      timer: setTimeout(() => undefined, 0),
    };
    const position = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.text, index));
    presence.clock += 1;
    applyAwarenessUpdate(
      this.awareness,
      encodeAwarenessState(presence.clientID, presence.clock, {
        user: agentLook(keyName),
        cursor: { anchor: position, head: position },
      }),
      SERVER,
    );
    presence.timer = setTimeout(() => {
      presence.clock += 1;
      if (!this.closed) {
        applyAwarenessUpdate(this.awareness, encodeAwarenessState(presence.clientID, presence.clock, null), SERVER);
      }
      this.#agents.delete(keyName);
    }, this.#deps.agentPresenceMs ?? 5000);
    presence.timer.unref?.();
    this.#agents.set(keyName, presence);
  }
}

function actorOf(origin: unknown): string | null {
  if (typeof origin !== 'object' || origin === null) return null;
  if ('actor' in origin && typeof origin.actor === 'string') return origin.actor;
  if ('userId' in origin && typeof origin.userId === 'string') return origin.userId;
  return null;
}
