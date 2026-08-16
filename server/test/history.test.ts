/**
 * Reading the vault's history sidecar, and putting a version back.
 *
 * The repository these tests build by hand is the same shape `vault-history.sh`
 * maintains on the host: one repository per owner, rooted at the vault, one
 * commit per tick. That has been running for weeks and holding real history
 * while nothing in the application could see it.
 *
 * The test that matters most is the tenant one. `git show <hash>:<path>` will
 * cheerfully hand back any object in the repository, so a commit id arriving
 * from a client is a way to address another vault's notes unless it is checked
 * against *this* note's own history first. That is the boundary the rest of the
 * server spends its time defending, and a subprocess is an easy place to lose it.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { SESSION_COOKIE, buildServer } from '../src/http/server.js';
import { LoginThrottle } from '../src/http/throttle.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import * as S from '../../shared/schema.js';

const run = promisify(execFile);

let dataDir: string;
let runtime: Runtime;
let server: FastifyInstance;
let cookie: string;

/** Commits whatever is in the vault right now, as the host timer would. */
async function commit(owner: string, subject: string): Promise<void> {
  const cwd = path.join(dataDir, 'vaults', owner);
  await run('git', ['add', '-A'], { cwd });
  await run('git', ['commit', '-m', subject, '--allow-empty'], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'ndBrain',
      GIT_AUTHOR_EMAIL: 'ndbrain@localhost',
      GIT_COMMITTER_NAME: 'ndBrain',
      GIT_COMMITTER_EMAIL: 'ndbrain@localhost',
    },
  });
}

async function initRepo(owner: string): Promise<void> {
  const cwd = path.join(dataDir, 'vaults', owner);
  await fs.mkdir(cwd, { recursive: true });
  await run('git', ['init', '-q', '-b', 'main'], { cwd });
  await run('git', ['config', 'user.email', 'ndbrain@localhost'], { cwd });
  await run('git', ['config', 'user.name', 'ndBrain'], { cwd });
}

