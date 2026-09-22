import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/http/server.js';
import { DeletedNotes } from '../src/notes/deleted.js';
import { AGENT_READ_TOOLS, AGENT_WRITE_TOOLS } from '../src/index/queries.js';
import { TOOLS } from '../src/mcp/tools.js';
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
    db: runtime.db,
    users: runtime.users,
    sessions: runtime.sessions,
    keys: runtime.keys,
    shares: runtime.shares,
    settings: runtime.settings,
    history: runtime.history,
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
    // The tidying half of the surface. An agent that can only ever add makes
    // work nobody else asked for and cannot take part in clearing it up.
    expect(names).toContain('delete_note');
    expect(names).toContain('rename_note');

    for (const tool of body.result.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description.length).toBeGreaterThan(40);
      expect(typeof tool.annotations.readOnlyHint).toBe('boolean');
    }
  });

  it('publishes readOnlyHint and destructiveHint that match what each tool declares, not a blanket value', async () => {
    const { body } = await rpc(fullKey, 'tools/list');
    const published = new Map(
      body.result.tools.map((tool: { name: string; annotations: Record<string, unknown> }) => [
        tool.name,
        tool.annotations,
      ]),
    );

    // Checked against TOOLS itself, not a copy of the list kept here: a future
    // tool that forgets to think about `destructive` fails to compile (the
    // field is required), and this test then fails too if the endpoint ever
    // stops forwarding what the tool actually declared.
    expect(published.size).toBe(TOOLS.length);
    for (const tool of TOOLS) {
      const annotations = published.get(tool.name) as Record<string, unknown>;
      expect(annotations, `${tool.name} is missing from tools/list`).toBeDefined();
      expect(annotations['readOnlyHint'], `${tool.name}.readOnlyHint`).toBe(tool.readOnly);
      expect(annotations['destructiveHint'], `${tool.name}.destructiveHint`).toBe(tool.destructive);
    }
  });

/**
 * The pulse counts agent calls by naming the tools, in a list `queries.ts`
 * keeps by hand — it cannot import `TOOLS` without the index layer depending on
 * the MCP layer. A hand-kept copy of a list is a list that drifts, and the
 * drift is silent: a tool missing from it simply never shows up in "agent
 * reads today", which looks like an agent that did nothing. So the two halves
 * are checked against `TOOLS` itself here, where importing both is fine.
 */
