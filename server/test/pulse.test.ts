/**
 * The pulse: what is happening in the vault right now.
 *
 * Exists so the graph view can show where an agent is working. Reads are the
 * point — a read leaves no trace anywhere else, because reading a note changes
 * nothing, so without the access log there is simply no way to know an agent
 * looked at something.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { TOOLS, type ToolContext } from '../src/mcp/tools.js';

let dataDir: string;
let runtime: Runtime;
let agent: ToolContext;

const tool = (name: string) => {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no such tool: ${name}`);
  return found;
};

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-pulse-'));
  runtime = await createRuntime({ ...loadConfig(), dataDir });
  await runtime.users.create('julian', 'ein gutes passwort');

  const key = runtime.keys.create('julian', 'claude-code', { canWrite: true });
  agent = {
    app: runtime.app,
    keys: runtime.keys,
    key: runtime.keys.resolve(key.secret)!,
  } as ToolContext;

  await runtime.app.createNote('julian', 'Homelab/Proxmox.md', '# Proxmox\n\nZwei Nodes.\n');
});

afterEach(async () => {
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('the pulse', () => {
  it('reports what a person changed', async () => {
    const from = Date.now() - 1000;
    await runtime.app.putNote('julian', 'Homelab/Proxmox.md', 'geändert\n', 'julian');

    const events = runtime.app.queries.pulse('julian', from);
    const write = events.find((e) => e.path === 'Homelab/Proxmox.md' && e.kind === 'write');

    expect(write).toBeDefined();
    expect(write!.who).toBe('julian');
    expect(write!.agent).toBe(false);
  });

  /** The whole reason this endpoint exists. */
  it('reports that an agent read a note, which nothing else records', async () => {
    const from = Date.now() - 1000;
    await tool('get_note').handler(agent, { path: 'Homelab/Proxmox.md' });

    const events = runtime.app.queries.pulse('julian', from);
    const read = events.find((e) => e.kind === 'read');

    expect(read).toBeDefined();
    expect(read!.what).toBe('get_note');
    expect(read!.path).toBe('Homelab/Proxmox.md');
    expect(read!.who).toBe('claude-code');
    expect(read!.agent).toBe(true);
  });

  /**
   * An agent write lands in both logs. Taking writes from both would show every
   * agent edit twice, which would read as twice the activity.
   */
  it('does not report an agent write twice', async () => {
    // Erst abwarten: eine Sekunde Rückblick fing sonst noch das Anlegen aus dem
    // beforeEach mit ein, und zwei Ereignisse hätten wie ein Duplikat ausgesehen.
    await new Promise((r) => setTimeout(r, 20));
    const from = Date.now();
    await new Promise((r) => setTimeout(r, 20));
    await tool('append_note').handler(agent, { path: 'Homelab/Proxmox.md', content: 'Zusatz.' });

    const events = runtime.app.queries.pulse('julian', from);
    const forNote = events.filter((e) => e.path === 'Homelab/Proxmox.md');

    expect(forNote.filter((e) => e.kind === 'write')).toHaveLength(1);
    expect(forNote.filter((e) => e.kind === 'read')).toHaveLength(0);
  });

  it('carries activity that belongs to no single note', async () => {
    const from = Date.now() - 1000;
    await tool('search_notes').handler(agent, { query: 'proxmox' });

    const events = runtime.app.queries.pulse('julian', from);
    const search = events.find((e) => e.what === 'search_notes');

    expect(search).toBeDefined();
    expect(search!.path).toBeNull();
  });

  it('leaves out what an agent was refused', async () => {
    const from = Date.now() - 1000;
    await expect(
      tool('get_note').handler(agent, { path: 'GibtEsNicht.md' }),
    ).rejects.toThrow();

    const events = runtime.app.queries.pulse('julian', from);
    expect(events.filter((e) => e.path === 'GibtEsNicht.md')).toEqual([]);
  });

  it('only returns what happened after the given moment', async () => {
    await runtime.app.putNote('julian', 'Homelab/Proxmox.md', 'alt\n', 'julian');
    const between = Date.now() + 1;
    await new Promise((r) => setTimeout(r, 20));
    await runtime.app.putNote('julian', 'Homelab/Proxmox.md', 'neu\n', 'julian');

    expect(runtime.app.queries.pulse('julian', between)).toHaveLength(1);
  });

  it('returns the newest first', async () => {
    const from = Date.now() - 1000;
    await runtime.app.createNote('julian', 'Erste.md', 'a', 'julian');
    await new Promise((r) => setTimeout(r, 20));
    await runtime.app.createNote('julian', 'Zweite.md', 'b', 'julian');

    const events = runtime.app.queries.pulse('julian', from);
    expect(events[0]!.path).toBe('Zweite.md');
  });

  /**
   * Deliberately the caller's own vault only. When somebody works, how often and
   * on what is information about *them*, and sharing a folder is not consent to
   * being watched.
   */
  it('never shows activity from another vault, not even a shared one', async () => {
    await runtime.users.create('ramona', 'ihr gutes passwort');
    runtime.shares.grant('ramona', '', 'julian', false);

    const from = Date.now() - 1000;
    await runtime.app.createNote('ramona', 'Ihres.md', 'x', 'ramona');

    const events = runtime.app.queries.pulse('julian', from);
    expect(events.filter((e) => e.path === 'Ihres.md')).toEqual([]);
  });
});
