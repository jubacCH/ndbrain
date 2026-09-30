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
import { Writable } from 'node:stream';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { HistoryUnreadableError } from '../src/errors.js';
import { SESSION_COOKIE, buildServer } from '../src/http/server.js';
import { LoginThrottle } from '../src/http/throttle.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { History } from '../src/vault/history.js';
import { startHarness } from './support/harness.js';
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
    expect(parsed.state).toBe('none');
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

  /**
   * A rename must not be where a note's past stops.
   *
   * `git log -- <path>` walks only the commits that touched that exact name, so
   * after a rename it finds the one commit that created the new name and the
   * note reads as written today. The versions are all still in the repository;
   * nothing is lost but the way to ask for them, and the answer looks exactly
   * like a note with no history — the failure mode this whole file is about.
   *
   * `--follow` is what asks across the rename. It works on one path only, which
   * is what this method passes, and it relies on git's rename detection: a
   * rename that also rewrites most of the content is not recognised, and then
   * the history genuinely does start over. That is a limit of the detection,
   * not of the question being asked.
   */
  it('keeps the versions when the note is renamed', async () => {
    const renamed = await server.inject({
      method: 'POST',
      url: '/api/v1/rename',
      headers: { cookie },
      payload: { from: 'Notiz.md', to: 'Umbenannt.md' },
    });
    expect(renamed.statusCode).toBe(200);
    await commit('julian', 'Vault-Stand 2026-08-16 08:00 · 1 umbenannt');

    const response = await server.inject({
      url: '/api/v1/history/Umbenannt.md',
      headers: { cookie },
    });
    const parsed = S.HistoryResponse.parse(response.json());

    expect(parsed.state).toBe('ready');
    // Three from before the rename, plus the commit that renamed it.
    expect(parsed.versions).toHaveLength(4);
  });

  /**
   * And the versions it keeps have to be readable, or the list is worse than
   * short.
   *
   * `contentAt` asks `git show <version>:<today's path>`. In the commits before
   * a rename that path does not exist, so every version `--follow` recovered
   * answers "the note did not exist at that version". Listing four versions of
   * which three refuse to open is a worse answer than honestly listing one:
   * before, the history was visibly short, and now it looks complete and is
   * not.
   *
   * So the path is not one value but one per version — the name the file had in
   * that commit, which is exactly what `--follow` was tracking to build the
   * list in the first place.
   */
  it('can open a version from before the rename', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/rename',
      headers: { cookie },
      payload: { from: 'Notiz.md', to: 'Umbenannt.md' },
    });
    await commit('julian', 'Vault-Stand 2026-08-16 08:00 · 1 umbenannt');

    const list = S.HistoryResponse.parse(
      (await server.inject({ url: '/api/v1/history/Umbenannt.md', headers: { cookie } })).json(),
    );
    const oldest = list.versions[list.versions.length - 1]!;

    const response = await server.inject({
      url: `/api/v1/history/Umbenannt.md?version=${oldest.id}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().content).toBe('Fassung eins.\n');
  });

  it('lists the versions, newest first', async () => {
    const response = await server.inject({ url: '/api/v1/history/Notiz.md', headers: { cookie } });
    const parsed = S.HistoryResponse.parse(response.json());

    expect(parsed.state).toBe('ready');
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

/**
 * The failures that used to be silent.
 *
 * Every method in `history.ts` ended in a `catch` that returned an empty
 * result, so several different situations displayed as the same sentence — "no
 * earlier versions recorded yet" — and one of them is a note whose entire
 * history is sitting on disk, unreachable. The tests here are one per
 * situation, and what they all assert is the same thing: that the answer is
 * `broken` and not an absence.
 *
 * Three of the fixtures are the real thing rather than a stand-in. A repository
 * whose `objects` are gone, a branch pointing at an object that is not there,
 * and git refusing a repository over its ownership are exactly what the host
 * can produce — the last being the case this deployment actually meets, where
 * the container runs as uid 1000 and the bind mount hides the Dockerfile's
 * `chown`. `GIT_TEST_ASSUME_DIFFERENT_OWNER` is git's own switch for it, so the
 * test needs neither root nor a second account.
 */
describe('a sidecar that cannot be read', () => {
  /** Strips the object store: git then declines to see a repository at all. */
  async function stripObjects(owner: string): Promise<void> {
    await fs.rm(path.join(dataDir, 'vaults', owner, '.git', 'objects'), { recursive: true, force: true });
  }

  /** A branch pointing at a commit that is not there. The layout stays valid. */
  async function danglingBranch(owner: string): Promise<void> {
    await fs.writeFile(
      path.join(dataDir, 'vaults', owner, '.git', 'refs', 'heads', 'main'),
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n',
    );
  }

  async function history(): Promise<{ statusCode: number; parsed: S.HistoryResponse }> {
    const response = await server.inject({ url: '/api/v1/history/Notiz.md', headers: { cookie } });
    return { statusCode: response.statusCode, parsed: S.HistoryResponse.parse(response.json()) };
  }

  beforeEach(async () => {
    await initRepo('julian');
    await runtime.app.createNote('julian', 'Notiz.md', 'Fassung eins.\n');
    await commit('julian', 'Vault-Stand · 1 geändert');
  });

  it('is broken, not a note that was never changed', async () => {
    // The listing before the damage, so that what changed is the damage and not
    // the note: three versions here would be as wrong as none afterwards.
    expect((await history()).parsed.state).toBe('ready');

    await stripObjects('julian');

    const { statusCode, parsed } = await history();
    // Still a 200 and still an empty list — the note editor must not break
    // because the history did. What is new is that the emptiness is labelled.
    expect(statusCode).toBe(200);
    expect(parsed.state).toBe('broken');
    expect(parsed.versions).toEqual([]);
  });

  it('is told apart from a vault that has no repository at all', async () => {
    // git says "not a git repository" for both, in the same words, because
    // repository discovery rejects a broken layout and then walks up to the
    // parent. The only evidence is on disk, and this pair is what proves it is
    // being read: one assertion cannot pass without the other failing under any
    // implementation that goes by the message.
    await stripObjects('julian');
    expect((await history()).parsed.state).toBe('broken');

    await fs.rm(path.join(dataDir, 'vaults', 'julian', '.git'), { recursive: true, force: true });
    expect((await history()).parsed.state).toBe('none');
  });

  it('refuses to read a version rather than call it a version that never existed', async () => {
    const id = (await history()).parsed.versions[0]!.id;

    await stripObjects('julian');

    const response = await server.inject({
      url: `/api/v1/history/Notiz.md?version=${id}`,
      headers: { cookie },
    });

    // A 404 here was the worst of the lies: the client was handed this commit
    // id by this server one request earlier, and "no such version of this note"
    // invites the reader to conclude their text is gone.
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'history_unreadable' });
  });

  it('refuses a restore of a version it cannot read, and leaves the note alone', async () => {
    const id = (await history()).parsed.versions[0]!.id;
    await stripObjects('julian');

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/history/restore',
      headers: { cookie },
      payload: { owner: 'julian', path: 'Notiz.md', version: id },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'history_unreadable' });
    expect(await runtime.app.notes.getNote('julian', 'Notiz.md')).toMatchObject({
      content: 'Fassung eins.\n',
    });
  });

  it('is broken when git refuses the repository over its ownership', async () => {
    // The live case: the sidecar belongs to root on the host, the container
    // runs as uid 1000, and git answers "detected dubious ownership". Nothing
    // about that resembles "this vault has no history", and it used to be
    // reported as exactly that.
    const original = process.env['GIT_TEST_ASSUME_DIFFERENT_OWNER'];
    process.env['GIT_TEST_ASSUME_DIFFERENT_OWNER'] = '1';
    try {
      expect((await history()).parsed.state).toBe('broken');
      expect(await runtime.history.state('julian')).toBe('broken');
    } finally {
      if (original === undefined) delete process.env['GIT_TEST_ASSUME_DIFFERENT_OWNER'];
      else process.env['GIT_TEST_ASSUME_DIFFERENT_OWNER'] = original;
    }
  });

  it('is broken, not empty, when the branch points at a commit that is gone', async () => {
    // The hole in `state`: it asked `rev-parse --verify --quiet HEAD^{commit}`,
    // which exits 1 both for a repository with no commits and for this one, so
    // a corrupt repository reported itself as "the timer has not run yet" — and
    // a deleted note in it was offered the sentence "the history has not saved
    // anything yet, so there is no version to restore". `git log` says "bad
    // object HEAD" here and "does not have any commits yet" there, which is why
    // it is the probe now.
    await danglingBranch('julian');

    expect(await runtime.history.state('julian')).toBe('broken');
    expect((await history()).parsed.state).toBe('broken');
  });

  it('is still empty, not broken, for a repository the timer has not committed into', async () => {
    // The other side of that boundary, so that the fix above cannot be "call
    // everything broken". This is a legitimate state and has to stay one.
    await initRepo('ramona');
    expect(await runtime.history.state('ramona')).toBe('empty');

    const hers = await signIn('ramona', 'ihr gutes passwort');
    await runtime.app.createNote('ramona', 'Neu.md', 'a\n');
    const response = await server.inject({ url: '/api/v1/history/Neu.md', headers: { cookie: hers } });
    expect(S.HistoryResponse.parse(response.json()).state).toBe('empty');
  });

  it('is broken when git cannot be run at all', async () => {
    // A container image without git, or a PATH that lost it. `execFile` reports
    // ENOENT for this *and* for a working directory that is not there, and only
    // the second may mean "no history" — so both halves are asserted here.
    const own = new History(dataDir, { timeoutMs: 1000 });
    const original = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      expect(await own.state('julian')).toBe('broken');
      expect((await own.versions('julian', 'Notiz.md')).state).toBe('broken');
      expect(await own.state('niemand-hier')).toBe('none');
    } finally {
      process.env['PATH'] = original;
    }
  });

  it('is broken when git runs into the timeout', async () => {
    // The failure that gets likelier every day rather than less likely: at one
    // commit every two minutes the sidecar gathers a quarter of a million
    // commits a year, and `git log -- <path>` walks back from HEAD until it has
    // fifty hits for that one path, which for a rarely-edited note is the whole
    // history. It used to come out as "never changed".
    //
    // A git that sleeps rather than a repository big enough to be slow: the
    // second would cost this suite minutes and still not be deterministic,
    // while a thirty-second sleep loses a fifty-millisecond race every time.
    const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-slow-git-'));
    await fs.writeFile(path.join(bin, 'git'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    const seen: string[] = [];
    const own = new History(dataDir, { timeoutMs: 50, warn: (detail) => seen.push(detail.reason) });
    const original = process.env['PATH'];
    // Prepended rather than replacing: the shim needs `sleep` on its own PATH.
    process.env['PATH'] = `${bin}${path.delimiter}${original ?? ''}`;
    try {
      expect((await own.versions('julian', 'Notiz.md')).state).toBe('broken');
      expect(await own.state('julian')).toBe('broken');
      expect(seen.join(' ')).toContain('did not answer');
    } finally {
      process.env['PATH'] = original;
      await fs.rm(bin, { recursive: true, force: true });
    }
  });

  it('throws out of the two calls a deleted note is brought back through', async () => {
    // `lastVersionBefore` and `recorded` answered empty, and empty there reads
    // as "no saved version holds this note" — which is put in front of somebody
    // deciding whether to delete it.
    await stripObjects('julian');

    await expect(runtime.history.lastVersionBefore('julian', 'Notiz.md', Date.now())).rejects.toThrow(
      HistoryUnreadableError,
    );
    await expect(runtime.history.recorded('julian', ['Notiz.md'])).rejects.toThrow(HistoryUnreadableError);
  });

  it('says so in the log, once per vault, with a marker to grep for', async () => {
    // Because the whole point is that nobody should have to click a note to
    // find out. An operator greps `history unreadable` and sees the account.
    const said: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        said.push(String(chunk));
        done();
      },
    });
    const own = await startHarness('history-log', {}, { logStream: sink });
    try {
      await own.runtime.users.create('julian', 'ein gutes passwort');
      await own.runtime.app.createNote('julian', 'Notiz.md', 'a\n');
      const cwd = path.join(own.dataDir, 'vaults', 'julian');
      await run('git', ['init', '-q', '-b', 'main'], { cwd });
      await run('git', ['add', '-A'], { cwd });
      await run('git', ['commit', '-q', '-m', 'Vault-Stand · 1 geändert'], {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'ndBrain',
          GIT_AUTHOR_EMAIL: 'ndbrain@localhost',
          GIT_COMMITTER_NAME: 'ndBrain',
          GIT_COMMITTER_EMAIL: 'ndbrain@localhost',
        },
      });
      await fs.rm(path.join(cwd, '.git', 'objects'), { recursive: true, force: true });

      await own.login('julian', 'ein gutes passwort');
      await own.as('julian', { url: '/api/v1/history/Notiz.md' });

      const lines = said.filter((line) => line.includes('history unreadable'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"account":"julian"');
      // git's own words, so an operator does not have to guess which of the
      // half-dozen ways this can break they are looking at.
      expect(lines[0]).toContain('not a git repository');

      // Asked four more times, said once. One broken vault must not bury the
      // line that matters under a hundred identical ones; same minute, and the
      // same reasoning, as the health endpoint's own probe cache.
      for (let i = 0; i < 4; i += 1) await own.as('julian', { url: '/api/v1/history/Notiz.md' });
      expect(said.filter((line) => line.includes('history unreadable'))).toHaveLength(1);
    } finally {
      await own.close();
    }
  });
});

/**
 * One object gone, and everything above it still fine.
 *
 * The listing works, the version is there with its timestamp and subject, and
 * only the bytes are missing. This is the state where a `catch` that answers
 * "the note did not exist at that version" does the most damage: the version
 * is visibly in the list, so the reader is told this particular one is gone —
 * and since a restore reads the same object, it is told twice.
 *
 * A lost loose object is the plainest corruption there is; the same shape comes
 * out of an interrupted fetch or a repository half copied off a failing disk.
 * It is also the only way to reach two of the decisions in `history.ts`, since
 * anything broken harder is caught by the listing before them.
 */
describe('a sidecar missing only the bytes of a version', () => {
  let id: string;

  /** Removes the loose object for the note's content at HEAD, and nothing else. */
  async function dropBlob(owner: string, notePath: string): Promise<void> {
    const cwd = path.join(dataDir, 'vaults', owner);
    const blob = (await run('git', ['rev-parse', `HEAD:${notePath}`], { cwd })).stdout.trim();
    await fs.rm(path.join(cwd, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), { force: true });
  }

  beforeEach(async () => {
    await initRepo('julian');
    await runtime.app.createNote('julian', 'Notiz.md', 'Fassung eins.\n');
    await commit('julian', 'Vault-Stand · 1 geändert');
    const listed = S.HistoryResponse.parse(
      (await server.inject({ url: '/api/v1/history/Notiz.md', headers: { cookie } })).json(),
    );
    id = listed.versions[0]!.id;
    await dropBlob('julian', 'Notiz.md');
  });

  it('still lists the version, because the commit and the tree are readable', async () => {
    const listed = S.HistoryResponse.parse(
      (await server.inject({ url: '/api/v1/history/Notiz.md', headers: { cookie } })).json(),
    );

    // Not `broken`: the listing genuinely succeeded, and calling it broken here
    // would be the same overreach in the other direction.
    expect(listed.state).toBe('ready');
    expect(listed.versions).toHaveLength(1);
  });

  it('refuses the read as unreadable rather than as a version the note never had', async () => {
    const response = await server.inject({
      url: `/api/v1/history/Notiz.md?version=${id}`,
      headers: { cookie },
    });

    // git says "bad object", not "does not exist in <commit>" — and only the
    // second means the note was not in that commit. The version is right there
    // in the list above, so "the note did not exist at that version" would be
    // flatly contradicted by the panel showing it.
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'history_unreadable' });
  });

  it('refuses a restore of it for the same reason', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/history/restore',
      headers: { cookie },
      payload: { owner: 'julian', path: 'Notiz.md', version: id },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'history_unreadable' });
  });

  it('does not take the missing bytes for a commit that recorded a deletion', async () => {
    // `cat-file -e` exits 1 with nothing on stderr here, while a path genuinely
    // absent from a commit exits 128 and says "does not exist in" — which is
    // why the reason is read rather than the exit status. Taking this for a
    // deletion would walk past the one version there is and answer "no saved
    // version holds this note".
    await expect(runtime.history.lastVersionBefore('julian', 'Notiz.md', Date.now())).rejects.toThrow(
      HistoryUnreadableError,
    );
  });
});
