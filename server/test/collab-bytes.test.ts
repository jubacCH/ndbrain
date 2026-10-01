/**
 * The file on disk is byte-identical to what the editors show.
 *
 * `collab-merge.test.ts` pins this for the diff and the merge in isolation,
 * which is where the arithmetic lives. This closes the loop: a note with CRLF
 * endings, astral characters and a NUL byte goes into a room, is changed
 * through every door the room has, is persisted through the ordinary write
 * path, and is then read back off the disk as bytes.
 *
 * Read as bytes rather than through `getNote`, deliberately. Everything above
 * the filesystem shares the same string, so a layer that normalised line
 * endings on the way out would normalise them on the way in too and the two
 * would agree with each other about the wrong answer.
 */

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
  send() {},
  close() {},
});

/** Awkward on purpose: CRLF, an astral pair, a grapheme cluster, and a NUL. */
const AWKWARD = '# 🧠 Notes\r\n\r\n- [ ] one\u0000two\r\n- 👩‍👩‍👧 family\r\n\r\nend, no newline';

const fileOf = async (notePath: string): Promise<string> =>
  (await fs.readFile(path.join(dataDir, 'vaults', julian, notePath))).toString('utf8');

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-collab-bytes-'));
  runtime = await createRuntime({ ...loadConfig(), dataDir, reconcileIntervalMs: 0, collab: true });
  julian = (await runtime.users.create('julian', 'ein gutes passwort')).id;
});

afterEach(async () => {
  await runtime.rooms?.closeAll();
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('a room keeps the bytes', () => {
  it('writes back exactly what it was filled with', async () => {
    await runtime.app.createNote(julian, 'N.md', AWKWARD);
    expect(await fileOf('N.md')).toBe(AWKWARD);

    const room = await runtime.rooms!.open(julian, 'N.md');
    room.join(noPeer());
    expect(room.text.toString()).toBe(AWKWARD);

    // One character added at the very end, and nothing else may move.
    room.transform((live) => `${live}!`, { actor: julian });
    await room.flush();

    expect(await fileOf('N.md')).toBe(`${AWKWARD}!`);
  });

  it('keeps them through an insert in the middle of the awkward part', async () => {
    await runtime.app.createNote(julian, 'N.md', AWKWARD);
    const room = await runtime.rooms!.open(julian, 'N.md');
    room.join(noPeer());

    const wanted = AWKWARD.replace('one\u0000two', 'one\u0000and\u0000two');
    room.transform(() => wanted, { actor: julian });
    await room.flush();

    const onDisk = await fileOf('N.md');
    expect(onDisk).toBe(wanted);
    // Said twice on purpose: a normalising layer would have produced a string
    // that still looks right in a diff but is shorter.
    expect(onDisk).toHaveLength(wanted.length);
    expect(onDisk.split('\r\n')).toHaveLength(wanted.split('\r\n').length);
  });

  it('keeps them through an append, which is the agents" door', async () => {
    await runtime.app.createNote(julian, 'N.md', AWKWARD);
    const room = await runtime.rooms!.open(julian, 'N.md');
    room.join(noPeer());

    await runtime.app.appendNote(julian, 'N.md', '- 🤖 wrote this', 'claude-code', { agent: true });
    await room.flush();

    const onDisk = await fileOf('N.md');
    expect(onDisk).toContain('🤖 wrote this');
    expect(onDisk.startsWith(AWKWARD.slice(0, AWKWARD.indexOf('end')))).toBe(true);
    expect(onDisk).toContain('one\u0000two');
    expect(onDisk).toContain('- 👩‍👩‍👧 family\r\n');
    // What the editors show is what the file holds.
    expect(onDisk).toBe(room.text.toString());
  });

  it('keeps them through a three-way merge of a stale writer', async () => {
    await runtime.app.createNote(julian, 'N.md', AWKWARD);
    const base = AWKWARD;
    const room = await runtime.rooms!.open(julian, 'N.md');
    room.join(noPeer());

    // Live changes the last line; the stale writer changes the first.
    room.transform((live) => live.replace('end, no newline', 'ended 🧠'), { actor: julian });
    const incoming = base.replace('# 🧠 Notes', '# 🧠 Notes, renamed');

    const merged = await room.merge(base, incoming, { actor: julian });
    expect(merged.conflictCopy).toBeUndefined();
    await room.flush();

    const onDisk = await fileOf('N.md');
    expect(onDisk).toBe(room.text.toString());
    expect(onDisk).toContain('# 🧠 Notes, renamed\r\n');
    expect(onDisk).toContain('ended 🧠');
    expect(onDisk).toContain('one\u0000two');
    // Every line ending that was CRLF still is; diff3 works on lines and a
    // line-splitter that dropped the `\r` would have rejoined with `\n`.
    expect(onDisk.match(/\r\n/g)?.length).toBe(base.match(/\r\n/g)?.length);
  });

  it('keeps them when the change came from disk while the room was open', async () => {
    await runtime.app.createNote(julian, 'N.md', AWKWARD);
    const room = await runtime.rooms!.open(julian, 'N.md');
    room.join(noPeer());
    room.transform((live) => live.replace('end, no newline', 'ended in the editor'), { actor: julian });

    // Somebody with vim, writing the file underneath the room.
    const fromDisk = AWKWARD.replace('# 🧠 Notes', '# 🧠 Notes, from vim');
    await fs.writeFile(path.join(dataDir, 'vaults', julian, 'N.md'), fromDisk, 'utf8');
    await room.flush();

    const onDisk = await fileOf('N.md');
    expect(onDisk).toBe(room.text.toString());
    expect(onDisk).toContain('from vim');
    expect(onDisk).toContain('ended in the editor');
    expect(onDisk).toContain('one\u0000two');
    expect(onDisk.match(/\r\n/g)?.length).toBe(AWKWARD.match(/\r\n/g)?.length);
  });

  it('carries them through a rename while the room is open', async () => {
    await runtime.app.createNote(julian, 'N.md', AWKWARD);
    const room = await runtime.rooms!.open(julian, 'N.md');
    room.join(noPeer());

    await runtime.app.renameNote(julian, 'N.md', 'Ordner/M.md', { view: julian });
    room.transform((live) => `${live}\r\nafter the move`, { actor: julian });
    await room.flush();

    expect(room.path).toBe('Ordner/M.md');
    const onDisk = await fileOf('Ordner/M.md');
    expect(onDisk).toBe(`${AWKWARD}\r\nafter the move`);
    // Nothing reappears at the old path.
    await expect(fileOf('N.md')).rejects.toThrow();
  });
});
