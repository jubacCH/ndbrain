/**
 * Activity per day: the numbers behind the home view's "today" and its
 * two-week trace.
 *
 * Two worlds throughout — Julian, who works, and Ramona, who holds a share of
 * his whole vault. A share lets her read his notes; it does not let her watch
 * him work, and asking about him must look exactly like asking about nobody.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { SESSION_COOKIE, buildServer, parseDayBounds, MAX_DAY_BOUNDS } from '../src/http/server.js';
import { dailyEditsSql } from '../src/index/queries.js';
import { LoginThrottle } from '../src/http/throttle.js';
import { TOOLS, type ToolContext } from '../src/mcp/tools.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import * as S from '../../shared/schema.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let dataDir: string;
let runtime: Runtime;
let server: FastifyInstance;
const cookies: Record<string, string> = {};

const tool = (name: string) => {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no such tool: ${name}`);
  return found;
};

function agentFor(owner: string, canWrite = true): ToolContext {
  const key = runtime.keys.create(owner, 'claude-code', { canWrite });
  return { app: runtime.app, keys: runtime.keys, key: runtime.keys.resolve(key.secret)! } as ToolContext;
}

/** Three days ending an hour from now: the last one holds everything the test does. */
function threeDays(): number[] {
  const end = Date.now() + 60 * 60 * 1000;
  return [end - 3 * DAY, end - 2 * DAY, end - DAY, end];
}

async function login(user: string, password: string): Promise<string> {
  const response = await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { user, password } });
  const jar = response.cookies.find((c) => c.name === SESSION_COOKIE);
  return `${jar?.name}=${jar?.value}`;
}

async function days(user: string, query: string): Promise<{ status: number; body: any }> {
  const response = await server.inject({
    url: `/api/v1/activity/days?${query}`,
    headers: { cookie: cookies[user] ?? '' },
  });
  return { status: response.statusCode, body: response.body === '' ? null : response.json() };
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-days-'));
  const config = { ...loadConfig(), dataDir, cookieSecure: false };
  runtime = await createRuntime(config);
  await runtime.users.create('julian', 'ein gutes passwort');
  await runtime.users.create('ramona', 'ihr gutes passwort');

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
    throttle: new LoginThrottle({ limit: 1000 }),
  });
  cookies['julian'] = await login('julian', 'ein gutes passwort');
  cookies['ramona'] = await login('ramona', 'ihr gutes passwort');
});

