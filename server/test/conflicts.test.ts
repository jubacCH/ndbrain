/**
 * Conflict copies as a tidy-up finding.
 *
 * `conflictPath` (`notes/service.ts`) keeps the version a concurrent write would
 * otherwise have lost, named `<name> (Konflikt YYYY-MM-DD HH.MM).md`. Nothing
 * reported these afterwards — one from 2026-08-17 sat unnoticed in a real vault
 * for weeks. This finding closes that gap the way `orphans`, `untagged`,
 * `deadLinks` and `stale` already do.
 *
 * Detection is not a second, hand-written pattern: `parseConflictPath` lives
 * right beside `conflictPath` in the same module, and the first block below
 * checks the two against each other directly — including the exact filenames a
 * production vault produced.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import { SESSION_COOKIE, buildServer } from '../src/http/server.js';
import { LoginThrottle } from '../src/http/throttle.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { conflictPath, parseConflictPath } from '../src/notes/service.js';

describe('conflictPath and parseConflictPath', () => {
  it('reads back exactly what conflictPath wrote', () => {
    const when = new Date(2026, 8, 11, 10, 58); // month is 0-based: 8 = September
    const copy = conflictPath('Projekt/Plan.md', when);
    expect(copy).toBe('Projekt/Plan (Konflikt 2026-09-11 10.58).md');

    const info = parseConflictPath(copy);
    expect(info).not.toBeNull();
    expect(info?.originalPath).toBe('Projekt/Plan.md');
    expect(info?.at).toBe(when.getTime());
  });

  it('round-trips a spread of moments, padding single digits both ways', () => {
    const moments = [
      new Date(2026, 0, 1, 0, 5),
      new Date(2026, 11, 31, 23, 59),
      new Date(2026, 5, 9, 9, 9),
    ];
    for (const when of moments) {
      const info = parseConflictPath(conflictPath('Notiz.md', when));
      expect(info?.originalPath).toBe('Notiz.md');
      expect(info?.at).toBe(when.getTime());
    }
  });

  it('recognises the two conflict copies a real vault actually produced', () => {
    // The dash here is a real U+2014 — part of the note's own naming convention
    // (MOCs are named "MOC — Thema"), not part of the conflict suffix. The
    // parser has to see through it rather than choke on it.
    const moc = '40_MOCs/MOC — Selfhosted Services (Konflikt 2026-08-17 10.29).md';
    const mocInfo = parseConflictPath(moc);
    expect(mocInfo).not.toBeNull();
    expect(mocInfo?.originalPath).toBe('40_MOCs/MOC — Selfhosted Services.md');
    expect(mocInfo?.at).toBe(new Date(2026, 7, 17, 10, 29).getTime());

    const backup = '20_Areas/21_Homelab/Backup (Konflikt 2026-09-11 10.58).md';
    const backupInfo = parseConflictPath(backup);
    expect(backupInfo).not.toBeNull();
    expect(backupInfo?.originalPath).toBe('20_Areas/21_Homelab/Backup.md');
    expect(backupInfo?.at).toBe(new Date(2026, 8, 11, 10, 58).getTime());
  });

  it('counts a second copy of the same minute up, and reads the count back', () => {
    const when = new Date(2026, 8, 22, 14, 7);
    expect(conflictPath('Projekt/Plan.md', when, 2)).toBe(
      'Projekt/Plan (Konflikt 2026-09-22 14.07-2).md',
    );

    const info = parseConflictPath(conflictPath('Projekt/Plan.md', when, 3));
    expect(info?.originalPath).toBe('Projekt/Plan.md');
    expect(info?.at).toBe(when.getTime());
    expect(info?.ordinal).toBe(3);
  });

  it('reads a name written before the count existed as the first of its minute', () => {
    // Every copy already lying in a vault has this shape. A name that stopped
    // parsing would disappear from the tidy-up view, and a conflict copy
    // nothing reports is the file somebody finds months later and cannot
    // explain — which is what the finding was built for in the first place.
    const info = parseConflictPath('20_Areas/21_Homelab/Backup (Konflikt 2026-09-11 10.58).md');
    expect(info?.originalPath).toBe('20_Areas/21_Homelab/Backup.md');
    expect(info?.ordinal).toBe(1);
  });

  it('refuses a count no name of its own would ever carry', () => {
    // The first copy of a minute has no suffix at all, so `-1` is not a name
    // this writes; neither is a padded or a zero one. Caught by the same round
    // trip that catches an impossible date: regenerate and compare.
    expect(parseConflictPath('Plan (Konflikt 2026-09-11 10.58-1).md')).toBeNull();
    expect(parseConflictPath('Plan (Konflikt 2026-09-11 10.58-0).md')).toBeNull();
    expect(parseConflictPath('Plan (Konflikt 2026-09-11 10.58-02).md')).toBeNull();
  });

  it('does not mistake an ordinary note for a conflict copy', () => {
    expect(parseConflictPath('Notes about a Konflikt in the team.md')).toBeNull();
    expect(parseConflictPath('Projekt/Plan.md')).toBeNull();
    // Close to the shape, but not it: no minute, and no zero-padded dot.
    expect(parseConflictPath('Plan (Konflikt 2026-09-11).md')).toBeNull();
    expect(parseConflictPath('Plan (Konflikt 2026-09-11 1058).md')).toBeNull();
  });

  it('refuses a calendar value that only looks like a date', () => {
    // `new Date` does not reject month 13 or day 45 — it rolls them over into a
    // real date the following year, which `conflictPath` would never have
    // written for that literal string. The round trip is what catches it: were
    // this accepted at face value, "gone" or "still there" would be answered
    // for a date that never existed rather than refused outright.
    expect(parseConflictPath('Plan (Konflikt 2026-13-45 99.99).md')).toBeNull();
    expect(parseConflictPath('Plan (Konflikt 2026-02-30 10.00).md')).toBeNull();
    expect(parseConflictPath('Plan (Konflikt 2026-00-01 10.00).md')).toBeNull();
  });
});

let dataDir: string;
let runtime: Runtime;
let server: FastifyInstance;
const cookies: Record<string, string> = {};

async function login(user: string, password: string): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { user, password },
  });
  const jar = response.cookies.find((c) => c.name === SESSION_COOKIE);
  return `${jar?.name}=${jar?.value}`;
}

async function as(
  user: string,
  options: { method?: string; url: string; payload?: unknown },
): Promise<{ status: number; body: any }> {
  const injection: InjectOptions = {
    method: (options.method ?? 'GET') as NonNullable<InjectOptions['method']>,
    url: options.url,
    headers: { cookie: cookies[user] ?? '' },
  };
  if (options.payload !== undefined) {
    injection.payload = options.payload as NonNullable<InjectOptions['payload']>;
  }
  const response = await server.inject(injection);
  return { status: response.statusCode, body: response.body === '' ? null : response.json() };
}

/** Directly plants a note shaped like a conflict copy, without the concurrency dance. */
async function plantConflict(owner: string, originalPath: string, when: Date): Promise<string> {
  const copyPath = conflictPath(originalPath, when);
  await runtime.app.createNote(owner, copyPath, 'Verdrängte Fassung\n', owner);
  return copyPath;
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-conflicts-'));
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

describe('the conflict-copy finding', () => {
  it('names the copy, the original it displaced, and that the original is still there', async () => {
    await runtime.app.createNote('julian', 'Projekt/Plan.md', '# Plan\n', 'julian');
    const when = new Date(2026, 8, 11, 10, 58);
    const copyPath = await plantConflict('julian', 'Projekt/Plan.md', when);

    const conflicts = runtime.app.queries.conflictCopies('julian');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      owner: 'julian',
      path: copyPath,
      originalPath: 'Projekt/Plan.md',
      originalTitle: 'Plan',
      originalExists: true,
    });
    expect(conflicts[0]?.at).toBe(when.getTime());
  });

  it('reports the original as gone once it really is, not as an error', async () => {
    // No "Projekt/Plan.md" is ever created — the copy is the only trace, the
    // way it looks once somebody has deleted the note it was measured against.
    await plantConflict('julian', 'Projekt/Plan.md', new Date(2026, 8, 11, 10, 58));

    const conflicts = runtime.app.queries.conflictCopies('julian');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.originalExists).toBe(false);
    expect(conflicts[0]?.originalTitle).toBeNull();
  });

  it('finds the original even when its own extension is not lowercase', async () => {
    // "Plan.MD" is a legal note here — `isNotePath` accepts any case — but
    // `conflictPath` strips an extension case-insensitively and always writes
    // the copy's own extension in lowercase, so `parseConflictPath` cannot
    // recover which case the original really had; it always guesses
    // lowercase. A case-sensitive existence lookup on that guess would then
    // call this original "gone" for no reason but a letter's case.
    await runtime.app.createNote('julian', 'Projekt/Plan.MD', '# Plan\n', 'julian');
    await plantConflict('julian', 'Projekt/Plan.MD', new Date(2026, 8, 11, 10, 58));

    const conflicts = runtime.app.queries.conflictCopies('julian');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.originalPath).toBe('Projekt/Plan.md');
    expect(conflicts[0]?.originalExists).toBe(true);
    expect(conflicts[0]?.originalTitle).toBe('Plan');
  });

  it('leaves an ordinary note that merely has "Konflikt" in its title alone', async () => {
    await runtime.app.createNote('julian', 'Notizen zum Konflikt im Team.md', 'Text\n', 'julian');

    expect(runtime.app.queries.conflictCopies('julian')).toHaveLength(0);
  });

  it('surfaces a copy a genuine concurrent write produced, not just a planted one', async () => {
    await runtime.app.createNote('julian', 'Projekt/Plan.md', 'Ursprung\n', 'julian');
    const before = await runtime.notes.getNote('julian', 'Projekt/Plan.md');

    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.app.updateNote('julian', 'Projekt/Plan.md', 'Anderswo geändert\n', 'julian');
    const result = await runtime.app.updateNote('julian', 'Projekt/Plan.md', 'Meine Fassung\n', 'julian', {
      baseMtimeMs: before.mtimeMs,
    });

    expect(result.conflictCopy).toBeDefined();
    const conflicts = runtime.app.queries.conflictCopies('julian');
    expect(conflicts.map((c) => c.path)).toContain(result.conflictCopy);
  });

  it('counts the copy once toward attention, however many other findings it also carries', async () => {
    // Untagged and orphaned as well as a conflict copy — three findings, one note.
    await plantConflict('julian', 'Verirrt.md', new Date(2026, 8, 11, 10, 58));

    expect(runtime.app.queries.attentionCount('julian')).toBe(1);
  });
});

