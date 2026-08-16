import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { SESSION_COOKIE, buildServer } from '../src/http/server.js';
import { LoginThrottle } from '../src/http/throttle.js';
import { parseNote } from '../src/markdown/parse.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

let dataDir: string;
let runtime: Runtime;
let server: FastifyInstance;
let cookie: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-bulk-'));
  const config = { ...loadConfig(), dataDir, cookieSecure: false };
  runtime = await createRuntime(config);

  await runtime.users.create('julian', 'ein gutes passwort');
  await runtime.users.create('ramona', 'ihr gutes passwort');

  await runtime.app.createNote('julian', 'Inbox/Eins.md', '# Eins\n');
  await runtime.app.createNote('julian', 'Inbox/Zwei.md', '---\ntags: [alt]\n---\n# Zwei\n');
  await runtime.app.createNote('julian', 'Inbox/Drei.md', '# Drei\n');
  await runtime.app.createNote('julian', 'Verweis.md', 'Siehe [[Eins]] und [[Zwei]].\n');
  await runtime.app.createNote('ramona', 'Privat/Geheim.md', 'gehört Ramona\n');

  server = await buildServer({
    app: runtime.app,
    users: runtime.users,
    sessions: runtime.sessions,
    keys: runtime.keys,
    shares: runtime.shares,
    settings: runtime.settings,
    history: runtime.history,
    config,
    throttle: new LoginThrottle({ limit: 1000 }),
  });

  const login = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { user: 'julian', password: 'ein gutes passwort' },
  });
  const jar = login.cookies.find((c) => c.name === SESSION_COOKIE);
  cookie = `${jar?.name}=${jar?.value}`;
});

afterEach(async () => {
  await server.close();
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function bulk(payload: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/bulk',
    headers: { cookie },
    payload,
  });
  return { status: response.statusCode, body: response.json() };
}

async function read(owner: string, notePath: string): Promise<string> {
  return (await runtime.notes.getNote(owner, notePath)).content;
}

describe('bulk move', () => {
  it('moves a selection and rewrites the links that followed them', async () => {
    const { body } = await bulk({
      action: 'move',
      paths: ['Inbox/Eins.md', 'Inbox/Zwei.md'],
      dir: 'Homelab',
    });

    expect(body.ok.sort()).toEqual(['Homelab/Eins.md', 'Homelab/Zwei.md']);
    expect(body.failed).toEqual([]);

    // The links still resolve, which is the entire point of doing it here.
    expect(runtime.app.queries.deadLinks('julian')).toEqual([]);
    expect(await read('julian', 'Verweis.md')).toBe('Siehe [[Eins]] und [[Zwei]].\n');
  });

  it('moves to the vault root', async () => {
    const { body } = await bulk({ action: 'move', paths: ['Inbox/Eins.md'], dir: '' });
    expect(body.ok).toEqual(['Eins.md']);
  });

  it('reports the notes that failed and still does the rest', async () => {
    // A name collision at the target must not roll back the others.
    await runtime.app.createNote('julian', 'Homelab/Eins.md', 'schon da\n');

    const { body } = await bulk({
      action: 'move',
      paths: ['Inbox/Eins.md', 'Inbox/Zwei.md', 'Inbox/Drei.md'],
      dir: 'Homelab',
    });

    expect(body.ok.sort()).toEqual(['Homelab/Drei.md', 'Homelab/Zwei.md']);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].path).toBe('Inbox/Eins.md');
    expect(await read('julian', 'Homelab/Eins.md')).toBe('schon da\n');
  });

  it('treats a move to where it already is as a no-op', async () => {
    const { body } = await bulk({ action: 'move', paths: ['Inbox/Eins.md'], dir: 'Inbox' });
    expect(body.ok).toEqual(['Inbox/Eins.md']);
    expect(body.failed).toEqual([]);
  });

  it('prunes the folder it emptied', async () => {
    await bulk({
      action: 'move',
      paths: ['Inbox/Eins.md', 'Inbox/Zwei.md', 'Inbox/Drei.md'],
      dir: 'Archiv',
    });
    expect(await runtime.notes.listDirs('julian')).not.toContain('Inbox');
  });
});

