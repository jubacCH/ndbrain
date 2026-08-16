import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/http/server.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

let dataDir: string;
let runtime: Runtime;
let server: FastifyInstance;
let fullKey: string;
let readOnlyKey: string;
let scopedKey: string;
let ramonaKey: string;

/** One JSON-RPC round trip. */
async function rpc(secret: string, method: string, params?: unknown): Promise<any> {
  const response = await server.inject({
    method: 'POST',
    url: '/mcp',
    headers: { authorization: `Bearer ${secret}` },
    payload: { jsonrpc: '2.0', id: 1, method, params },
  });
  return { status: response.statusCode, body: response.body === '' ? null : response.json() };
}

/** Calls a tool and returns its text, whether it succeeded or failed. */
async function call(secret: string, name: string, args: Record<string, unknown> = {}): Promise<{
  text: string;
  isError: boolean;
}> {
  const { body } = await rpc(secret, 'tools/call', { name, arguments: args });
  return {
    text: body.result?.content?.[0]?.text ?? JSON.stringify(body.error),
    isError: body.result?.isError === true,
  };
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-mcp-'));
  const config = { ...loadConfig(), dataDir, cookieSecure: false };
  runtime = await createRuntime(config);

  await runtime.users.create('julian', 'ein gutes passwort');
  await runtime.users.create('ramona', 'ihr gutes passwort');

  await runtime.app.createNote('julian', 'Homelab/Proxmox.md', '# Proxmox\n\nQdevice auf [[dns01]].\n');
  await runtime.app.createNote('julian', 'Homelab/UniFi.md', '# UniFi\n\nZonen und Regeln.\n');
  await runtime.app.createNote('julian', 'Privat/Gedanken.md', '# Gedanken\n\nsehr persönlich\n');
  await runtime.app.createNote('ramona', 'Ihres.md', 'gehört Ramona\n');

  fullKey = runtime.keys.create('julian', 'agent-voll', { canWrite: true }).secret;
  readOnlyKey = runtime.keys.create('julian', 'agent-lesend').secret;
  scopedKey = runtime.keys.create('julian', 'agent-homelab', {
    scope: 'Homelab',
    canWrite: true,
  }).secret;
  ramonaKey = runtime.keys.create('ramona', 'ihr-agent', { canWrite: true }).secret;

  server = await buildServer({
    app: runtime.app,
    users: runtime.users,
    sessions: runtime.sessions,
    keys: runtime.keys,
    shares: runtime.shares,
    settings: runtime.settings,
    config,
  });
});

afterEach(async () => {
  await server.close();
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('protocol', () => {
  it('completes the handshake', async () => {
    const { body } = await rpc(fullKey, 'initialize');
    expect(body.result.protocolVersion).toBeTruthy();
    expect(body.result.serverInfo.name).toBe('ndbrain');
  });

  it('lists tools with schemas a client can actually use', async () => {
    const { body } = await rpc(fullKey, 'tools/list');
    const names = body.result.tools.map((tool: { name: string }) => tool.name);

    expect(names).toContain('search_notes');
    expect(names).toContain('get_note');
    expect(names).toContain('create_note');
    // Deleting is deliberately not exposed: an agent should not be able to lose
    // a note in a single call.
    expect(names).not.toContain('delete_note');

    for (const tool of body.result.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description.length).toBeGreaterThan(40);
      expect(typeof tool.annotations.readOnlyHint).toBe('boolean');
    }
  });

  it('answers ping and rejects unknown methods', async () => {
    expect((await rpc(fullKey, 'ping')).body.result).toEqual({});
    expect((await rpc(fullKey, 'gibtsnicht')).body.error.code).toBe(-32601);
  });

  it('does not pretend to stream', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/mcp',
      headers: { authorization: `Bearer ${fullKey}` },
    });
    expect(response.statusCode).toBe(405);
  });
});