/**
 * Two conflicts, one minute.
 *
 * The copy's name carries minutes and nothing finer on purpose: a person reads
 * it to decide which of two files to keep, and seconds would be noise. So two
 * conflicts of the same note inside one minute ask for the same name, and
 * `writeNote` replaces what is there — a conflict copy lost to a conflict copy,
 * which is the one file in the vault that nothing else holds a version of. The
 * clock going back an hour in autumn hands the same minute out a second time
 * for exactly the same reason.
 *
 * The clock is frozen here so the collision is certain rather than likely.
 * Only `Date` is faked; the timers the vault and the index run on are real.
 */
describe('two conflict copies in the same minute', () => {
  const MINUTE = new Date(2026, 8, 22, 14, 7, 30);

  /** Somebody else writes, and a tab holding `base` saves over them. */
  async function displace(base: string, byThem: string, byTheTab: string): Promise<string> {
    await runtime.app.updateNote('julian', 'Projekt/Plan.md', byThem, 'julian');
    const result = await runtime.app.updateNote('julian', 'Projekt/Plan.md', byTheTab, 'julian', {
      baseHash: base,
    });
    expect(result.conflictCopy).toBeDefined();
    return result.conflictCopy!;
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MINUTE);
    await runtime.app.createNote('julian', 'Projekt/Plan.md', 'Ursprung\n', 'julian');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps both, rather than the second overwriting the first', async () => {
    const firstTab = (await runtime.notes.getNote('julian', 'Projekt/Plan.md')).hash;
    const first = await displace(firstTab, 'Fassung von Anna\n', 'Erster Tab\n');

    const secondTab = (await runtime.notes.getNote('julian', 'Projekt/Plan.md')).hash;
    const second = await displace(secondTab, 'Fassung von Bruno\n', 'Zweiter Tab\n');

    expect(first).toBe('Projekt/Plan (Konflikt 2026-09-22 14.07).md');
    expect(second).toBe('Projekt/Plan (Konflikt 2026-09-22 14.07-2).md');
    expect((await runtime.notes.getNote('julian', first)).content).toBe('Fassung von Anna\n');
    expect((await runtime.notes.getNote('julian', second)).content).toBe('Fassung von Bruno\n');
  });

  it('steps past a name that is already taken, whatever put it there', async () => {
    // The autumn hour, a copy restored from a backup, a file somebody wrote by
    // hand: the question is only whether the name is free, not who took it.
    await runtime.app.createNote(
      'julian',
      conflictPath('Projekt/Plan.md', MINUTE),
      'Von vorhin\n',
      'julian',
    );

    const tab = (await runtime.notes.getNote('julian', 'Projekt/Plan.md')).hash;
    const copy = await displace(tab, 'Fassung von Anna\n', 'Erster Tab\n');

    expect(copy).toBe('Projekt/Plan (Konflikt 2026-09-22 14.07-2).md');
    expect(
      (await runtime.notes.getNote('julian', conflictPath('Projekt/Plan.md', MINUTE))).content,
    ).toBe('Von vorhin\n');
  });

  it('shows both copies in the tidy view, each against the note it displaced', async () => {
    const firstTab = (await runtime.notes.getNote('julian', 'Projekt/Plan.md')).hash;
    const first = await displace(firstTab, 'Fassung von Anna\n', 'Erster Tab\n');
    const secondTab = (await runtime.notes.getNote('julian', 'Projekt/Plan.md')).hash;
    const second = await displace(secondTab, 'Fassung von Bruno\n', 'Zweiter Tab\n');

    const conflicts = runtime.app.queries.conflictCopies('julian');
    expect(conflicts.map((c) => c.path).sort()).toEqual([first, second].sort());
    for (const row of conflicts) {
      expect(row.originalPath).toBe('Projekt/Plan.md');
      expect(row.originalExists).toBe(true);
      expect(row.at).toBe(new Date(2026, 8, 22, 14, 7).getTime());
    }
  });
});

