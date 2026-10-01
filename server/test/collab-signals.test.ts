/**
 * Access changes announce themselves.
 *
 * The live socket has to learn about a withdrawn share within a second, not at
 * the next 60-second backstop, so every mutation that can change who reaches
 * what tells its listeners. A listener is an observer: the mutation has already
 * happened and stands even if the listener throws.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

let dataDir: string;
let runtime: Runtime;
let julian: string;
let ramona: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-signals-'));
  runtime = await createRuntime({ ...loadConfig(), dataDir, reconcileIntervalMs: 0 });
  julian = (await runtime.users.create('julian', 'ein gutes passwort')).id;
  ramona = (await runtime.users.create('ramona', 'ihr gutes passwort')).id;
  await runtime.app.createNote(julian, 'Ordner/N.md', 'x');
});

afterEach(async () => {
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('access changes are announced', () => {
  it('for every share mutation', async () => {
    const heard = vi.fn();
    runtime.shares.onChange(heard);

    const share = runtime.shares.grant(julian, 'Ordner', ramona, false);
    expect(heard).toHaveBeenCalledTimes(1);
    // A re-grant with a different right is an update, not a second row, and
    // still a change of access.
    runtime.shares.grant(julian, 'Ordner', ramona, true);
    expect(heard).toHaveBeenCalledTimes(2);
    runtime.shares.moveFolder(julian, 'Ordner', 'Neu');
    expect(heard).toHaveBeenCalledTimes(3);
    runtime.shares.revoke(share.id);
    expect(heard).toHaveBeenCalledTimes(4);

    await runtime.app.grantShare(julian, ramona, { kind: 'note', path: 'Ordner/N.md' }, false);
    expect(heard).toHaveBeenCalledTimes(5);
    runtime.shares.moveNote(julian, 'Ordner/N.md', 'Ordner/M.md');
    expect(heard).toHaveBeenCalledTimes(6);
    runtime.shares.dropNote(julian, 'Ordner/M.md');
    expect(heard).toHaveBeenCalledTimes(7);
    runtime.shares.dropFolder(julian, 'Neu');
    expect(heard).toHaveBeenCalledTimes(8);
  });

  it('for sessions and accounts', async () => {
    const sessions = vi.fn();
    const users = vi.fn();
    runtime.sessions.onChange(sessions);
    runtime.users.onChange(users);

    const { token } = runtime.sessions.create(ramona);
    // Creating a session grants nobody anything they did not have.
    expect(sessions).toHaveBeenCalledTimes(0);
    runtime.sessions.destroy(token);
    runtime.sessions.destroyAllFor(ramona);
    expect(sessions).toHaveBeenCalledTimes(2);

    runtime.users.setDisabled(ramona, true);
    expect(users).toHaveBeenCalledTimes(1);
    await runtime.users.setPassword(ramona, 'ein neues gutes passwort');
    expect(users).toHaveBeenCalledTimes(2);
  });

  it('stays silent for a binding, which changes no access', () => {
    const heard = vi.fn();
    runtime.shares.grant(julian, { kind: 'note', path: 'Ordner/N.md' }, ramona, true);
    runtime.shares.onChange(heard);
    runtime.shares.bindNote(julian, 'Ordner/N.md', 'Ordner/N.md', 'deadbeef');
    expect(heard).not.toHaveBeenCalled();
  });

  it('never fails the mutation, and still tells the other listeners', () => {
    const after = vi.fn();
    runtime.shares.onChange(() => {
      throw new Error('listener broke');
    });
    runtime.shares.onChange(after);
    expect(() => runtime.shares.grant(julian, 'Ordner', ramona, false)).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('forgets a listener that unsubscribed', () => {
    const heard = vi.fn();
    const off = runtime.shares.onChange(heard);
    off();
    runtime.shares.grant(julian, 'Ordner', ramona, false);
    expect(heard).not.toHaveBeenCalled();
  });
});
