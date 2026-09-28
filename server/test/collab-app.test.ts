/**
 * Every way a note's content changes, while a room is open for it.
 *
 * No socket here: a room is opened directly, the way the socket will, and the
 * assertions are about the live text and the file.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

let dataDir: string;
let runtime: Runtime;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-collab-app-'));
  runtime = await createRuntime({ ...loadConfig(), dataDir, reconcileIntervalMs: 0, collab: true });
  await runtime.users.create('julian', 'ein gutes passwort');
  await runtime.app.createNote('julian', 'N.md', '# N\n\n- [ ] task\n\ntext\n');
});

afterEach(async () => {
  await runtime.rooms?.closeAll();
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function openRoom() {
  const room = await runtime.rooms!.open('julian', 'N.md');
  room.join({ userId: 'julian', canWrite: true, clientIds: new Set(), send: () => undefined, close: () => undefined });
  return room;
}

describe('writes into an open room', () => {
  it('appends into the live text, not the file', async () => {
    const room = await openRoom();
    room.transform((live) => live.replace('text', 'live text'), { actor: 'julian' });
    await runtime.app.appendNote('julian', 'N.md', 'from agent', 'claude-code', { agent: true });
    expect(room.text.toString()).toContain('live text');
    expect(room.text.toString()).toContain('from agent');
  });

  it('toggles a task in the live text', async () => {
    const room = await openRoom();
    await runtime.app.toggleTask('julian', 'N.md', 3, { text: 'task', done: false }, true, 'julian');
    expect(room.text.toString()).toContain('- [x] task');
  });

  it('tags in the live text without losing typing since the last persist', async () => {
    const room = await openRoom();
    room.transform((live) => `${live}typed\n`, { actor: 'julian' });
    await runtime.app.bulkTag('julian', ['N.md'], 'topic/x', 'julian');
    expect(room.text.toString()).toContain('typed');
    expect(room.text.toString()).toContain('topic/x');
  });

  it('edits for an agent against the live text', async () => {
    const room = await openRoom();
    room.transform((live) => live.replace('text', 'fresh words'), { actor: 'julian' });
    await runtime.app.editNote('julian', 'N.md', 'fresh words', 'agent words', 'claude-code', { agent: true });
    expect(room.text.toString()).toContain('agent words');
  });

  it('merges a stale whole-text write that names its base', async () => {
    const before = await runtime.app.notes.getNote('julian', 'N.md');
    const room = await openRoom();
    room.transform((live) => live.replace('# N', '# N live'), { actor: 'julian' });
    const result = await runtime.app.putNote('julian', 'N.md', before.content.replace('text', 'old tab'), 'ramona', {
      baseHash: before.hash,
    });
    expect(result.conflictCopy).toBeUndefined();
    expect(room.text.toString()).toContain('# N live');
    expect(room.text.toString()).toContain('old tab');
  });

  it('keeps a write with an unknown base as a conflict copy', async () => {
    const room = await openRoom();
    const result = await runtime.app.putNote('julian', 'N.md', 'something else', 'ramona', { baseHash: 'nope' });
    expect(result.conflictCopy).toMatch(/Konflikt/);
    expect(room.text.toString()).not.toContain('something else');
  });

  it('persists the live text through the write path, logging each actor', async () => {
    const room = await openRoom();
    room.transform((live) => `${live}julian\n`, { actor: 'julian' });
    room.transform((live) => `${live}ramona\n`, { actor: 'ramona' });
    await room.flush();
    const file = await runtime.app.notes.getNote('julian', 'N.md');
    expect(file.content).toBe(room.text.toString());
    const actors = runtime.db
      .all("SELECT actor FROM edits WHERE path = 'N.md' AND action = 'update'")
      .map((row) => String(row['actor']));
    expect(actors).toEqual(expect.arrayContaining(['julian', 'ramona']));
  });

  it('takes in an edit made on disk', async () => {
    const room = await openRoom();
    room.transform((live) => live.replace('# N', '# N live'), { actor: 'julian' });
    const file = path.join(dataDir, 'vaults', 'julian', 'N.md');
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('text', 'vim'));
    await runtime.app.noteChanged('julian', 'N.md');
    expect(room.text.toString()).toContain('# N live');
    expect(room.text.toString()).toContain('vim');
  });

  it('behaves exactly as before when no room is open', async () => {
    const before = await runtime.app.notes.getNote('julian', 'N.md');
    await runtime.app.putNote('julian', 'N.md', 'first', 'julian');
    const result = await runtime.app.putNote('julian', 'N.md', 'second', 'ramona', { baseHash: before.hash });
    expect(result.conflictCopy).toMatch(/Konflikt/);
  });
});
