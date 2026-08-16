/**
 * The seam between the server and the browser.
 *
 * Both halves read `shared/schema.ts`, so these tests are about the half the
 * server owns: a request body that does not match its schema is refused with a
 * 400 that names the offending field, rather than being coerced into a default
 * and failing later for a reason that has nothing to do with the cause.
 *
 * The pulse test is here for a specific reason. The network view keys its nodes
 * by (owner, path) and read `event.owner`, which the server never sent — so the
 * key was always `"undefined …"`, no event ever matched a node, and the live
 * highlight had never once fired. Nothing caught it because the client cast the
 * response instead of checking it. This is the regression test for that.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { SESSION_COOKIE, buildServer } from '../src/http/server.js';
import { LoginThrottle } from '../src/http/throttle.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import * as S from '../../shared/schema.js';

let dataDir: string;
let runtime: Runtime;
let server: FastifyInstance;
let cookie: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-contract-'));
  const config = { ...loadConfig(), dataDir, cookieSecure: false };
  runtime = await createRuntime(config);
  await runtime.users.create('julian', 'ein gutes passwort', { role: 'admin' });

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

  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { user: 'julian', password: 'ein gutes passwort' },
  });
  cookie = `${SESSION_COOKIE}=${response.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});

afterEach(async () => {
  await server.close();
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('request validation', () => {
  it('names the field that was wrong', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: { cookie },
      payload: { path: 42 },
    });

    expect(response.statusCode).toBe(400);
    const problem = response.json() as { code: string; message: string };
    expect(problem.code).toBe('invalid_body');
    // The point of the exercise: the answer says *which* field and why.
    expect(problem.message).toContain('path');
  });

  it('refuses an unknown field rather than dropping it', async () => {
    // A typo in a field name used to be silently ignored, so a caller who wrote
    // `paths` for `path` got a confusing "name the folder" instead of the truth.
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: { cookie },
      payload: { path: 'Archive', pathh: 'typo' },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { code: string }).code).toBe('invalid_body');
  });

  it('still accepts a well-formed body', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: { cookie },
      payload: { path: 'Archive' },
    });

    expect(response.statusCode).toBe(201);
    expect(S.CreateFolderResponse.safeParse(response.json()).success).toBe(true);
  });

  it('rejects a bulk action it does not have', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/bulk',
      headers: { cookie },
      payload: { owner: 'julian', paths: ['a.md'], action: 'incinerate' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('does not let a schema failure become a 500', async () => {
    const response = await server.inject({
      method: 'PUT',
      url: '/api/v1/notes/Test.md',
      headers: { cookie },
      payload: { content: 123 },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('responses match the shared schema', () => {
  beforeEach(async () => {
    await runtime.app.createNote('julian', 'Eins.md', '---\ntags: [x]\n---\nSiehe [[Zwei]].\n');
    await runtime.app.createNote('julian', 'Zwei.md', '---\ntags: [x]\n---\nZurück zu [[Eins]].\n');
  });

  const cases: Array<[string, { safeParse: (v: unknown) => { success: boolean } }]> = [
    ['/api/v1/auth/me', S.MeResponse],
    ['/api/v1/tree', S.TreeResponse],
    ['/api/v1/overview', S.OverviewResponse],
    ['/api/v1/tidy', S.TidyResponse],
    ['/api/v1/graph', S.GraphResponse],
    ['/api/v1/tags', S.TagsResponse],
    ['/api/v1/shares', S.SharesResponse],
    ['/api/v1/pulse', S.PulseResponse],
    ['/api/v1/search?q=Siehe', S.SearchResponse],
    ['/api/v1/quickfind?q=Eins', S.QuickFindResponse],
    ['/api/v1/backlinks/Eins.md', S.LinksResponse],
  ];

  for (const [url, schema] of cases) {
    it(`${url} answers the shape the client expects`, async () => {
      const response = await server.inject({ url, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(schema.safeParse(response.json()).success).toBe(true);
    });
  }

  it('carries the owner on every pulse event', async () => {
    // Regression: the network view keys nodes by (owner, path). Without this
    // field every lookup was `"undefined …"` and no live event ever landed.
    await runtime.app.putNote('julian', 'Eins.md', 'geändert\n', 'julian');

    const response = await server.inject({ url: '/api/v1/pulse?since=1', headers: { cookie } });
    const parsed = S.PulseResponse.parse(response.json());

    expect(parsed.events.length).toBeGreaterThan(0);
    for (const event of parsed.events) {
      expect(event.owner).toBe('julian');
    }
  });
});
