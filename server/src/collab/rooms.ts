/**
 * Every open room, by note.
 *
 * Opening is deduplicated: two editors arriving at once must end up in one
 * room, or they would each load the file and edit two diverging copies.
 */

import { Room, type Persisted, type RoomDeps } from './room.js';

export interface RegistryDeps extends Omit<RoomDeps, 'onClosed'> {
  load(owner: string, path: string): Promise<Persisted>;
  maxRooms?: number;
}

export class RoomLimitError extends Error {}

const key = (owner: string, path: string): string => `${owner}\u0000${path}`;

export class RoomRegistry {
  readonly #rooms = new Map<string, Room>();
  readonly #opening = new Map<string, Promise<Room>>();
  readonly #deps: RegistryDeps;

  constructor(deps: RegistryDeps) {
    this.#deps = deps;
  }

  get size(): number {
    return this.#rooms.size;
  }

  get(owner: string, path: string): Room | undefined {
    const room = this.#rooms.get(key(owner, path));
    return room === undefined || room.closed ? undefined : room;
  }

  all(): Room[] {
    return [...this.#rooms.values()];
  }

  open(owner: string, path: string): Promise<Room> {
    const existing = this.get(owner, path);
    if (existing !== undefined) return Promise.resolve(existing);
    const pending = this.#opening.get(key(owner, path));
    if (pending !== undefined) return pending;

    if (this.#rooms.size + this.#opening.size >= (this.#deps.maxRooms ?? 200)) {
      return Promise.reject(new RoomLimitError('too many open notes'));
    }

    const opening = (async () => {
      const initial = await this.#deps.load(owner, path);
      const room = new Room(owner, path, initial, {
        ...this.#deps,
        onClosed: (closed) => {
          if (this.#rooms.get(key(closed.owner, closed.path)) === closed) {
            this.#rooms.delete(key(closed.owner, closed.path));
          }
        },
      });
      this.#rooms.set(key(owner, path), room);
      return room;
    })().finally(() => this.#opening.delete(key(owner, path)));

    this.#opening.set(key(owner, path), opening);
    return opening;
  }

  rekey(owner: string, from: string, to: string): void {
    const room = this.get(owner, from);
    if (room === undefined) return;
    this.#rooms.delete(key(owner, from));
    room.rekey(to);
    this.#rooms.set(key(owner, to), room);
  }

  /** For shutdown: every room writes what it holds. */
  async closeAll(): Promise<void> {
    for (const room of this.all()) {
      await room.flush();
      room.destroy();
    }
  }
}