describe('bulk tag', () => {
  it('tags a selection', async () => {
    const { body } = await bulk({
      action: 'tag',
      paths: ['Inbox/Eins.md', 'Inbox/Zwei.md'],
      tag: 'sortiert',
    });

    expect(body.failed).toEqual([]);
    expect(parseNote(await read('julian', 'Inbox/Eins.md')).tags).toEqual(['sortiert']);
    expect(parseNote(await read('julian', 'Inbox/Zwei.md')).tags).toEqual(['alt', 'sortiert']);
  });

  it('does not rewrite a note that already carries the tag', async () => {
    await bulk({ action: 'tag', paths: ['Inbox/Zwei.md'], tag: 'alt' });

    // Writing anyway would bump the modification date and make an untouched note
    // look edited in the overview.
    const activity = runtime.app.queries.activity('julian', 0);
    const entry = activity.find((row) => row.path === 'Inbox/Zwei.md');
    expect(entry?.edits).toBe(1); // only the original creation
  });

  it('removes a tag again', async () => {
    await bulk({ action: 'untag', paths: ['Inbox/Zwei.md'], tag: 'alt' });
    expect(parseNote(await read('julian', 'Inbox/Zwei.md')).tags).toEqual([]);
  });

  it('refuses an empty tag', async () => {
    const { status, body } = await bulk({ action: 'tag', paths: ['Inbox/Eins.md'], tag: '  ' });
    expect(status).toBe(400);
    expect(body.code).toBe('no_tag');
  });
});

describe('bulk delete', () => {
  it('deletes a selection and leaves the links dangling as findings', async () => {
    const { body } = await bulk({ action: 'delete', paths: ['Inbox/Eins.md', 'Inbox/Zwei.md'] });

    expect(body.ok.sort()).toEqual(['Inbox/Eins.md', 'Inbox/Zwei.md']);
    expect(runtime.app.queries.countNotes('julian')).toBe(2);
    // Deleting a target does not silently edit the notes that pointed at it —
    // the broken links are reported instead.
    expect(runtime.app.queries.deadLinks('julian')).toHaveLength(2);
  });

  it('reports a missing note without stopping', async () => {
    const { body } = await bulk({ action: 'delete', paths: ['Inbox/Eins.md', 'GibtsNicht.md'] });
    expect(body.ok).toEqual(['Inbox/Eins.md']);
    expect(body.failed).toHaveLength(1);
  });
});

describe('bulk operations respect the tenant boundary', () => {
  it.each(['move', 'tag', 'untag', 'delete'])('cannot touch a foreign note via %s', async (action) => {
    const { body } = await bulk({
      action,
      paths: ['Privat/Geheim.md'],
      dir: 'Geklaut',
      tag: 'x',
    });

    expect(body.ok).toEqual([]);
    expect(body.failed).toHaveLength(1);
    expect(await read('ramona', 'Privat/Geheim.md')).toBe('gehört Ramona\n');
  });

  it('cannot escape the vault with a traversing target folder', async () => {
    const { body } = await bulk({
      action: 'move',
      paths: ['Inbox/Eins.md'],
      dir: '../ramona/Privat',
    });

    expect(body.ok).toEqual([]);
    expect(body.failed).toHaveLength(1);
    expect(runtime.app.queries.countNotes('ramona')).toBe(1);
  });
});

describe('bulk request validation', () => {
  it('rejects an empty selection', async () => {
    const { status, body } = await bulk({ action: 'delete', paths: [] });
    expect(status).toBe(400);
    expect(body.code).toBe('no_selection');
  });

  it('rejects an unknown action', async () => {
    const { status, body } = await bulk({ action: 'sprengen', paths: ['Inbox/Eins.md'] });
    expect(status).toBe(400);
    expect(body.code).toBe('unknown_action');
  });

  it('announces the cap instead of silently truncating', async () => {
    const paths = Array.from({ length: 501 }, (_, i) => `N${i}.md`);
    const { status, body } = await bulk({ action: 'delete', paths });
    expect(status).toBe(400);
    expect(body.code).toBe('selection_too_large');
  });

  it('needs a session', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/bulk',
      payload: { action: 'delete', paths: ['Inbox/Eins.md'] },
    });
    expect(response.statusCode).toBe(401);
  });
});