async function signIn(user: string, password: string): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { user, password },
  });
  return `${SESSION_COOKIE}=${response.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-history-'));
  const config = { ...loadConfig(), dataDir, cookieSecure: false };
  runtime = await createRuntime(config);
  await runtime.users.create('julian', 'ein gutes passwort', { role: 'admin' });
  await runtime.users.create('ramona', 'ihr gutes passwort');

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

  cookie = await signIn('julian', 'ein gutes passwort');
});

afterEach(async () => {
  await server.close();
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('without a sidecar', () => {
  it('says there is no history rather than failing', async () => {
    // The ordinary state of a fresh install: the feature is absent, not broken.
    await runtime.app.createNote('julian', 'Neu.md', 'Erste Fassung.\n');

    const response = await server.inject({ url: '/api/v1/history/Neu.md', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    const parsed = S.HistoryResponse.parse(response.json());
    expect(parsed.available).toBe(false);
    expect(parsed.versions).toEqual([]);
  });
});

describe('with a sidecar', () => {
  beforeEach(async () => {
    await initRepo('julian');
    await runtime.app.createNote('julian', 'Notiz.md', 'Fassung eins.\n');
    await commit('julian', 'Vault-Stand 2026-08-13 21:05 · 1 geändert');
    await runtime.app.putNote('julian', 'Notiz.md', 'Fassung zwei.\n', 'julian');
    await commit('julian', 'Vault-Stand 2026-08-14 09:00 · 1 geändert');
    await runtime.app.putNote('julian', 'Notiz.md', 'Fassung drei.\n', 'julian');
    await commit('julian', 'Vault-Stand 2026-08-15 18:30 · 1 geändert');
  });

  it('lists the versions, newest first', async () => {
    const response = await server.inject({ url: '/api/v1/history/Notiz.md', headers: { cookie } });
    const parsed = S.HistoryResponse.parse(response.json());

    expect(parsed.available).toBe(true);
    expect(parsed.versions).toHaveLength(3);
    expect(parsed.versions[0]!.at).toBeGreaterThanOrEqual(parsed.versions[1]!.at);
  });

  it('keeps a subject that contains spaces in one piece', async () => {
    // The separator was written as a space at first, which would have split
    // "Vault-Stand 2026-08-13 21:05 · 1 geändert" into six fields and shifted
    // every version after it. Every subject this sidecar writes has spaces.
    const response = await server.inject({ url: '/api/v1/history/Notiz.md', headers: { cookie } });
    const parsed = S.HistoryResponse.parse(response.json());

    expect(parsed.versions[0]!.subject).toContain('Vault-Stand');
    expect(parsed.versions[0]!.subject).toContain('geändert');
    expect(parsed.versions[0]!.id).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reads one version back', async () => {
    const list = S.HistoryResponse.parse(
      (await server.inject({ url: '/api/v1/history/Notiz.md', headers: { cookie } })).json(),
    );
    const oldest = list.versions[list.versions.length - 1]!;

    const response = await server.inject({
      url: `/api/v1/history/Notiz.md?version=${oldest.id}`,
      headers: { cookie },
    });

    expect(S.VersionContentResponse.parse(response.json()).content).toBe('Fassung eins.\n');
  });

  it('lists only the versions that touched this note', async () => {
    await runtime.app.createNote('julian', 'Andere.md', 'Etwas anderes.\n');
    await commit('julian', 'Vault-Stand · 1 geändert');

    const response = await server.inject({ url: '/api/v1/history/Andere.md', headers: { cookie } });
    expect(S.HistoryResponse.parse(response.json()).versions).toHaveLength(1);
  });

  it('restores an old version as a new edit', async () => {
    const list = S.HistoryResponse.parse(
      (await server.inject({ url: '/api/v1/history/Notiz.md', headers: { cookie } })).json(),
    );
    const oldest = list.versions[list.versions.length - 1]!;

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/history/restore',
      headers: { cookie },
      payload: { owner: 'julian', path: 'Notiz.md', version: oldest.id },
    });

    expect(response.statusCode).toBe(200);
    expect(await runtime.app.notes.getNote('julian', 'Notiz.md')).toMatchObject({
      content: 'Fassung eins.\n',
    });

    // A restore is a write, so it is indexed like one — the old words are
    // findable again and the new ones are not.
    const search = await server.inject({ url: '/api/v1/search?q=eins', headers: { cookie } });
    expect(S.SearchResponse.parse(search.json()).hits.map((h) => h.path)).toContain('Notiz.md');
  });

  it('refuses a version id that belongs to a different note', async () => {
    await runtime.app.createNote('julian', 'Fremd.md', 'Andere Notiz.\n');
    await commit('julian', 'Vault-Stand · 1 geändert');

    const otherHistory = S.HistoryResponse.parse(
      (await server.inject({ url: '/api/v1/history/Fremd.md', headers: { cookie } })).json(),
    );

    // A real commit, just not one in this note's history. `git show <id>:<path>`
    // would happily resolve it; the check in `contentAt` is what stops it.
    const response = await server.inject({
      url: `/api/v1/history/Notiz.md?version=${otherHistory.versions[0]!.id}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses a made-up version id', async () => {
    const response = await server.inject({
      url: '/api/v1/history/Notiz.md?version=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('the tenant boundary', () => {
  beforeEach(async () => {
    await initRepo('julian');
    await runtime.app.createNote('julian', 'Privat.md', 'Nur für mich.\n');
    await commit('julian', 'Vault-Stand · 1 geändert');
  });

  it('hides another vault behind the same answer as a missing note', async () => {
    const hers = await signIn('ramona', 'ihr gutes passwort');

    const response = await server.inject({
      url: '/api/v1/history/Privat.md?owner=julian',
      headers: { cookie: hers },
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses a restore into a share that is read-only', async () => {
    runtime.shares.grant('julian', '', 'ramona', false);
    const hers = await signIn('ramona', 'ihr gutes passwort');

    const list = S.HistoryResponse.parse(
      (
        await server.inject({
          url: '/api/v1/history/Privat.md?owner=julian',
          headers: { cookie: hers },
        })
      ).json(),
    );

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/history/restore',
      headers: { cookie: hers },
      payload: { owner: 'julian', path: 'Privat.md', version: list.versions[0]!.id },
    });

    // Reading a shared note's history is allowed; rolling it back is not.
    expect(response.statusCode).toBe(404);
  });
});