describe('the conflict-copy finding through the API', () => {
  it('lists conflicts in /api/v1/tidy alongside the other findings', async () => {
    await runtime.app.createNote('julian', 'Projekt/Plan.md', '# Plan\n', 'julian');
    const copyPath = await plantConflict('julian', 'Projekt/Plan.md', new Date(2026, 8, 11, 10, 58));

    const { body } = await as('julian', { url: '/api/v1/tidy' });
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0].path).toBe(copyPath);
    expect(body.conflicts[0].originalExists).toBe(true);
    expect(body.totals.conflicts).toBe(1);
  });

  it('counts conflicts in the overview, folded into attention without double-counting', async () => {
    await plantConflict('julian', 'Verirrt.md', new Date(2026, 8, 11, 10, 58));

    const { body } = await as('julian', { url: '/api/v1/overview' });
    expect(body.counts.conflicts).toBe(1);
    expect(body.counts.attention).toBe(1);
  });

  it('deletes a conflict copy through the existing bulk action — no dedicated endpoint', async () => {
    await runtime.app.createNote('julian', 'Projekt/Plan.md', '# Plan\n', 'julian');
    const copyPath = await plantConflict('julian', 'Projekt/Plan.md', new Date(2026, 8, 11, 10, 58));

    const { status, body } = await as('julian', {
      method: 'POST',
      url: '/api/v1/bulk',
      payload: { paths: [copyPath], action: 'delete' },
    });

    expect(status).toBe(200);
    expect(body.ok).toEqual([copyPath]);
    expect(runtime.app.queries.conflictCopies('julian')).toHaveLength(0);
    // The original is untouched — only the copy was ever selected.
    expect((await runtime.notes.getNote('julian', 'Projekt/Plan.md')).content).toBe('# Plan\n');
  });
});

