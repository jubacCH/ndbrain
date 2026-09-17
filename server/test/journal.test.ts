/**
 * Daily notes, as far as the server is concerned.
 *
 * The server has no idea what a daily note is for; it knows two things about
 * one. Creating it has to be idempotent — a button, a shortcut and a second tab
 * may all ask for today's note in the same second, and none of them may
 * overwrite what the first one's person typed or leave a conflict copy. And the
 * links it is born with, to yesterday and tomorrow, must not count against the
 * vault as broken before those days are written.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addDays,
  dailyNoteTemplate,
  dayHeading,
  isDailyNote,
  isPendingDayLink,
  journalPath,
  parseIsoDate,
  parseJournalLinkTarget,
  parseJournalPath,
  weekdayIndex,
} from '../../shared/journal.js';
import { loadConfig } from '../src/config.js';
import { SESSION_COOKIE, buildServer } from '../src/http/server.js';
import { LoginThrottle } from '../src/http/throttle.js';
import { parseNote } from '../src/markdown/parse.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

const TODAY = { year: 2026, month: 9, day: 17 };
const TODAY_PATH = '50_Journal/2026/09/2026-09-17.md';

describe('the journal pattern', () => {
  it('puts a day under its year and month', () => {
    expect(journalPath(TODAY)).toBe(TODAY_PATH);
    expect(journalPath({ year: 2027, month: 1, day: 3 })).toBe('50_Journal/2027/01/2027-01-03.md');
  });

  it('reads back only the exact shape it writes', () => {
    expect(parseJournalPath(TODAY_PATH)).toEqual(TODAY);
    // Filed under the wrong month: a note somebody put there, not the day's note.
    expect(parseJournalPath('50_Journal/2026/10/2026-09-17.md')).toBeNull();
    expect(parseJournalPath('50_Journal/2026-09-17.md')).toBeNull();
    expect(parseJournalPath('50_Journal/52_Meetings/2026-09-17.md')).toBeNull();
    expect(parseJournalPath('Archiv/50_Journal/2026/09/2026-09-17.md')).toBeNull();
    // A day that does not exist is not a day.
    expect(parseJournalPath('50_Journal/2026/02/2026-02-30.md')).toBeNull();
    expect(parseJournalPath('50_Journal/2028/02/2028-02-29.md')).toEqual({ year: 2028, month: 2, day: 29 });
    expect(parseIsoDate('2026-13-01')).toBeNull();
  });

  it('recognises a day link in the path form and the bare form', () => {
    expect(parseJournalLinkTarget('50_Journal/2026/09/2026-09-16')).toEqual({ year: 2026, month: 9, day: 16 });
    expect(parseJournalLinkTarget('50_Journal/2026/09/2026-09-16.md')).toEqual({ year: 2026, month: 9, day: 16 });
    expect(parseJournalLinkTarget('2026-09-16')).toEqual({ year: 2026, month: 9, day: 16 });
    expect(parseJournalLinkTarget('Proxmox')).toBeNull();
    expect(parseJournalLinkTarget('2026-09-31')).toBeNull();
  });

  it('forgives a link into the void only inside a daily note, and only to a day', () => {
    expect(isPendingDayLink(TODAY_PATH, '50_Journal/2026/09/2026-09-18')).toBe(true);
    expect(isPendingDayLink(TODAY_PATH, 'Gibt Es Nicht')).toBe(false);
    expect(isPendingDayLink('10_Projects/Plan.md', '2026-09-18')).toBe(false);
  });

  it('counts days by the calendar across months, years and leap days', () => {
    expect(addDays({ year: 2026, month: 9, day: 30 }, 1)).toEqual({ year: 2026, month: 10, day: 1 });
    expect(addDays({ year: 2027, month: 1, day: 1 }, -1)).toEqual({ year: 2026, month: 12, day: 31 });
    expect(addDays({ year: 2028, month: 2, day: 28 }, 1)).toEqual({ year: 2028, month: 2, day: 29 });
    // Across both daylight saving changes in Switzerland.
    expect(addDays({ year: 2026, month: 3, day: 28 }, 1)).toEqual({ year: 2026, month: 3, day: 29 });
    expect(addDays({ year: 2026, month: 3, day: 29 }, 1)).toEqual({ year: 2026, month: 3, day: 30 });
    expect(addDays({ year: 2026, month: 10, day: 25 }, -1)).toEqual({ year: 2026, month: 10, day: 24 });
  });

  it('writes the heading in German, whatever the interface speaks', () => {
    // 17 September 2026 is a Thursday (the example in the brief said Wednesday).
    expect(weekdayIndex(TODAY)).toBe(3);
    expect(dayHeading(TODAY)).toBe('Donnerstag, 17. September 2026');
    expect(dayHeading({ year: 2026, month: 3, day: 1 })).toBe('Sonntag, 1. März 2026');
  });

  it('starts a note in the form the vault rules ask for', () => {
    const text = dailyNoteTemplate(TODAY);
    expect(text).toBe(
      [
        '---',
        'created: 2026-09-17',
        'updated: 2026-09-17',
        'tags: [journal]',
        '---',
        '> **type:** log · **topic:** journal · **src:** manual · **updated:** 2026-09-17',
        '',
        '# Donnerstag, 17. September 2026',
        '',
        '← [[50_Journal/2026/09/2026-09-16|2026-09-16]] · [[50_Journal/2026/09/2026-09-18|2026-09-18]] →',
        '',
        '## Notizen',
        '',
        '## Aufgaben',
        '- [ ]',
        '',
        '## Links',
        '',
      ].join('\n'),
    );

    const parsed = parseNote(text);
    expect(parsed.tags).toEqual(['journal']);
    // The unwritten task line is not an open task.
    expect(parsed.tasks).toHaveLength(0);
    expect(parsed.wikilinks.map((link) => link.target)).toEqual([
      '50_Journal/2026/09/2026-09-16',
      '50_Journal/2026/09/2026-09-18',
    ]);
  });
});

let dataDir: string;
let runtime: Runtime;
let server: FastifyInstance;
let julian: string;
let ramona: string;

async function login(user: string, password: string): Promise<string> {
  const response = await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { user, password } });
  const jar = response.cookies.find((c) => c.name === SESSION_COOKIE);
  return `${jar?.name}=${jar?.value}`;
}

function ensure(cookie: string, notePath: string, content: string, extra: Record<string, unknown> = {}) {
  return server.inject({
    method: 'PUT',
    url: `/api/v1/notes/${notePath}`,
    headers: { cookie },
    payload: { content, ifAbsent: true, ...extra },
  });
}

async function vaultFiles(owner: string): Promise<string[]> {
  const root = path.join(dataDir, 'vaults', owner);
  const entries = await fs.readdir(root, { recursive: true });
  return entries.map(String).filter((entry) => entry.endsWith('.md')).sort();
}

interface Counts {
  notes: number;
  orphans: number;
  untagged: number;
  deadLinks: number;
  attention: number;
}

async function counts(): Promise<Counts> {
  const response = await server.inject({ url: '/api/v1/overview', headers: { cookie: julian } });
  return response.json().counts as Counts;
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-journal-'));
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

  julian = await login('julian', 'ein gutes passwort');
  ramona = await login('ramona', 'ihr gutes passwort');
});

afterEach(async () => {
  await server.close();
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('creating a note only if it is absent', () => {
  it('creates the note and the folders it needs', async () => {
    const response = await ensure(julian, TODAY_PATH, dailyNoteTemplate(TODAY));

    expect(response.statusCode).toBe(201);
    expect(response.json().created).toBe(true);
    expect((await runtime.app.notes.getNote('julian', TODAY_PATH)).content).toBe(dailyNoteTemplate(TODAY));
  });

  it('opens what is there instead of writing over it', async () => {
    await ensure(julian, TODAY_PATH, dailyNoteTemplate(TODAY));
    // Somebody writes into it in one tab…
    await runtime.app.putNote('julian', TODAY_PATH, 'Was heute geschah.\n', 'julian');
    const before = await runtime.app.notes.getNote('julian', TODAY_PATH);

    // …while another tab, still thinking the day is empty, asks for it again.
    const again = await ensure(julian, TODAY_PATH, dailyNoteTemplate(TODAY), { baseMtimeMs: 1 });

    expect(again.statusCode).toBe(200);
    expect(again.json().created).toBe(false);
    expect(again.json().conflictCopy).toBeUndefined();
    expect(again.json().note.content).toBe('Was heute geschah.\n');
    const after = await runtime.app.notes.getNote('julian', TODAY_PATH);
    expect(after.content).toBe('Was heute geschah.\n');
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await vaultFiles('julian')).toEqual([path.join('50_Journal', '2026', '09', '2026-09-17.md')]);
  });

  it('writes exactly once when many ask at the same moment', async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) => ensure(julian, TODAY_PATH, `${dailyNoteTemplate(TODAY)}<!-- ${i} -->\n`)),
    );

    const created = responses.filter((r) => r.json().created === true);
    expect(created).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(5);

    // Every caller got the one note that was written, not its own version.
    const winner = created[0]!.json().note.content as string;
    for (const response of responses) expect(response.json().note.content).toBe(winner);
    expect(await vaultFiles('julian')).toEqual([path.join('50_Journal', '2026', '09', '2026-09-17.md')]);
  });

  it('logs a create once, not once per click', async () => {
    await ensure(julian, TODAY_PATH, dailyNoteTemplate(TODAY));
    await ensure(julian, TODAY_PATH, dailyNoteTemplate(TODAY));
    await ensure(julian, TODAY_PATH, dailyNoteTemplate(TODAY));

    const pulse = await server.inject({ url: '/api/v1/pulse', headers: { cookie: julian } });
    const writes = (pulse.json().events as Array<{ path: string | null; kind: string }>).filter(
      (event) => event.path === TODAY_PATH && event.kind === 'write',
    );
    expect(writes).toHaveLength(1);
  });

  it('refuses a name that differs only in letter case from an existing note', async () => {
    await runtime.app.createNote('julian', '50_Journal/2026/09/Notiz.md', 'x');
    const response = await ensure(julian, '50_Journal/2026/09/notiz.md', 'y');
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('case_collision');
  });

  it('is held to the same permission as any other write', async () => {
    // Read-only share: the grantee may look, not create.
    runtime.shares.grant('julian', '50_Journal', 'ramona', false);
    const response = await ensure(ramona, `${TODAY_PATH}?owner=julian`, 'nope');
    // Refused the way every write outside a share is refused.
    expect([403, 404]).toContain(response.statusCode);
    expect(await vaultFiles('julian')).toEqual([]);
  });
});

describe('findings around daily notes', () => {
  beforeEach(async () => {
    // A small vault with its own honest findings, so the comparison below has a
    // baseline to stay equal to rather than a row of zeros.
    await runtime.app.createNote('julian', 'Hub.md', '---\ntags: [x]\n---\nSiehe [[Proxmox]] und [[Fehlt]].\n');
    await runtime.app.createNote('julian', 'Proxmox.md', '---\ntags: [x]\n---\nZurück zu [[Hub]].\n');
    await runtime.app.createNote('julian', 'Allein.md', '---\ntags: [x]\n---\nNichts verweist hierher.\n');
  });

  it('leaves every finding as it was when a daily note with empty neighbours arrives', async () => {
    const before = await counts();
    expect(before.deadLinks).toBe(1);
    expect(before.orphans).toBe(1);

    await ensure(julian, TODAY_PATH, dailyNoteTemplate(TODAY));
    const after = await counts();

    expect(after.notes).toBe(before.notes + 1);
    expect(after.deadLinks).toBe(before.deadLinks);
    expect(after.orphans).toBe(before.orphans);
    expect(after.untagged).toBe(before.untagged);
    expect(after.attention).toBe(before.attention);

    const tidy = (await server.inject({ url: '/api/v1/tidy', headers: { cookie: julian } })).json();
    expect(tidy.deadLinks.map((l: { source: string }) => l.source)).toEqual(['Hub.md']);
    expect(tidy.orphans.map((n: { path: string }) => n.path)).not.toContain(TODAY_PATH);
  });

  it('links yesterday and tomorrow by path once they exist', async () => {
    const yesterday = addDays(TODAY, -1);
    await ensure(julian, journalPath(yesterday), dailyNoteTemplate(yesterday));
    await ensure(julian, TODAY_PATH, dailyNoteTemplate(TODAY));
    // A note with the same title nearer the top of the vault: the shortest-path
    // rule would pick it for a bare [[2026-09-16]].
    await runtime.app.createNote('julian', '2026-09-16.md', 'Ein Irrläufer.\n');

    const links = (
      await server.inject({ url: `/api/v1/backlinks/${TODAY_PATH}`, headers: { cookie: julian } })
    ).json();
    const outgoing = links.outgoing as Array<{ targetRaw: string; targetPath: string | null }>;
    expect(outgoing.map((l) => l.targetPath)).toEqual([journalPath(yesterday), null]);
  });

  it('still reports a real broken link inside a daily note', async () => {
    await ensure(julian, TODAY_PATH, `${dailyNoteTemplate(TODAY)}Siehe [[Tippfehler]] und [[2026-09-31]].\n`);
    const tidy = (await server.inject({ url: '/api/v1/tidy', headers: { cookie: julian } })).json();
    const mine = (tidy.deadLinks as Array<{ source: string; targetRaw: string }>).filter((l) => l.source === TODAY_PATH);
    expect(mine.map((l) => l.targetRaw).sort()).toEqual(['2026-09-31', 'Tippfehler']);
  });

  it('still reports a date link outside the journal as broken', async () => {
    await runtime.app.createNote('julian', 'Plan.md', '---\ntags: [x]\n---\nAm [[2026-09-18]] und [[Hub]].\n');
    const c = await counts();
    expect(c.deadLinks).toBe(2);
  });

  it('never reports an old day as untouched, while an old ordinary note still is', async () => {
    const lastSpring = { year: 2026, month: 3, day: 2 };
    const dayPath = journalPath(lastSpring);
    await ensure(julian, dayPath, dailyNoteTemplate(lastSpring));
    await runtime.app.createNote('julian', 'Alt.md', '---\ntags: [x]\n---\nSiehe [[Hub]].\n');
    // Both last touched half a year ago.
    const old = new Date(2026, 2, 2, 20, 0);
    for (const p of [dayPath, 'Alt.md']) {
      await fs.utimes(path.join(dataDir, 'vaults', 'julian', p), old, old);
      await runtime.indexer.indexNote('julian', p);
    }

    const tidy = (await server.inject({ url: '/api/v1/tidy', headers: { cookie: julian } })).json();
    const stale = (tidy.stale as Array<{ path: string }>).map((n) => n.path);
    expect(stale).toContain('Alt.md');
    expect(stale).not.toContain(dayPath);
    expect(tidy.totals.stale).toBe(stale.length);
    expect((await counts()).attention).toBeGreaterThan(0);
    const overview = (await server.inject({ url: '/api/v1/overview', headers: { cookie: julian } })).json();
    expect(overview.counts.stale).toBe(stale.length);
  });

  it('does not treat a mis-filed day as a daily note', async () => {
    const misfiled = '50_Journal/2026/10/2026-09-17.md';
    await runtime.app.createNote('julian', misfiled, dailyNoteTemplate(TODAY));
    const tidy = (await server.inject({ url: '/api/v1/tidy', headers: { cookie: julian } })).json();
    expect((tidy.deadLinks as Array<{ source: string }>).filter((l) => l.source === misfiled)).toHaveLength(2);
    expect((tidy.orphans as Array<{ path: string }>).map((n) => n.path)).toContain(misfiled);
    expect(isDailyNote(misfiled)).toBe(false);
    expect(isDailyNote(TODAY_PATH)).toBe(true);
  });
});