describe('authentication', () => {
  it.each([
    ['no header', undefined],
    ['empty bearer', 'Bearer '],
    ['made-up key', 'Bearer ndb_0000000000000000000000000000000000000000000000000000000000000000'],
    ['not even our prefix', 'Bearer sk-something-else'],
    ['cookie instead of bearer', 'Cookie ndbrain_session=x'],
  ])('refuses %s', async (_label, authorization) => {
    const response = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: authorization === undefined ? {} : { authorization },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('stops working the moment the key is revoked', async () => {
    const { key, secret } = runtime.keys.create('julian', 'kurzlebig');
    expect((await rpc(secret, 'ping')).status).toBe(200);

    runtime.keys.revoke(key.id);

    expect((await rpc(secret, 'ping')).status).toBe(401);
  });

  it('records when a key was last used', async () => {
    const { key, secret } = runtime.keys.create('julian', 'benutzt');
    expect(runtime.keys.get(key.id)?.lastUsedAt).toBeNull();

    await rpc(secret, 'ping');

    expect(runtime.keys.get(key.id)?.lastUsedAt).not.toBeNull();
  });
});

describe('a key can never see more than its owner', () => {
  it('reads and searches only the owner\'s vault', async () => {
    expect((await call(fullKey, 'get_note', { path: 'Ihres.md' })).isError).toBe(true);
    expect((await call(fullKey, 'search_notes', { query: 'Ramona' })).text).toBe('No matching notes.');
    expect((await call(fullKey, 'list_notes')).text).not.toContain('Ihres.md');
  });

  it('cannot traverse out of the vault', async () => {
    const result = await call(fullKey, 'get_note', { path: '../ramona/Ihres.md' });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain('Ramona');
  });

  it('writes only into the owner\'s vault', async () => {
    await call(fullKey, 'create_note', { path: '../ramona/Eingeschleust.md', content: 'x' });
    expect(runtime.app.queries.countNotes('ramona')).toBe(1);
  });

  it('keeps two owners\' keys apart', async () => {
    expect((await call(ramonaKey, 'list_notes')).text).toBe('Ihres.md');
    expect((await call(ramonaKey, 'get_note', { path: 'Homelab/Proxmox.md' })).isError).toBe(true);
  });
});

describe('scope narrows further, never wider', () => {
  it('reads inside its scope', async () => {
    const result = await call(scopedKey, 'get_note', { path: 'Homelab/Proxmox.md' });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('Qdevice');
  });

  it('reports a note outside its scope as simply missing', async () => {
    // Not "forbidden" — telling a scoped agent that something exists but is off
    // limits hands it a map of what it cannot see.
    const outside = await call(scopedKey, 'get_note', { path: 'Privat/Gedanken.md' });
    const missing = await call(scopedKey, 'get_note', { path: 'Homelab/GibtsNicht.md' });

    expect(outside.isError).toBe(true);
    expect(outside.text).toBe(missing.text);
    expect(outside.text).not.toContain('persönlich');
  });

  it('hides out-of-scope notes from listing and search', async () => {
    expect((await call(scopedKey, 'list_notes')).text).not.toContain('Privat/');
    expect((await call(scopedKey, 'search_notes', { query: 'persönlich' })).text).toBe(
      'No matching notes.',
    );
  });

  it('cannot write outside its scope', async () => {
    await call(scopedKey, 'create_note', { path: 'Privat/Eingeschleust.md', content: 'x' });
    expect(runtime.app.queries.getNote('julian', 'julian', 'Privat/Eingeschleust.md')).toBeUndefined();
  });

  it('does not match a folder that merely starts the same', async () => {
    await runtime.app.createNote('julian', 'Homelab2/Fremd.md', 'nicht im scope\n');
    expect((await call(scopedKey, 'list_notes')).text).not.toContain('Homelab2/');
    expect((await call(scopedKey, 'get_note', { path: 'Homelab2/Fremd.md' })).isError).toBe(true);
  });
});

describe('read-only keys', () => {
  it.each([
    ['create_note', { path: 'Homelab/Neu.md', content: 'x' }],
    ['append_note', { path: 'Homelab/Proxmox.md', content: 'x' }],
    ['edit_note', { path: 'Homelab/Proxmox.md', find: 'Qdevice', replace: 'x' }],
  ])('refuses %s', async (tool, args) => {
    const result = await call(readOnlyKey, tool, args);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('read-only');
  });

  it('still reads', async () => {
    expect((await call(readOnlyKey, 'get_note', { path: 'Homelab/Proxmox.md' })).isError).toBe(false);
  });

  it('leaves the note untouched', async () => {
    await call(readOnlyKey, 'append_note', { path: 'Homelab/Proxmox.md', content: 'angehängt' });
    const note = await runtime.notes.getNote('julian', 'Homelab/Proxmox.md');
    expect(note.content).not.toContain('angehängt');
  });
});

describe('writing tools', () => {
  it('creates a note and attributes it to the key', async () => {
    const result = await call(fullKey, 'create_note', {
      path: 'Homelab/Neu.md',
      content: '# Neu\n\nvom Agenten\n',
    });
    expect(result.isError).toBe(false);

    const activity = runtime.app.queries.activity('julian', 0);
    expect(activity.find((row) => row.path === 'Homelab/Neu.md')?.actor).toBe('agent-voll');
  });

  it('appends with a blank line, without doubling one that is there', async () => {
    await call(fullKey, 'append_note', { path: 'Homelab/UniFi.md', content: 'Nachtrag.' });
    const note = await runtime.notes.getNote('julian', 'Homelab/UniFi.md');

    expect(note.content).toBe('# UniFi\n\nZonen und Regeln.\n\nNachtrag.');
  });

  it('refuses to create over an existing note', async () => {
    const result = await call(fullKey, 'create_note', {
      path: 'Homelab/Proxmox.md',
      content: 'überschrieben',
    });
    expect(result.isError).toBe(true);
    expect((await runtime.notes.getNote('julian', 'Homelab/Proxmox.md')).content).toContain('Qdevice');
  });

  it('edits an unambiguous match', async () => {
    const result = await call(fullKey, 'edit_note', {
      path: 'Homelab/Proxmox.md',
      find: 'Qdevice auf [[dns01]]',
      replace: 'Qdevice auf [[dns02]]',
    });
    expect(result.isError).toBe(false);
    expect((await runtime.notes.getNote('julian', 'Homelab/Proxmox.md')).content).toContain('dns02');
  });

  it('refuses an ambiguous edit rather than guessing', async () => {
    await runtime.app.createNote('julian', 'Homelab/Doppelt.md', 'wert\nwert\n');

    const result = await call(fullKey, 'edit_note', {
      path: 'Homelab/Doppelt.md',
      find: 'wert',
      replace: 'anders',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('2 times');
    // Nothing was changed — a "replace the first match" fallback would have
    // silently edited the wrong line.
    expect((await runtime.notes.getNote('julian', 'Homelab/Doppelt.md')).content).toBe('wert\nwert\n');
  });

  it('refuses an edit whose text is not there', async () => {
    const result = await call(fullKey, 'edit_note', {
      path: 'Homelab/Proxmox.md',
      find: 'kommt nicht vor',
      replace: 'x',
    });
    expect(result.isError).toBe(true);
  });
});

describe('reading tools', () => {
  it('searches with filters', async () => {
    expect((await call(fullKey, 'search_notes', { query: 'Zonen' })).text).toContain('UniFi');
    expect((await call(fullKey, 'search_notes', { query: 'gibtsnicht' })).text).toBe('No matching notes.');
  });

  it('shows links, including the ones pointing nowhere', async () => {
    const result = await call(fullKey, 'get_links', { path: 'Homelab/Proxmox.md' });
    expect(result.text).toContain('dns01');
    expect(result.text).toContain('does not exist');
  });

  it('lists under one folder', async () => {
    const result = await call(fullKey, 'list_notes', { folder: 'Privat' });
    expect(result.text).toBe('Privat/Gedanken.md');
  });
});

describe('the access log', () => {
  it('records allowed and refused calls', async () => {
    await call(fullKey, 'get_note', { path: 'Homelab/Proxmox.md' });
    await call(scopedKey, 'get_note', { path: 'Privat/Gedanken.md' });

    const entries = runtime.keys.recentAccess('julian');
    expect(entries.some((entry) => entry.tool === 'get_note' && entry.allowed)).toBe(true);
    expect(entries.some((entry) => entry.tool === 'get_note' && !entry.allowed)).toBe(true);
  });

  it('is scoped to the owner', async () => {
    await call(ramonaKey, 'list_notes');
    expect(runtime.keys.recentAccess('julian')).toHaveLength(0);
    expect(runtime.keys.recentAccess('ramona')).toHaveLength(1);
  });
});

describe('error messages do not leak internals', () => {
  it('never reveals a filesystem path', async () => {
    for (const args of [{ path: '../../etc/passwd' }, { path: 'Fehlt.md' }, { path: 'bild.png' }]) {
      const result = await call(fullKey, 'get_note', args);
      expect(result.text.toLowerCase()).not.toContain(dataDir.toLowerCase().slice(0, 12));
      expect(result.text).not.toContain('vaults');
      expect(result.text).not.toMatch(/at [A-Za-z]+ \(/);
    }
  });
});
