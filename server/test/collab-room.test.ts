import { describe, expect, it, vi } from 'vitest';

import { contentHash } from '../src/auth/noteBindings.js';
import { Room, type Peer, type Persisted, type RoomDeps } from '../src/collab/room.js';
import { RoomLimitError, RoomRegistry } from '../src/collab/rooms.js';
import { NoteNotFoundError } from '../src/errors.js';

function disk(initial: string) {
  let file: Persisted | null = { text: initial, hash: contentHash(initial) };
  const writes: Array<{ text: string; baseHash: string; actors: string[] }> = [];
  const copies: string[] = [];
  const deps: RoomDeps = {
    persist: async (_o, _p, text, baseHash, actors) => {
      if (file === null) throw new NoteNotFoundError('gone');
      writes.push({ text, baseHash, actors });
      file = { text, hash: contentHash(text) };
      return file;
    },
    readDisk: async () => file,
    conflictCopy: async (_o, path, text) => {
      copies.push(text);
      return path.replace(/\.md$/, ' (Konflikt).md');
    },
    onClosed: () => undefined,
    persistDelayMs: 10,
    agentPresenceMs: 20,
  };
  return {
    deps,
    writes,
    copies,
    setFile: (text: string | null) => {
      file = text === null ? null : { text, hash: contentHash(text) };
    },
    file: () => file,
  };
}