it('counts every tool in the pulse, on the side the tool declares', () => {
  for (const tool of TOOLS) {
    const reads = (AGENT_READ_TOOLS as readonly string[]).includes(tool.name);
    const writes = (AGENT_WRITE_TOOLS as readonly string[]).includes(tool.name);

    expect(reads, `${tool.name} in AGENT_READ_TOOLS`).toBe(tool.readOnly);
    expect(writes, `${tool.name} in AGENT_WRITE_TOOLS`).toBe(!tool.readOnly);
  }
});

  it('marks exactly the tools that can remove content as destructive, not every writing tool', async () => {
    // The incident this guards against: `edit_note` deleted a span of a note
    // (frontmatter included) three times over, and a blanket `destructiveHint:
    // false` on all eight tools meant no MCP client had reason to ask first.
    // create_note refuses to touch an existing note and append_note is purely
    // additive, so neither belongs in this list. `rename_note` does: the note
    // survives, but every `[[…]]` naming the old path is rewritten, in notes
    // the call never named.
    const { body } = await rpc(fullKey, 'tools/list');
    const destructive = body.result.tools
      .filter((tool: { annotations: { destructiveHint: boolean } }) => tool.annotations.destructiveHint)
      .map((tool: { name: string }) => tool.name)
      .sort();

    expect(destructive).toEqual(['delete_note', 'edit_note', 'rename_note']);
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

  it('does not resolve a link that leaves its scope', async () => {
    // The link sits in a note the key may read, so the raw `[[…]]` is no secret.
    // What get_links adds is the *resolution* — and that is what the scope
    // withholds: an out-of-scope target is reported exactly as a target that
    // was never there.
    await runtime.app.createNote(
      'julian',
      'Homelab/Netzplan.md',
      'Siehe [[Privat/Gedanken]], [[Homelab/UniFi]] und [[Homelab/GibtsNicht]].\n',
    );

    const result = await call(scopedKey, 'get_links', { path: 'Homelab/Netzplan.md' });

    expect(result.text).not.toContain('Privat/Gedanken.md');
    expect(result.text).toContain('Privat/Gedanken — does not exist');
    // The scope must not blind the tool to what the key may see: a link inside
    // the scope keeps its path, and one that truly points nowhere stays
    // visible — dead links are a finding ndBrain reports on purpose.
    expect(result.text).toContain('Homelab/UniFi.md');
    expect(result.text).toContain('Homelab/GibtsNicht — does not exist');
  });

  it('answers the same for a target it may not see as for one that is not there', async () => {
    // Dropping the line instead of writing "does not exist" would leak the same
    // fact one step further back: a link that simply vanished says "this exists,
    // you may not see it". A writing key can ask that about any name it likes by
    // putting the name into a note of its own, which turns get_links into a free
    // existence oracle over the whole vault. Both answers must be one answer.
    await runtime.app.createNote('julian', 'Homelab/Frage A.md', 'Siehe [[Privat/Gedanken]].\n');
    await runtime.app.createNote('julian', 'Homelab/Frage B.md', 'Siehe [[Privat/Phantom]].\n');

    const existsOutside = await call(scopedKey, 'get_links', { path: 'Homelab/Frage A.md' });
    const neverExisted = await call(scopedKey, 'get_links', { path: 'Homelab/Frage B.md' });

    // Only the link text differs, and that text is the key's own question, not
    // an answer about the vault.
    expect(existsOutside.text.replace('Privat/Gedanken', 'X')).toBe(
      neverExisted.text.replace('Privat/Phantom', 'X'),
    );
    expect(existsOutside.text).not.toContain('Privat/Gedanken.md');
  });

  it('does not match a folder that merely starts the same', async () => {
    await runtime.app.createNote('julian', 'Homelab2/Fremd.md', 'nicht im scope\n');
    expect((await call(scopedKey, 'list_notes')).text).not.toContain('Homelab2/');
    expect((await call(scopedKey, 'get_note', { path: 'Homelab2/Fremd.md' })).isError).toBe(true);
  });

  /**
   * The map obeys the scope like every other tool.
   *
   * It was the one that wrote the rule out by hand instead of asking for it,
   * and it was also the one with no test behind it — so the copy could have
   * drifted from the original without a single case going red.
   */
  it('maps only what the scope covers', async () => {
    await runtime.app.createNote('julian', 'Homelab2/Fremd.md', 'nicht im scope\n');

    const { text } = await call(scopedKey, 'vault_map');

    expect(text).toContain('Homelab/Proxmox.md');
    expect(text).not.toContain('Privat/');
    expect(text).not.toContain('Homelab2/');
  });

  it('maps the whole vault for a key with no scope at all', async () => {
    const { text } = await call(fullKey, 'vault_map');
    expect(text).toContain('Homelab/Proxmox.md');
    expect(text).toContain('Privat/Gedanken.md');
  });
});