describe('a folder share and the conflict-copy finding', () => {
  beforeEach(async () => {
    await as('julian', {
      method: 'POST',
      url: '/api/v1/shares',
      payload: { grantee: 'ramona', prefix: 'Projekt', canWrite: true },
    });
  });

  it('shows a grantee a conflict copy that lies inside the shared folder', async () => {
    await runtime.app.createNote('julian', 'Projekt/Plan.md', '# Plan\n', 'julian');
    const copyPath = await plantConflict('julian', 'Projekt/Plan.md', new Date(2026, 8, 11, 10, 58));

    const view = runtime.shares.view('ramona');
    const conflicts = runtime.app.queries.conflictCopies(view);

    expect(conflicts.map((c) => c.path)).toContain(copyPath);
    const found = conflicts.find((c) => c.path === copyPath);
    expect(found?.originalExists).toBe(true);
  });

  /**
   * The critical case. Three leaks of exactly this shape were fixed in this
   * codebase on 2026-09-11: a finding that answered with paths, or with the
   * existence of something, beyond what the caller's view actually covers. A
   * conflict copy sitting in a folder Ramona was never given must not appear at
   * all in her view — not the path, not a count, nothing.
   */
  it('never lists a conflict copy from outside the shared folder', async () => {
    await runtime.app.createNote('julian', 'Privat/Tagebuch.md', 'geheim\n', 'julian');
    const hiddenCopy = await plantConflict('julian', 'Privat/Tagebuch.md', new Date(2026, 8, 11, 10, 58));

    const view = runtime.shares.view('ramona');
    const conflicts = runtime.app.queries.conflictCopies(view);

    expect(conflicts.map((c) => c.path)).not.toContain(hiddenCopy);
    expect(conflicts).toHaveLength(0);
  });

  it("does not leak Julian's conflicts into Ramona's own tidy view or overview", async () => {
    await runtime.app.createNote('julian', 'Projekt/Plan.md', '# Plan\n', 'julian');
    await plantConflict('julian', 'Projekt/Plan.md', new Date(2026, 8, 11, 10, 58));
    await runtime.app.createNote('julian', 'Privat/Tagebuch.md', 'geheim\n', 'julian');
    await plantConflict('julian', 'Privat/Tagebuch.md', new Date(2026, 8, 11, 10, 58));

    // The tidy-up view and the finding counts are the caller's own vault only —
    // the same product rule `orphans`/`untagged`/`stale` already follow, and it
    // holds here even for a folder Ramona genuinely has write access to.
    const tidy = await as('ramona', { url: '/api/v1/tidy' });
    expect(tidy.body.conflicts).toHaveLength(0);
    expect(tidy.body.totals.conflicts).toBe(0);

    const overview = await as('ramona', { url: '/api/v1/overview' });
    expect(overview.body.counts.conflicts).toBe(0);
  });

  it("leaves Julian's own view of his conflicts whole, share or not", async () => {
    await runtime.app.createNote('julian', 'Projekt/Plan.md', '# Plan\n', 'julian');
    await plantConflict('julian', 'Projekt/Plan.md', new Date(2026, 8, 11, 10, 58));
    await runtime.app.createNote('julian', 'Privat/Tagebuch.md', 'geheim\n', 'julian');
    await plantConflict('julian', 'Privat/Tagebuch.md', new Date(2026, 8, 11, 10, 58));

    const { body } = await as('julian', { url: '/api/v1/tidy' });
    expect(body.conflicts).toHaveLength(2);
  });
});