function peer(userId = 'julian'): Peer & { sent: Uint8Array[]; closedWith: number | undefined } {
  const p = {
    userId,
    canWrite: true,
    clientIds: new Set<number>(),
    sent: [] as Uint8Array[],
    closedWith: undefined as number | undefined,
    send(message: Uint8Array) {
      p.sent.push(message);
    },
    close(code: number) {
      p.closedWith = code;
    },
  };
  return p;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Room', () => {
  it('transforms the live text and persists it once, later', async () => {
    const d = disk('a\n');
    const room = new Room('julian', 'N.md', { text: 'a\n', hash: contentHash('a\n') }, d.deps);
    room.join(peer());
    room.transform((live) => `${live}b\n`, { actor: 'julian' });
    room.transform((live) => `${live}c\n`, { actor: 'ramona' });
    expect(room.text.toString()).toBe('a\nb\nc\n');
    expect(d.writes).toHaveLength(0);
    await wait(40);
    expect(d.writes).toHaveLength(1);
    expect(d.writes[0]!.text).toBe('a\nb\nc\n');
    expect(d.writes[0]!.actors.sort()).toEqual(['julian', 'ramona']);
  });

  it('leaves the text alone when the transform throws', () => {
    const d = disk('x');
    const room = new Room('julian', 'N.md', { text: 'x', hash: contentHash('x') }, d.deps);
    expect(() =>
      room.transform(() => {
        throw new Error('refused');
      }, { actor: 'julian' }),
    ).toThrow('refused');
    expect(room.text.toString()).toBe('x');
  });

  it('merges a stale writer and keeps a conflicting one as a copy', async () => {
    // Three lines, not two: diff3 needs an untouched line between two changed
    // ones to tell "different lines" apart from "one touched region" — see
    // `threeWay`'s own tests. Line 2 is that untouched line throughout.
    const d = disk('a\nb\nc\n');
    const room = new Room('julian', 'N.md', { text: 'a\nb\nc\n', hash: contentHash('a\nb\nc\n') }, d.deps);
    room.transform(() => 'a\nb\nC\n', { actor: 'julian' });

    // The agent's base still says line 3 is 'c', but its own change is to
    // line 1, which live never touched: no overlap, so it merges in cleanly
    // alongside julian's live change to line 3.
    expect(await room.merge('a\nb\nc\n', 'A\nb\nc\n', { actor: 'agent', agent: true })).toEqual({});
    expect(room.text.toString()).toBe('A\nb\nC\n');

    // ramona started from the same original base, before either of those
    // changes landed, and also touches line 3 — the same line julian's live
    // change did. That collides, so it is kept as a conflict copy instead.
    const result = await room.merge('a\nb\nc\n', 'a\nb\nX\n', { actor: 'ramona' });
    expect(result.conflictCopy).toBe('N (Konflikt).md');
    expect(room.text.toString()).toBe('A\nb\nC\n');
    expect(d.copies).toEqual(['a\nb\nX\n']);
  });

  it('merges a change made on disk before it persists', async () => {
    const d = disk('one\ntwo\n');
    const room = new Room('julian', 'N.md', { text: 'one\ntwo\n', hash: contentHash('one\ntwo\n') }, d.deps);
    room.join(peer());
    room.transform(() => 'ONE\ntwo\n', { actor: 'julian' });
    d.setFile('one\ntwo\nthree\n');
    await room.flush();
    expect(room.text.toString()).toBe('ONE\ntwo\nthree\n');
    expect(d.file()!.text).toBe('ONE\ntwo\nthree\n');
  });

  it('closes as deleted when the file is gone', async () => {
    const d = disk('x');
    const room = new Room('julian', 'N.md', { text: 'x', hash: contentHash('x') }, d.deps);
    const p = peer();
    room.join(p);
    room.transform(() => 'y', { actor: 'julian' });
    d.setFile(null);
    await room.flush();
    expect(room.closed).toBe(true);
    expect(p.closedWith).toBe(4410);
  });

  it('shows an agent write as presence for a while', async () => {
    const d = disk('x');
    const room = new Room('julian', 'N.md', { text: 'x', hash: contentHash('x') }, d.deps);
    room.transform((live) => `${live} from agent`, { actor: 'claude-code', agent: true });
    const names = [...room.awareness.getStates().values()].map((s) => (s['user'] as { name: string }).name);
    expect(names).toContain('🤖 claude-code');
    await wait(60);
    expect(room.awareness.getStates().size).toBe(0);
  });

  it('persists and closes when the last peer leaves', async () => {
    const d = disk('x');
    const closed = vi.fn();
    const room = new Room('julian', 'N.md', { text: 'x', hash: contentHash('x') }, { ...d.deps, onClosed: closed, persistDelayMs: 10_000 });
    const p = peer();
    room.join(p);
    room.transform(() => 'y', { actor: 'julian' });
    await room.leave(p);
    expect(d.file()!.text).toBe('y');
    expect(closed).toHaveBeenCalledWith(room);
  });

  it('broadcasts updates to every peer but the one that sent them', () => {
    const d = disk('x');
    const room = new Room('julian', 'N.md', { text: 'x', hash: contentHash('x') }, d.deps);
    const a = peer('a');
    const b = peer('b');
    room.join(a);
    room.join(b);
    const before = { a: a.sent.length, b: b.sent.length };
    room.doc.transact(() => room.text.insert(0, '!'), a);
    expect(a.sent.length).toBe(before.a);
    expect(b.sent.length).toBe(before.b + 1);
  });

  it('persists a write that lands during the final leave-flush before closing', async () => {
    const d = disk('x');
    let releasePersist: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    const persistCalls: string[] = [];
    const deps: RoomDeps = {
      ...d.deps,
      persist: async (owner, path, text, baseHash, actors) => {
        persistCalls.push(text);
        await gate;
        return d.deps.persist(owner, path, text, baseHash, actors);
      },
    };
    const closed = vi.fn();
    const room = new Room('julian', 'N.md', { text: 'x', hash: contentHash('x') }, { ...deps, onClosed: closed });
    const p = peer();
    room.join(p);
    room.transform(() => 'y', { actor: 'julian' });

    const leaving = room.leave(p);
    // Give the leave-triggered flush a moment to start its persist call and
    // hang there, still holding the room open.
    await wait(5);
    expect(persistCalls).toEqual(['y']);
    expect(room.closed).toBe(false);

    // A write lands — an agent, say — while that persist is still in flight.
    room.transform((live) => `${live}z`, { actor: 'agent', agent: true });

    releasePersist?.();
    await leaving;

    // The in-flight persist (of the now-stale 'y') finished, but the room is
    // not clean: 'yz' still needs to be written, so it stays open.
    expect(room.closed).toBe(false);
    expect(closed).not.toHaveBeenCalled();

    // The debounced retry for the later write catches up and, once the text
    // matches what was written, the idle check closes the room.
    await wait(30);
    expect(d.file()!.text).toBe('yz');
    expect(room.closed).toBe(true);
    expect(closed).toHaveBeenCalledWith(room);
  });

  it('keeps the room open when persist fails at leave, and closes once the retry succeeds', async () => {
    const d = disk('x');
    let fail = true;
    const deps: RoomDeps = {
      ...d.deps,
      persist: async (owner, path, text, baseHash, actors) => {
        if (fail) throw new Error('disk full');
        return d.deps.persist(owner, path, text, baseHash, actors);
      },
    };
    const closed = vi.fn();
    const logged: unknown[] = [];
    const room = new Room(
      'julian',
      'N.md',
      { text: 'x', hash: contentHash('x') },
      { ...deps, onClosed: closed, log: (error) => logged.push(error) },
    );
    const p = peer();
    room.join(p);
    room.transform(() => 'y', { actor: 'julian' });

    await room.leave(p);

    // The write is not lost — it is still sitting in the live text, with its
    // retry armed — and the room was not destroyed to cancel that retry.
    expect(room.text.toString()).toBe('y');
    expect(room.closed).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    expect(logged).toHaveLength(1);

    fail = false;
    await wait(30);

    expect(d.file()!.text).toBe('y');
    expect(room.closed).toBe(true);
    expect(closed).toHaveBeenCalledWith(room);
  });
});

