import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

let dataDir: string;
let runtime: Runtime;
let julian: string;
const noPeer = () => ({
  userId: julian,
  canWrite: true,
  clientIds: new Set<number>(),
  sent: [] as Uint8Array[],
  closedWith: undefined as number | undefined,
  send() {},
  close(code: number) {
    this.closedWith = code;
  },
});

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-collab-structure-'));
  runtime = await createRuntime({ ...loadConfig(), dataDir, reconcileIntervalMs: 0, collab: true });
  julian = (await runtime.users.create('julian', 'ein gutes passwort')).id;
  await runtime.app.createNote(julian, 'A.md', 'links to [[B]]\n');
  await runtime.app.createNote(julian, 'B.md', 'b\n');
});

afterEach(async () => {
  await runtime.rooms?.closeAll();
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('structure changes while a room is open', () => {
  it('rename while open keeps writing to the new path', async () => {
    const room = await runtime.rooms!.open(julian, 'B.md');
    room.join(noPeer());
    room.transform((live) => `${live}typed before\n`, { actor: julian });
    await runtime.app.renameNote(julian, 'B.md', 'Ordner/C.md', { view: julian });
    room.transform((live) => `${live}typed after\n`, { actor: julian });
    await room.flush();

    expect(room.path).toBe('Ordner/C.md');
    const moved = await runtime.app.notes.getNote(julian, 'Ordner/C.md');
    expect(moved.content).toBe('b\ntyped before\ntyped after\n');
    await expect(runtime.app.notes.getNote(julian, 'B.md')).rejects.toThrow();
  });

  it('rewrites a link inside an open referrer through its room', async () => {
    const room = await runtime.rooms!.open(julian, 'A.md');
    room.join(noPeer());
    room.transform((live) => `${live}typing\n`, { actor: julian });
    await runtime.app.renameNote(julian, 'B.md', 'C.md', { view: julian });
    expect(room.text.toString()).toBe('links to [[C]]\ntyping\n');
  });

  it('delete while open persists the last text, then closes the room', async () => {
    const room = await runtime.rooms!.open(julian, 'B.md');
    const peer = noPeer();
    room.join(peer);
    room.transform(() => 'last words\n', { actor: julian });
    await runtime.app.deleteNote(julian, 'B.md', julian);
    expect(room.closed).toBe(true);
    expect(peer.closedWith).toBe(4410);
    expect(runtime.rooms!.get(julian, 'B.md')).toBeUndefined();
  });

  it('a file removed on disk closes the room', async () => {
    const room = await runtime.rooms!.open(julian, 'B.md');
    room.join(noPeer());
    await fs.rm(path.join(dataDir, 'vaults', julian, 'B.md'));
    runtime.app.noteVanished(julian, 'B.md');
    expect(room.closed).toBe(true);
  });
});