afterEach(async () => {
  await server.close();
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('counting a day', () => {
  it('counts notes, not saves: twenty autosaves are one note edited', async () => {
    await runtime.app.createNote('julian', 'Alt.md', 'x', 'julian');
    const bounds = [Date.now() + 1, Date.now() + DAY];
    await new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < 20; i += 1) await runtime.app.updateNote('julian', 'Alt.md', `Fassung ${i}`);

    const [today] = runtime.app.queries.dailyActivity('julian', bounds);
    expect(today).toMatchObject({ created: 0, edited: 1, touched: 1 });
  });

  it('counts a note created and then edited on the same day as new, not also as edited', async () => {
    const bounds = threeDays();
    await runtime.app.createNote('julian', 'Neu.md', 'x', 'julian');
    await runtime.app.updateNote('julian', 'Neu.md', 'y');
    await runtime.app.updateNote('julian', 'Neu.md', 'z');

    const result = runtime.app.queries.dailyActivity('julian', bounds);
    expect(result).toHaveLength(3);
    expect(result[2]).toMatchObject({ created: 1, edited: 0, touched: 1 });
  });

  it('puts each change into the day it happened in, and nothing outside the bounds', async () => {
    await runtime.app.createNote('julian', 'Vorher.md', 'x', 'julian');
    await new Promise((r) => setTimeout(r, 5));
    const start = Date.now();
    await runtime.app.createNote('julian', 'Heute.md', 'x', 'julian');

    const bounds = [start - 2 * DAY, start - DAY, start, start + DAY];
    const result = runtime.app.queries.dailyActivity('julian', bounds);
    // Vorher lies a few milliseconds before `start`, so in the day before it.
    expect(result.map((d) => d.created)).toEqual([0, 1, 1]);
    expect(result.map((d) => [d.start, d.end])).toEqual([
      [bounds[0], bounds[1]],
      [bounds[1], bounds[2]],
      [bounds[2], bounds[3]],
    ]);
  });

  it('counts deletes and renames on their own', async () => {
    await runtime.app.createNote('julian', 'Weg.md', 'x', 'julian');
    await runtime.app.createNote('julian', 'Alt.md', 'x', 'julian');
    const bounds = [Date.now() + 1, Date.now() + DAY];
    await new Promise((r) => setTimeout(r, 5));
    await runtime.app.deleteNote('julian', 'Weg.md');
    await runtime.app.renameNote('julian', 'Alt.md', 'Neu.md', { view: 'julian' });

    const [today] = runtime.app.queries.dailyActivity('julian', bounds);
    expect(today!.deleted).toBe(1);
    expect(today!.renamed).toBeGreaterThanOrEqual(1);
  });

  it('counts what agents read and wrote, and leaves out what they were refused', async () => {
    const bounds = threeDays();
    await runtime.app.createNote('julian', 'Homelab/Proxmox.md', '# Proxmox\n', 'julian');
    const agent = agentFor('julian');

    await tool('get_note').handler(agent, { path: 'Homelab/Proxmox.md' });
    await tool('search_notes').handler(agent, { query: 'proxmox' });
    await tool('append_note').handler(agent, { path: 'Homelab/Proxmox.md', content: 'Zusatz.' });
    // Refused: a key without write access tries a write, and a key scoped to
    // another folder tries a read. Both are logged, neither may be counted.
    await expect(
      tool('append_note').handler(agentFor('julian', false), { path: 'Homelab/Proxmox.md', content: 'Nein.' }),
    ).rejects.toThrow();
    const scoped = runtime.keys.create('julian', 'scoped', { scope: 'Privat/', canWrite: true });
    const scopedAgent = { app: runtime.app, keys: runtime.keys, key: runtime.keys.resolve(scoped.secret)! } as ToolContext;
    await expect(tool('get_note').handler(scopedAgent, { path: 'Homelab/Proxmox.md' })).rejects.toThrow();
    await expect(
      tool('append_note').handler(scopedAgent, { path: 'Homelab/Proxmox.md', content: 'Auch nicht.' }),
    ).rejects.toThrow();
    const refused = runtime.keys.recentAccess('julian', 50).filter((row) => !row.allowed);
    expect(refused.length).toBeGreaterThanOrEqual(3);

    const today = runtime.app.queries.dailyActivity('julian', bounds)[2]!;
    expect(today.agentReads).toBe(2);
    expect(today.agentWrites).toBe(1);
  });

  it('counts generated edits exactly as a plain count over the rows does, with no correlated scan', () => {
    // Five thousand edit rows written straight into the table: a fixture, not
    // a load test. Nothing here is timed; the plan is read instead.
    const start = Date.UTC(2026, 8, 1);
    const bounds = [start, start + DAY, start + 2 * DAY, start + 3 * DAY];
    const actions = ['create', 'update', 'update', 'update', 'delete', 'rename'] as const;
    let seed = 42;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const rows: Array<{ path: string; action: string; at: number }> = [];
    for (let k = 0; k < 5000; k += 1) {
      rows.push({
        path: `Generiert/Notiz ${next(400)}.md`,
        action: actions[next(actions.length)]!,
        // A little either side of the window, so the edges are exercised too.
        at: start - DAY / 4 + next(3.5 * DAY),
      });
    }
    runtime.db.transaction(() => {
      for (const row of rows) {
        runtime.db.run('INSERT INTO edits (owner, path, actor, action, at) VALUES (?, ?, ?, ?, ?)', 'julian', row.path, 'julian', row.action, row.at);
      }
    });

    const expected = [0, 1, 2].map((i) => {
      const inDay = rows.filter((r) => r.at >= bounds[i]! && r.at < bounds[i + 1]!);
      const byPath = new Map<string, Set<string>>();
      for (const r of inDay) byPath.set(r.path, (byPath.get(r.path) ?? new Set()).add(r.action));
      const all = [...byPath.values()];
      return {
        created: all.filter((a) => a.has('create')).length,
        edited: all.filter((a) => a.has('update') && !a.has('create')).length,
        deleted: all.filter((a) => a.has('delete')).length,
        renamed: all.filter((a) => a.has('rename')).length,
        touched: all.length,
      };
    });
    const result = runtime.app.queries.dailyActivity('julian', bounds).map(({ created, edited, deleted, renamed, touched }) => ({
      created,
      edited,
      deleted,
      renamed,
      touched,
    }));
    expect(result).toEqual(expected);
    expect(expected.every((d) => d.created > 0 && d.edited > 0 && d.touched > d.created)).toBe(true);

    const params = [...bounds.slice(0, -1).flatMap((lo, i) => [i, lo, bounds[i + 1]!]), 'julian'];
    const plan = runtime.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${dailyEditsSql(3)}`, ...params).map((r) => r.detail);
    expect(plan.some((d) => /USING INDEX edits_owner_at/.test(d))).toBe(true);
    expect(plan.filter((d) => /CORRELATED/.test(d))).toEqual([]);
  });

  it('answers an empty list for fewer than two bounds', () => {
    expect(runtime.app.queries.dailyActivity('julian', [])).toEqual([]);
    expect(runtime.app.queries.dailyActivity('julian', [Date.now()])).toEqual([]);
  });
});

describe('two worlds', () => {
  beforeEach(async () => {
    // Ramona may read Julian's whole vault.
    runtime.shares.grant('julian', '', 'ramona', false);
  });

  it('never counts activity from another vault, not even a shared one', async () => {
    const bounds = threeDays();
    await runtime.app.createNote('julian', 'Seins.md', 'x', 'julian');
    await tool('get_note').handler(agentFor('julian'), { path: 'Seins.md' });

    const hers = runtime.app.queries.dailyActivity('ramona', bounds);
    expect(hers.every((d) => d.touched === 0 && d.created === 0 && d.agentReads === 0)).toBe(true);
  });

  it('over HTTP, asking about somebody else looks exactly like asking about nobody', async () => {
    const bounds = threeDays().join(',');
    const before = await days('ramona', `bounds=${bounds}`);

    await runtime.app.createNote('julian', 'Seins.md', 'x', 'julian');
    await tool('get_note').handler(agentFor('julian'), { path: 'Seins.md' });

    const plain = await days('ramona', `bounds=${bounds}`);
    const aimed = await days('ramona', `bounds=${bounds}&owner=julian`);
    const unknown = await days('ramona', `bounds=${bounds}&owner=niemand`);

    expect(plain.status).toBe(200);
    expect(aimed).toEqual(plain);
    expect(unknown).toEqual(plain);
    expect(plain).toEqual(before);

    // And the owner does see it — the numbers exist, they are just not hers.
    const his = await days('julian', `bounds=${bounds}`);
    expect(his.body.days[2].created).toBe(1);
    expect(his.body.days[2].agentReads).toBe(1);
  });

  it('refuses without a session', async () => {
    const response = await server.inject({ url: `/api/v1/activity/days?bounds=${threeDays().join(',')}` });
    expect(response.statusCode).toBe(401);
  });

  it('answers the shape the client expects', async () => {
    const response = await days('julian', `bounds=${threeDays().join(',')}`);
    expect(S.ActivityDaysResponse.safeParse(response.body).success).toBe(true);
  });
});

describe('the bounds', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['one', '1000'],
    ['descending', '2000,1000'],
    ['repeated', '1000,1000'],
    ['not a number', '1000,abc'],
    ['negative', '-5,1000'],
    ['fractional', '1000.5,2000'],
    ['too many', Array.from({ length: MAX_DAY_BOUNDS + 1 }, (_, i) => String(1000 + i)).join(',')],
    ['a day of all time', '0,9000000000000000'],
    ['a day longer than 26 hours', `0,${26 * HOUR + 1}`],
    ['32 days of 26 hours, 33.6 days in all', Array.from({ length: 32 }, (_, i) => String(i * 26 * HOUR)).join(',')],
  ])('refuses %s bounds', (_name, raw) => {
    expect(parseDayBounds(raw)).toBeNull();
  });

  it('accepts ascending whole timestamps', () => {
    expect(parseDayBounds('1000,2000,3000')).toEqual([1000, 2000, 3000]);
  });

  it('accepts a day made long or short by a clock change, and a whole month', () => {
    expect(parseDayBounds(`0,${25 * HOUR},${48 * HOUR},${74 * HOUR}`)).toEqual([0, 25 * HOUR, 48 * HOUR, 74 * HOUR]);
    const month = Array.from({ length: 32 }, (_, i) => i * 24 * HOUR);
    expect(parseDayBounds(month.join(','))).toEqual(month);
  });

  it('answers 400 over HTTP for a window that covers everything', async () => {
    const response = await days('julian', 'bounds=0,9000000000000000');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('bad_bounds');
  });

  it('answers 400 over HTTP for bounds it cannot read', async () => {
    const response = await days('julian', 'bounds=2000,1000');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('bad_bounds');
  });
});