describe('RoomRegistry', () => {
  function registry(maxRooms = 200) {
    const d = disk('text');
    const load = vi.fn(async () => ({ text: 'text', hash: contentHash('text') }));
    return { reg: new RoomRegistry({ ...d.deps, load, maxRooms }), load };
  }

  it('opens one room per note even when asked twice at once', async () => {
    const { reg, load } = registry();
    const [a, b] = await Promise.all([reg.open('julian', 'N.md'), reg.open('julian', 'N.md')]);
    expect(a).toBe(b);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('refuses beyond the limit', async () => {
    const { reg } = registry(1);
    await reg.open('julian', 'A.md');
    await expect(reg.open('julian', 'B.md')).rejects.toBeInstanceOf(RoomLimitError);
  });

  it('moves a room to its new path and tells its peers', async () => {
    const { reg } = registry();
    const room = await reg.open('julian', 'A.md');
    const p = peer();
    room.join(p);
    reg.rekey('julian', 'A.md', 'Ordner/B.md');
    expect(reg.get('julian', 'A.md')).toBeUndefined();
    expect(reg.get('julian', 'Ordner/B.md')).toBe(room);
    expect(room.path).toBe('Ordner/B.md');
  });

  it('destroys every room on shutdown, logging the one that could not be written', async () => {
    const d = disk('text');
    const load = vi.fn(async () => ({ text: 'text', hash: contentHash('text') }));
    const logged: unknown[] = [];
    const reg = new RoomRegistry({
      ...d.deps,
      load,
      log: (error) => logged.push(error),
      persist: async (owner, path, text, baseHash, actors) => {
        if (path === 'A.md') throw new Error('disk full');
        return d.deps.persist(owner, path, text, baseHash, actors);
      },
    });

    const a = await reg.open('julian', 'A.md');
    const b = await reg.open('julian', 'B.md');
    a.transform(() => 'changed a', { actor: 'julian' });
    b.transform(() => 'changed b', { actor: 'julian' });

    await reg.closeAll();

    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
    expect(reg.size).toBe(0);
    expect(logged.some((error) => error instanceof Error && error.message.includes('A.md'))).toBe(true);
  });
});