describe('read-only keys', () => {
  it.each([
    ['create_note', { path: 'Homelab/Neu.md', content: 'x' }],
    ['append_note', { path: 'Homelab/Proxmox.md', content: 'x' }],
    ['edit_note', { path: 'Homelab/Proxmox.md', find: 'Qdevice', replace: 'x' }],
    ['delete_note', { path: 'Homelab/Proxmox.md' }],
    ['rename_note', { from: 'Homelab/Proxmox.md', to: 'Homelab/Proxmox 2.md' }],
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

  it('leaves the note where it is', async () => {
    await call(readOnlyKey, 'delete_note', { path: 'Homelab/Proxmox.md' });
    await call(readOnlyKey, 'rename_note', { from: 'Homelab/Proxmox.md', to: 'Homelab/Weg.md' });

    expect((await runtime.notes.getNote('julian', 'Homelab/Proxmox.md')).content).toContain('Qdevice');
    await expect(runtime.notes.getNote('julian', 'Homelab/Weg.md')).rejects.toThrow();
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

/**
 * A note in the shape the vault migration produced: YAML frontmatter, the
 * blockquote header the importer writes, a title, then prose. Every part of the
 * head is something an edit in the body must not be able to reach.
 */
const MIGRATED_NOTE = [
  '---',
  'created: 2026-09-11',
  'updated: 2026-09-11',
  '---',
  '> **type:** project · **topic:** apps · **updated:** 2026-09-11',
  '',
  '# Slimvid',
  '',
  '## Stand',
  '',
  'Die App ist seit Juli im Store.',
  '',
  '## Fallen',
  '',
  'Der Build braucht einen EULA-Link.',
  '',
].join('\n');

/**
 * The note as it has to look after a targeted edit: the span replaced, every
 * other byte exactly where it was.
 *
 * Built from `indexOf` and `slice` rather than `String.replace`, so the
 * expectation cannot inherit the behaviour it is meant to check — `replace`
 * expands `$&` and friends in the replacement, and an expectation written with
 * it would agree with that corruption instead of catching it.
 */
function spliced(source: string, find: string, replace: string): string {
  const at = source.indexOf(find);
  return source.slice(0, at) + replace + source.slice(at + find.length);
}

describe('edit_note changes the span it was given and nothing else', () => {
  beforeEach(async () => {
    await runtime.app.createNote('julian', 'Projekte/Slimvid.md', MIGRATED_NOTE);
  });

  const read = async (): Promise<string> =>
    (await runtime.notes.getNote('julian', 'Projekte/Slimvid.md')).content;

  it('keeps the whole note byte-identical across two edits in a row', async () => {
    const first = {
      find: 'Die App ist seit Juli im Store.',
      replace: 'Die App ist seit Juli live.',
    };
    const firstResult = await call(fullKey, 'edit_note', { path: 'Projekte/Slimvid.md', ...first });
    expect(firstResult.isError).toBe(false);

    const afterFirst = spliced(MIGRATED_NOTE, first.find, first.replace);
    expect(await read()).toBe(afterFirst);

    const second = {
      find: 'Der Build braucht einen EULA-Link.',
      replace: 'Der Build braucht einen EULA-Link im Store-Eintrag.',
    };
    const secondResult = await call(fullKey, 'edit_note', { path: 'Projekte/Slimvid.md', ...second });
    expect(secondResult.isError).toBe(false);

    expect(await read()).toBe(spliced(afterFirst, second.find, second.replace));
  });

  it('writes a replacement containing $ verbatim', async () => {
    // `$&`, '$`', `$'` and `$$` are replacement patterns to String.replace, and
    // a vault full of shell snippets contains all of them. Expanded, they splice
    // the rest of the file into the note.
    const find = 'Der Build braucht einen EULA-Link.';
    const replace = "Der Build braucht `set -- $'\\n'`, `$$`, `$&` und '$`'.";

    const result = await call(fullKey, 'edit_note', { path: 'Projekte/Slimvid.md', find, replace });
    expect(result.isError).toBe(false);
    expect(await read()).toBe(spliced(MIGRATED_NOTE, find, replace));
  });
});

describe('tool arguments are held to the schema the server publishes', () => {
  beforeEach(async () => {
    await runtime.app.createNote('julian', 'Projekte/Slimvid.md', MIGRATED_NOTE);
  });

  const read = async (path: string): Promise<string> =>
    (await runtime.notes.getNote('julian', path)).content;

  it('refuses an argument the tool does not have, and names it', async () => {
    // What actually happened: an agent sent `new_string`, the name the editor
    // tool uses. `replace` was therefore absent, defaulted to the empty string,
    // and the found span — frontmatter and all — was deleted without a word.
    const result = await call(fullKey, 'edit_note', {
      path: 'Projekte/Slimvid.md',
      find: 'created: 2026-09-11\nupdated: 2026-09-11\n---',
      new_string: 'created: 2026-09-11\nupdated: 2026-09-11\ntags: [apps]\n---',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('new_string');
    expect(await read('Projekte/Slimvid.md')).toBe(MIGRATED_NOTE);
  });

  it('refuses a missing required argument rather than defaulting it', async () => {
    const result = await call(fullKey, 'edit_note', {
      path: 'Projekte/Slimvid.md',
      find: 'Die App ist seit Juli im Store.',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('replace');
    expect(await read('Projekte/Slimvid.md')).toBe(MIGRATED_NOTE);
  });

  it('refuses an argument of the wrong type rather than stringifying it', async () => {
    const result = await call(fullKey, 'edit_note', {
      path: 'Projekte/Slimvid.md',
      find: 'Die App ist seit Juli im Store.',
      replace: 42,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('replace');
    expect(await read('Projekte/Slimvid.md')).toBe(MIGRATED_NOTE);
  });

  it('deletes a span only when an empty replacement was actually asked for', async () => {
    const find = '\n## Fallen\n\nDer Build braucht einen EULA-Link.\n';
    const result = await call(fullKey, 'edit_note', {
      path: 'Projekte/Slimvid.md',
      find,
      replace: '',
    });

    expect(result.isError).toBe(false);
    expect(await read('Projekte/Slimvid.md')).toBe(spliced(MIGRATED_NOTE, find, ''));
  });

  it('does not create an empty note when create_note has no content', async () => {
    const result = await call(fullKey, 'create_note', { path: 'Projekte/Leer.md' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('content');
    await expect(runtime.notes.getNote('julian', 'Projekte/Leer.md')).rejects.toThrow();
  });

  it('does not touch a note when append_note has no content', async () => {
    const result = await call(fullKey, 'append_note', { path: 'Projekte/Slimvid.md' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('content');
    expect(await read('Projekte/Slimvid.md')).toBe(MIGRATED_NOTE);
  });

  it('still accepts every optional argument the schema declares', async () => {
    const result = await call(fullKey, 'search_notes', {
      query: 'Store',
      folder: 'Projekte',
      days: 1,
      limit: 5,
    });
    expect(result.isError).toBe(false);
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

  it('records a call the schema check refuses, not just ones a handler refuses', async () => {
    // A call rejected before the handler ever runs (a wrong argument name,
    // here) used to leave no trace: an agent that misused a tool this way was
    // invisible in the very log meant to catch misuse.
    const result = await call(fullKey, 'edit_note', {
      path: 'Homelab/Proxmox.md',
      find: 'Qdevice',
      new_string: 'x',
    });
    expect(result.isError).toBe(true);

    const entries = runtime.keys.recentAccess('julian');
    expect(entries.some((entry) => entry.tool === 'edit_note' && !entry.allowed)).toBe(true);
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

/* ---- tidying up -----------------------------------------------------------
 *
 * The surface could write notes and never remove one, so everything an agent
 * filed in the wrong place became handwork in the browser. These two close the
 * asymmetry, and each of them is a write that has to obey the scope on both the
 * path it names and the answer it gives back.
 */

describe('delete_note', () => {
  /** The same list the browser shows under "Recently deleted". */
  const recentlyDeleted = (): DeletedNotes =>
    new DeletedNotes(runtime.app, runtime.shares, runtime.history);

  it('deletes a note inside the scope', async () => {
    const result = await call(scopedKey, 'delete_note', { path: 'Homelab/UniFi.md' });

    expect(result.isError).toBe(false);
    await expect(runtime.notes.getNote('julian', 'Homelab/UniFi.md')).rejects.toThrow();
  });

  it('records the key as the actor, not the account', async () => {
    await call(fullKey, 'delete_note', { path: 'Homelab/UniFi.md' });

    const entry = runtime.app.queries
      .activity('julian', 0)
      .find((row) => row.path === 'Homelab/UniFi.md');
    expect(entry?.actor).toBe('agent-voll');
    expect(entry?.action).toBe('delete');
  });

  it('leaves the note in "Recently deleted" like every other delete', async () => {
    // The point of the whole tool: an agent that can delete but whose deletes
    // do not land in the 30-day list would close the way back for precisely the
    // cases where somebody reaches for it.
    await call(fullKey, 'delete_note', { path: 'Homelab/UniFi.md' });

    const listed = await recentlyDeleted().list('julian');
    const row = listed.find((note) => note.path === 'Homelab/UniFi.md');
    expect(row).toBeDefined();
    expect(row?.actor).toBe('agent-voll');
  });

  it('says whether the note can be brought back, rather than implying it can', async () => {
    // No history is kept in a test vault, which is also the state of a fresh
    // install — and a delete that promises a way back it does not have is worse
    // than one that says so.
    const result = await call(fullKey, 'delete_note', { path: 'Homelab/UniFi.md' });
    expect(result.text).toContain('cannot be brought back');
  });

  it('deletes a note the key never wrote', async () => {
    // Deliberate; see the tool's comment. `edits` cannot answer "who made this"
    // for a note that arrived as a file — the watcher and the startup sync
    // index without writing to it — so authorship is not a right anybody could
    // hold, and an authorship rule would refuse exactly the notes an agent is
    // asked to tidy.
    const result = await call(scopedKey, 'delete_note', { path: 'Homelab/Proxmox.md' });

    expect(result.isError).toBe(false);
    await expect(runtime.notes.getNote('julian', 'Homelab/Proxmox.md')).rejects.toThrow();
  });

  it('gives the same answer whether or not the note outside the scope is there', async () => {
    const whileItExists = await call(scopedKey, 'delete_note', { path: 'Privat/Gedanken.md' });
    // Removed by its owner, so nothing about the key's own state changed.
    await runtime.app.deleteNote('julian', 'Privat/Gedanken.md');
    const onceItIsGone = await call(scopedKey, 'delete_note', { path: 'Privat/Gedanken.md' });

    expect(whileItExists.isError).toBe(true);
    expect(whileItExists.text).toBe(onceItIsGone.text);
  });

  it('does not delete outside the scope', async () => {
    await call(scopedKey, 'delete_note', { path: 'Privat/Gedanken.md' });
    expect((await runtime.notes.getNote('julian', 'Privat/Gedanken.md')).content).toContain(
      'persönlich',
    );
  });

  it('cannot reach another vault', async () => {
    await call(fullKey, 'delete_note', { path: '../ramona/Ihres.md' });
    expect(runtime.app.queries.countNotes('ramona')).toBe(1);
  });

  it('records the refusal in the access log', async () => {
    await call(scopedKey, 'delete_note', { path: 'Privat/Gedanken.md' });
    const entries = runtime.keys.recentAccess('julian');
    expect(entries.some((entry) => entry.tool === 'delete_note' && !entry.allowed)).toBe(true);
  });
});

describe('rename_note', () => {
  it('renames inside the scope and carries the links with it', async () => {
    await runtime.app.createNote('julian', 'Homelab/Netzplan.md', 'Siehe [[Homelab/UniFi]].\n');

    const result = await call(scopedKey, 'rename_note', {
      from: 'Homelab/UniFi.md',
      to: 'Homelab/Netzwerk.md',
    });

    expect(result.isError).toBe(false);
    expect((await runtime.notes.getNote('julian', 'Homelab/Netzwerk.md')).content).toContain('Zonen');
    expect((await runtime.notes.getNote('julian', 'Homelab/Netzplan.md')).content).toContain(
      '[[Homelab/Netzwerk]]',
    );
    expect(result.text).toContain('Homelab/Netzplan.md');
  });

  it('records the key as the actor, not the account', async () => {
    await call(fullKey, 'rename_note', { from: 'Homelab/UniFi.md', to: 'Homelab/Netzwerk.md' });

    const entry = runtime.app.queries
      .activity('julian', 0)
      .find((row) => row.path === 'Homelab/Netzwerk.md');
    expect(entry?.actor).toBe('agent-voll');
    expect(entry?.action).toBe('rename');
  });

  it('rewrites a link outside the scope without naming the note it rewrote', async () => {
    // Both halves of one decision. The rewrite has to reach the whole vault or
    // the owner is left with a dead link in a note nobody touched — see the
    // tool's comment for why that is allowed. What the key is *told* obeys the
    // scope, exactly as every other list here does.
    await runtime.app.createNote('julian', 'Privat/Merkzettel.md', 'Siehe [[Homelab/UniFi]].\n');

    const result = await call(scopedKey, 'rename_note', {
      from: 'Homelab/UniFi.md',
      to: 'Homelab/Netzwerk.md',
    });

    expect(result.isError).toBe(false);
    expect((await runtime.notes.getNote('julian', 'Privat/Merkzettel.md')).content).toContain(
      '[[Homelab/Netzwerk]]',
    );
    expect(result.text).not.toContain('Privat');
    expect(result.text).not.toContain('Merkzettel');
  });

  it('names the rewritten notes to a key that may read them', async () => {
    // The other side of the same filter: bounded by the view, not switched off
    // and not thrown away.
    await runtime.app.createNote('julian', 'Privat/Merkzettel.md', 'Siehe [[Homelab/UniFi]].\n');

    const result = await call(fullKey, 'rename_note', {
      from: 'Homelab/UniFi.md',
      to: 'Homelab/Netzwerk.md',
    });

    expect(result.text).toContain('Privat/Merkzettel.md');
  });

  it('will not walk a note out of the scope', async () => {
    const result = await call(scopedKey, 'rename_note', {
      from: 'Homelab/UniFi.md',
      to: 'Privat/UniFi.md',
    });

    expect(result.isError).toBe(true);
    await expect(runtime.notes.getNote('julian', 'Privat/UniFi.md')).rejects.toThrow();
    expect((await runtime.notes.getNote('julian', 'Homelab/UniFi.md')).content).toContain('Zonen');
  });

  it('will not walk a note into the scope from outside it', async () => {
    const result = await call(scopedKey, 'rename_note', {
      from: 'Privat/Gedanken.md',
      to: 'Homelab/Gedanken.md',
    });

    expect(result.isError).toBe(true);
    await expect(runtime.notes.getNote('julian', 'Homelab/Gedanken.md')).rejects.toThrow();
    expect((await runtime.notes.getNote('julian', 'Privat/Gedanken.md')).content).toContain(
      'persönlich',
    );
  });

  it('gives the same answer whether or not the note outside the scope is there', async () => {
    const whileItExists = await call(scopedKey, 'rename_note', {
      from: 'Privat/Gedanken.md',
      to: 'Homelab/Gedanken.md',
    });
    await runtime.app.deleteNote('julian', 'Privat/Gedanken.md');
    const onceItIsGone = await call(scopedKey, 'rename_note', {
      from: 'Privat/Gedanken.md',
      to: 'Homelab/Gedanken.md',
    });

    expect(whileItExists.isError).toBe(true);
    expect(whileItExists.text).toBe(onceItIsGone.text);
  });

  it('refuses a name inside the scope that is already taken', async () => {
    // A name already taken is a refusal this key may hear, because it is a name
    // the key could have listed for itself.
    const taken = await call(scopedKey, 'rename_note', {
      from: 'Homelab/UniFi.md',
      to: 'Homelab/Proxmox.md',
    });

    expect(taken.isError).toBe(true);
    expect((await runtime.notes.getNote('julian', 'Homelab/UniFi.md')).content).toContain('Zonen');
  });

  it('cannot reach another vault', async () => {
    await call(fullKey, 'rename_note', { from: '../ramona/Ihres.md', to: 'Geklaut.md' });
    expect(runtime.app.queries.countNotes('ramona')).toBe(1);
    await expect(runtime.notes.getNote('julian', 'Geklaut.md')).rejects.toThrow();
  });
});

/* ---- a limit belongs after the scope, never before it ---------------------
 *
 * `vault_map` asked for the owner's whole vault, `ORDER BY path LIMIT 5000`,
 * and dropped the out-of-scope rows afterwards. A key scoped to a folder that
 * sorts late therefore got "No notes." on any vault past five thousand — and by
 * this file's own rule it could not tell that from a folder that is empty.
 * `search_notes` had the same shape, milder: it asked for three times the
 * limit, capped at 200, and filtered after.
 */
describe('the query cap is applied to what the key may see', () => {
  /**
   * Index rows without files behind them.
   *
   * Both tools read the index, never the vault, so this reproduces a large
   * vault at the only layer that matters — and does it in one transaction
   * rather than five thousand file writes.
   */
  function fillIndex(owner: string, prefix: string, count: number, mtimeMs: number): void {
    runtime.db.transaction(() => {
      for (let i = 0; i < count; i += 1) {
        const notePath = `${prefix}${String(i).padStart(5, '0')}.md`;
        runtime.db.run(
          `INSERT INTO notes (owner, path, title, path_key, title_key, size, mtime_ms, hash, indexed_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, '', 0)`,
          owner,
          notePath,
          'Füller',
          notePath.toLowerCase(),
          'füller',
          mtimeMs,
        );
      }
    });
  }

  let lateKey: string;

  beforeEach(async () => {
    await runtime.app.createNote('julian', 'Zzz/Spaet.md', '# Spät\n\nSpaetzuendung.\n');
    lateKey = runtime.keys.create('julian', 'agent-spaet', { scope: 'Zzz' }).secret;
  });

  it('maps a folder that sorts after five thousand other notes', async () => {
    fillIndex('julian', 'Aaa/', 5000, 1);

    const { text } = await call(lateKey, 'vault_map');

    expect(text).toContain('Zzz/Spaet.md');
    expect(text).not.toContain('Aaa/');
  });

  it('searches a folder that sorts after the rows the query asked for', async () => {
    // Newer than the note in the scope, so recency puts every filler row first.
    fillIndex('julian', 'Aaa/', 500, Date.now() + 60_000);

    const { text } = await call(lateKey, 'search_notes', { query: '' });

    expect(text).toContain('Zzz/Spaet.md');
    expect(text).not.toContain('Aaa/');
  });

  it('answers an empty folder and a forbidden one identically', async () => {
    fillIndex('julian', 'Aaa/', 10, 1);

    const empty = await call(lateKey, 'vault_map', { folder: 'Zzz/Leer' });
    const forbidden = await call(lateKey, 'vault_map', { folder: 'Privat' });

    expect(empty.text).toBe('No notes.');
    expect(forbidden.text).toBe(empty.text);
  });
});

/* ---- the open points -----------------------------------------------------
 *
 * `- [ ]` is indexed and the browser has a view of it, but an agent could not
 * see a single open point — it would have had to read whole notes and parse
 * them back out, which is the expensive thing `vault_map` exists to avoid.
 */
describe('list_tasks', () => {
  beforeEach(async () => {
    await runtime.app.createNote(
      'julian',
      'Homelab/Offen.md',
      '# Offen\n\n- [ ] Firmware aktualisieren\n- [x] Backup geprüft\n',
    );
    await runtime.app.createNote('julian', 'Privat/Vorhaben.md', '- [ ] Geheimes Vorhaben\n');
  });

  it('lists the open points with the note and the line they stand in', async () => {
    const { text, isError } = await call(fullKey, 'list_tasks');

    expect(isError).toBe(false);
    expect(text).toContain('Firmware aktualisieren');
    expect(text).toContain('Homelab/Offen.md:3');
  });

  it('leaves finished items out unless they are asked for', async () => {
    expect((await call(fullKey, 'list_tasks')).text).not.toContain('Backup geprüft');
    expect((await call(fullKey, 'list_tasks', { include_done: true })).text).toContain(
      'Backup geprüft',
    );
  });

  it('shows only what the scope covers', async () => {
    const { text } = await call(scopedKey, 'list_tasks');

    expect(text).toContain('Firmware aktualisieren');
    expect(text).not.toContain('Geheimes Vorhaben');
    expect(text).not.toContain('Privat/');
  });

  it('answers for a folder outside the scope exactly as for an empty one', async () => {
    const forbidden = await call(scopedKey, 'list_tasks', { folder: 'Privat' });
    const empty = await call(scopedKey, 'list_tasks', { folder: 'Homelab/Leer' });

    expect(forbidden.text).toBe('No open tasks.');
    expect(forbidden.text).toBe(empty.text);
  });

  it('says how many it left out rather than letting a cap look like the end', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `- [ ] Punkt ${i}`).join('\n');
    await runtime.app.createNote('julian', 'Homelab/Viele.md', `${many}\n`);

    const { text } = await call(scopedKey, 'list_tasks', { limit: 3 });

    expect(text.split('\n')).toHaveLength(4);
    expect(text).toContain('more');
  });

  it('is open to a read-only key', async () => {
    // Named, not just "no error": an unknown tool answers as a protocol error
    // rather than a tool result, so `isError` alone would pass before the tool
    // existed at all.
    const { text, isError } = await call(readOnlyKey, 'list_tasks');
    expect(isError).toBe(false);
    expect(text).toContain('Firmware aktualisieren');
  });
});

/* ---- the findings --------------------------------------------------------
 *
 * An agent could search, read, write, rename and delete, and see open points —
 * but not a single *finding*. So it could not be asked to clear up the broken
 * links, although it already held every tool for the job; it would have had to
 * read the whole vault back and work them out itself.
 *
 * Three kinds, and the choice is the point. A dead link, a note nothing points
 * at and a note without a tag are each fixable with one edit an agent can
 * actually make. Staleness is not: "untouched for 90 days" is a number for a
 * person to judge, and an agent "refreshing" old notes is the one thing it
 * must not do unasked. Conflict copies are not either — picking which of two
 * versions of somebody's own writing survives is a decision, not tidying.
 */
describe('list_findings', () => {
  beforeEach(async () => {
    // One tagged note, so being untagged is a convention here and therefore a
    // finding at all — see `untaggedFindings`.
    await runtime.app.createNote(
      'julian',
      'Homelab/Netz.md',
      '---\ntags: [homelab]\n---\n# Netz\n\nSiehe [[Homelab/UniFi]] und [[Nirgendwo]].\n',
    );
    await runtime.app.createNote('julian', 'Privat/Notiz.md', 'Siehe [[Privat/Phantom]].\n');
  });

  it('names the note to open for each kind of finding', async () => {
    const { text, isError } = await call(fullKey, 'list_findings');

    expect(isError).toBe(false);
    // The source note, not just the fact that something is broken: the agent
    // has to know which note to edit.
    expect(text).toContain('Homelab/Netz.md');
    expect(text).toContain('Nirgendwo');
    expect(text).toContain('Homelab/Proxmox.md');
    expect(text).toContain('dns01');
  });

  it('answers for one kind when asked for one', async () => {
    const { text } = await call(fullKey, 'list_findings', { kind: 'dead_links' });

    expect(text).toContain('Nirgendwo');
    expect(text).not.toContain('nothing links to');
    expect(text).not.toContain('without a tag');
  });

  it('refuses a kind it does not know, and says which it has', async () => {
    const { text, isError } = await call(fullKey, 'list_findings', { kind: 'stale' });

    expect(isError).toBe(true);
    expect(text).toContain('dead_links');
    expect(text).toContain('orphans');
    expect(text).toContain('untagged');
  });

  it('shows only what the scope covers', async () => {
    const { text } = await call(scopedKey, 'list_findings');

    expect(text).toContain('Homelab/Netz.md');
    expect(text).not.toContain('Privat/');
  });

  it('answers for a folder outside the scope exactly as for an empty one', async () => {
    const forbidden = await call(scopedKey, 'list_findings', { folder: 'Privat' });
    const empty = await call(scopedKey, 'list_findings', { folder: 'Homelab/Leer' });

    expect(forbidden.text).toBe('Nothing to tidy.');
    expect(forbidden.text).toBe(empty.text);
  });

  it('says how many it left out rather than letting a cap look like the end', async () => {
    for (let i = 0; i < 8; i += 1) {
      await runtime.app.createNote('julian', `Homelab/Kaputt ${i}.md`, `Siehe [[Fehlt ${i}]].\n`);
    }

    const { text } = await call(scopedKey, 'list_findings', { kind: 'dead_links', limit: 3 });

    expect(text).toContain('more');
    expect(text).not.toContain('Fehlt 7');
  });

  it('is open to a read-only key', async () => {
    const { text, isError } = await call(readOnlyKey, 'list_findings');
    expect(isError).toBe(false);
    expect(text).toContain('Nirgendwo');
  });

  /**
   * The oracle, shut.
   *
   * The indexer resolves a link against the owner's whole vault, so "this link
   * is broken" used to mean "nothing anywhere in the vault is called that". A
   * scoped key that may write could then ask about any name it liked: put
   * `[[Privat/Phantom]]` into a note of its own, call this, and read the answer
   * off whether the link came back. The same call, once while the guessed note
   * exists outside the scope and once while it does not, has to produce the
   * very same bytes — anything else is that oracle.
   */
  it('answers byte for byte the same whether the guessed name exists outside the scope or not', async () => {
    await runtime.app.createNote('julian', 'Homelab/Koeder.md', 'Siehe [[Privat/Phantom]].\n');

    const before = await call(scopedKey, 'list_findings');

    await runtime.app.createNote('julian', 'Privat/Phantom.md', 'jetzt gibt es mich\n');

    const after = await call(scopedKey, 'list_findings');

    expect(after.text).toBe(before.text);
    // Not "answers nothing at all": the link text is the key's own question,
    // written in a note it may read, so echoing it back is no leak — and the
    // resolved path, which would be one, never appears.
    expect(before.text).toContain('Privat/Phantom');
    expect(before.text).not.toContain('Privat/Phantom.md');
  });
});
