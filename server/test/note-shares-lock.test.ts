/**
 * The permission is decided again inside the note's lock.
 *
 * `note-shares-guard.test.ts` pins that a write never carries a share over to a
 * file that was put there behind ndBrain's back. This file pins the other half
 * of the same problem: the route decides whether the caller may write *before*
 * the lock, and `confirm` withdraws the share *inside* it — so between the two
 * there is an operation running on a permission that no longer exists.
 *
 * The window is not theoretical. The watcher settles writes for 250 ms, and an
 * event it never receives is only caught by the reconcile five minutes later.
 * For that whole time the shares table still says yes.
 *
 * Every test here is written so that removing the in-lock check from the route
 * it covers turns it red — that is the mutation each one is for. The worst of
 * them is not a leak of one answer but a permanent one: a grantee moves the
 * replaced file into a folder she holds, and reads it from then on.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startHarness, type Harness } from './support/harness.js';

vi.setConfig({ testTimeout: 30_000 });

const run = promisify(execFile);

let h: Harness;

/** Long enough that the hash rescue cannot vouch for it; see `RESCUE_MIN_BYTES`. */
const FREMD = '# Fremd\n\nfremder Inhalt, den Ramona nie sehen darf, streng geheim, lang genug\n';

beforeEach(async () => {
  h = await startHarness('lock');
  for (const [id, password] of [
    ['julian', 'ein gutes passwort'],
    ['ramona', 'ihr gutes passwort'],
  ] as const) {
    await h.runtime.users.create(id, password);
    await h.login(id, password);
  }
  const app = h.runtime.app;
  await app.createNote('julian', 'Projekt/Plan.md', '# Plan\n\ngeteilt\n\n- [ ] eins\n', 'julian');
  await app.createNote('julian', 'Projekt/Plan2.md', '# Plan 2\n\ngeteilt\n\n- [ ] eins\n', 'julian');
  await app.createNote('julian', 'Projekt/Geheim.md', '# Geheim\n\nnur für Julian\n', 'julian');
  await app.createNote('julian', 'Archiv/x.md', '# x\n\nlange genug, damit der Hash-Rettungsweg greifen könnte\n', 'julian');
  await app.createNote('julian', 'Archiv/Geheim.md', '# Archiv-Geheim\n\nnur für Julian\n', 'julian');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await h.close();
});

const onDisk = (notePath: string): string => path.join(h.dataDir, 'vaults', 'julian', notePath);
const exists = (notePath: string): Promise<boolean> =>
  fs.stat(onDisk(notePath)).then(() => true, () => false);
const read = (notePath: string): Promise<string> => fs.readFile(onDisk(notePath), 'utf8');
const noteShares = (): string[] =>
  h.runtime.shares
    .byOwner('julian')
    .filter((s) => s.kind === 'note')
    .map((s) => `${s.grantee}:${s.prefix}`);

async function share(grantee: string, kind: 'note' | 'folder', sharePath: string, canWrite: boolean): Promise<void> {
  const reply = await h.as('julian', {
    method: 'POST',
    url: '/api/v1/shares',
    payload: { grantee, kind, path: sharePath, canWrite },
  });
  expect(reply.status).toBe(200);
}

/** Replaces the file on `notePath` the way a sync client or an editor without a backup copy does. */
async function replaceBehind(notePath: string, content = FREMD): Promise<void> {
  await fs.writeFile(onDisk('Fremd.tmp'), content, 'utf8');
  await fs.rename(onDisk('Fremd.tmp'), onDisk(notePath));
}

/** The answer a note nobody shared gives — what every refusal here has to look like. */
async function absentAnswer(): Promise<{ status: number; raw: string }> {
  const reply = await h.as('ramona', { url: '/api/v1/notes/Archiv/Geheim.md?owner=julian' });
  return { status: reply.status, raw: reply.raw };
}

/**
 * The history sidecar the host timer keeps, as far as the restore route needs it.
 *
 * The commit is stamped a few seconds ahead because git records whole seconds
 * while a note share records milliseconds: a version committed in the same
 * second the share was granted would fall just before it and be filtered out as
 * belonging to whatever held the name earlier (`pastVisibleFrom`).
 */
async function startHistory(owner: string): Promise<void> {
  const cwd = path.join(h.dataDir, 'vaults', owner);
  const when = new Date(Date.now() + 5000).toISOString();
  const env = { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  await run('git', ['init', '-q', '-b', 'main'], { cwd });
  await run('git', ['config', 'user.email', 'ndbrain@localhost'], { cwd });
  await run('git', ['config', 'user.name', 'ndBrain'], { cwd });
  await run('git', ['add', '-A'], { cwd });
  await run('git', ['commit', '-q', '-m', 'Vault-Stand · 1 geändert', '--allow-empty'], { cwd, env });
}

describe('a share withdrawn inside the lock stops the operation it was checked for', () => {
  describe('rename and bulk move — the permanent leak', () => {
    // Ramona may write in `Projekt/` and holds one note in `Archiv/`. Moving
    // that note into `Projekt/` would put the file the share no longer names
    // inside a folder she reads for good.
    beforeEach(async () => {
      await share('ramona', 'folder', 'Projekt', true);
      await share('ramona', 'note', 'Archiv/x.md', true);
      await replaceBehind('Archiv/x.md');
    });

    it('rename: refuses, moves nothing and never reports the content', async () => {
      const reply = await h.as('ramona', {
        method: 'POST',
        url: '/api/v1/rename',
        payload: { owner: 'julian', from: 'Archiv/x.md', to: 'Projekt/x.md' },
      });

      expect(reply).toMatchObject(await absentAnswer());
      expect(reply.raw).not.toContain('fremder');
      expect(await exists('Projekt/x.md')).toBe(false);
      expect(await read('Archiv/x.md')).toContain('fremder');
      expect(noteShares()).toEqual([]);

      const after = await h.as('ramona', { url: '/api/v1/notes/Archiv/x.md?owner=julian' });
      expect(after.status).toBe(404);
    });

    it('bulk move: reports the note as absent and moves nothing', async () => {
      const reply = await h.as('ramona', {
        method: 'POST',
        url: '/api/v1/bulk',
        payload: { owner: 'julian', action: 'move', paths: ['Archiv/x.md'], dir: 'Projekt' },
      });

      expect(reply.status).toBe(200);
      expect(reply.body.ok).toEqual([]);
      expect(reply.body.failed).toEqual([{ path: 'Archiv/x.md', reason: 'note does not exist' }]);
      expect(await exists('Projekt/x.md')).toBe(false);
      expect(noteShares()).toEqual([]);
    });
  });

  describe('the note itself', () => {
    beforeEach(async () => {
      await share('ramona', 'note', 'Projekt/Plan.md', true);
    });

    it('PUT ifAbsent: never hands back the file that took the place', async () => {
      await replaceBehind('Projekt/Plan.md');

      const reply = await h.as('ramona', {
        method: 'PUT',
        url: '/api/v1/notes/Projekt/Plan.md?owner=julian',
        payload: { content: '# von ramona\n', ifAbsent: true },
      });

      expect(reply).toMatchObject(await absentAnswer());
      expect(reply.raw).not.toContain('fremder');
      expect(await read('Projekt/Plan.md')).toContain('fremder');
    });

    it('PUT without a base version: writes nothing over the file', async () => {
      await replaceBehind('Projekt/Plan.md');

      const reply = await h.as('ramona', {
        method: 'PUT',
        url: '/api/v1/notes/Projekt/Plan.md?owner=julian',
        payload: { content: '# von ramona\n' },
      });

      expect(reply).toMatchObject(await absentAnswer());
      expect(await read('Projekt/Plan.md')).toContain('fremder');
      expect(await fs.readdir(onDisk('Projekt'))).toEqual(['Geheim.md', 'Plan.md', 'Plan2.md']);
    });

    it('PUT with a base version: no write and no conflict copy', async () => {
      const seen = await h.as('ramona', { url: '/api/v1/notes/Projekt/Plan.md?owner=julian' });
      await replaceBehind('Projekt/Plan.md');

      const reply = await h.as('ramona', {
        method: 'PUT',
        url: '/api/v1/notes/Projekt/Plan.md?owner=julian',
        payload: { content: '# von ramona\n', baseMtimeMs: seen.body.note.mtimeMs },
      });

      expect(reply).toMatchObject(await absentAnswer());
      expect(await read('Projekt/Plan.md')).toContain('fremder');
      // A conflict copy would be the foreign content written out a second time,
      // under a name in a folder Ramona may not even read.
      expect(await fs.readdir(onDisk('Projekt'))).toEqual(['Geheim.md', 'Plan.md', 'Plan2.md']);
    });

    it('DELETE: the file stays', async () => {
      await replaceBehind('Projekt/Plan.md');

      const reply = await h.as('ramona', {
        method: 'DELETE',
        url: '/api/v1/notes/Projekt/Plan.md?owner=julian',
      });

      expect(reply).toMatchObject(await absentAnswer());
      expect(await read('Projekt/Plan.md')).toContain('fremder');
    });

    it('toggle: the same answer for a matching and a mismatching task, so it is no oracle', async () => {
      // Two notes in the same state, not one asked twice: the first call
      // withdraws the share, and the second would then be refused by the route
      // before it ever looked at the file — which would make the pair agree for
      // a reason that says nothing about the oracle.
      await share('ramona', 'note', 'Projekt/Plan2.md', true);
      const foreign = `# Fremd\n\n- [ ] geheime Aufgabe\n${'füllsel '.repeat(12)}\n`;
      await replaceBehind('Projekt/Plan.md', foreign);
      await replaceBehind('Projekt/Plan2.md', foreign);

      const toggle = async (notePath: string, text: string): ReturnType<Harness['as']> =>
        h.as('ramona', {
          method: 'POST',
          url: '/api/v1/tasks/toggle?owner=julian',
          payload: {
            owner: 'julian',
            path: notePath,
            line: 3,
            expectedText: text,
            expectedDone: false,
            done: true,
          },
        });

      const hit = await toggle('Projekt/Plan.md', 'geheime Aufgabe');
      const miss = await toggle('Projekt/Plan2.md', 'etwas ganz anderes');

      expect(hit).toMatchObject(await absentAnswer());
      expect(hit.raw).toEqual(miss.raw);
      expect(hit.status).toEqual(miss.status);
      expect(await read('Projekt/Plan.md')).toContain('[ ] geheime Aufgabe');
    });

    it('toggle: the write is authorized again, not only the read', async () => {
      // The toggle reads under one lock and writes under the next, and the
      // replacement can land in between. Wedged in exactly there, because that
      // gap is not otherwise reachable from outside.
      const app = h.runtime.app;
      const realRead = app.readAuthorized.bind(app);
      vi.spyOn(app, 'readAuthorized').mockImplementation(async (owner, notePath, authorize) => {
        const note = await realRead(owner, notePath, authorize);
        await replaceBehind('Projekt/Plan.md', `# Fremd\n\n- [ ] eins\n${'füllsel '.repeat(12)}\n`);
        return note;
      });

      const reply = await h.as('ramona', {
        method: 'POST',
        url: '/api/v1/tasks/toggle?owner=julian',
        payload: {
          owner: 'julian',
          path: 'Projekt/Plan.md',
          line: 5,
          expectedText: 'eins',
          expectedDone: false,
          done: true,
        },
      });

      expect(reply).toMatchObject(await absentAnswer());
      expect(await read('Projekt/Plan.md')).toContain('[ ] eins');
      expect(await read('Projekt/Plan.md')).toContain('füllsel');
    });

    it('restore: writes nothing over the file', async () => {
      await startHistory('julian');
      const history = await h.as('ramona', { url: '/api/v1/history/Projekt/Plan.md?owner=julian' });
      expect(history.status).toBe(200);
      const version = history.body.versions?.[0]?.id;
      expect(typeof version).toBe('string');

      await replaceBehind('Projekt/Plan.md');

      const reply = await h.as('ramona', {
        method: 'POST',
        url: '/api/v1/history/restore',
        payload: { owner: 'julian', path: 'Projekt/Plan.md', version },
      });

      expect(reply).toMatchObject(await absentAnswer());
      expect(await read('Projekt/Plan.md')).toContain('fremder');
    });

    it('upload: the bytes do not land', async () => {
      await replaceBehind('Projekt/Plan.md');

      const reply = await h.as('ramona', {
        method: 'POST',
        url: '/api/v1/files/Projekt/Plan.md?owner=julian',
        payload: '# von ramona\n',
      });

      expect(reply.status).toBe(404);
      expect(await read('Projekt/Plan.md')).toContain('fremder');
    });

    it('bulk tag: the note is reported absent and nothing is written', async () => {
      await replaceBehind('Projekt/Plan.md');

      const reply = await h.as('ramona', {
        method: 'POST',
        url: '/api/v1/bulk',
        payload: { owner: 'julian', action: 'tag', paths: ['Projekt/Plan.md'], tag: 'neu' },
      });

      expect(reply.body.ok).toEqual([]);
      expect(reply.body.failed).toEqual([{ path: 'Projekt/Plan.md', reason: 'note does not exist' }]);
      expect(await read('Projekt/Plan.md')).not.toContain('neu');
    });

    it('bulk delete: the file stays', async () => {
      await replaceBehind('Projekt/Plan.md');

      const reply = await h.as('ramona', {
        method: 'POST',
        url: '/api/v1/bulk',
        payload: { owner: 'julian', action: 'delete', paths: ['Projekt/Plan.md'] },
      });

      expect(reply.body.ok).toEqual([]);
      expect(reply.body.failed).toEqual([{ path: 'Projekt/Plan.md', reason: 'note does not exist' }]);
      expect(await read('Projekt/Plan.md')).toContain('fremder');
    });
  });
});

/**
 * The destination of a move is checked in the lock as well.
 *
 * `confirm` cannot withdraw a share on a path that holds no note, so the
 * destination's half of the race is the other one the lock exists for: the
 * grant going away while the operation waits for the lock it needs.
 */
describe('the destination of a rename is decided in the lock too', () => {
  it('a folder share withdrawn after the route said yes stops the move', async () => {
    await share('ramona', 'folder', 'Projekt', true);
    await share('ramona', 'note', 'Archiv/x.md', true);

    const destination = h.runtime.shares.byOwner('julian').find((s) => s.kind === 'folder');
    expect(destination).toBeDefined();

    // Withdrawn from inside the rename, after the route's own check and before
    // the lock: the one point in the sequence where the two decisions can
    // disagree about the destination, and the reason the second one exists.
    const queries = h.runtime.app.queries;
    const realBacklinks = queries.backlinks.bind(queries);
    vi.spyOn(queries, 'backlinks').mockImplementation((...args) => {
      h.runtime.shares.revoke(destination!.id);
      return realBacklinks(...args);
    });

    const reply = await h.as('ramona', {
      method: 'POST',
      url: '/api/v1/rename',
      payload: { owner: 'julian', from: 'Archiv/x.md', to: 'Projekt/x.md' },
    });

    expect(reply.status).toBe(404);
    expect(await exists('Projekt/x.md')).toBe(false);
    expect(await exists('Archiv/x.md')).toBe(true);
  });
});

/**
 * A rename that is refused leaves the vault exactly as it found it.
 *
 * The link rewrite used to run before the move — before the lock, before
 * `confirm`, before the permission was asked a second time. A move the lock
 * then refused left every note in the owner's vault pointing at a path nothing
 * had moved to, and left them unindexed on top, because the reindex is at the
 * end. The rewrite now happens after the move.
 */
describe('a refused rename rewrites no links', () => {
  beforeEach(async () => {
    await h.runtime.app.createNote('julian', 'Projekt/Ref.md', '# Ref\n\nsiehe [[Archiv/x]]\n', 'julian');
  });

  const referrer = (): Promise<string> => read('Projekt/Ref.md');

  it('when the share is withdrawn in the lock', async () => {
    await share('ramona', 'folder', 'Projekt', true);
    await share('ramona', 'note', 'Archiv/x.md', true);
    await replaceBehind('Archiv/x.md');

    const reply = await h.as('ramona', {
      method: 'POST',
      url: '/api/v1/rename',
      payload: { owner: 'julian', from: 'Archiv/x.md', to: 'Projekt/x.md' },
    });

    expect(reply.status).toBe(404);
    expect(await referrer()).toContain('[[Archiv/x]]');
    expect(await exists('Projekt/x.md')).toBe(false);
  });

  it('when the owner renames onto a name that is taken', async () => {
    const reply = await h.as('julian', {
      method: 'POST',
      url: '/api/v1/rename',
      payload: { from: 'Archiv/x.md', to: 'Projekt/Plan.md' },
    });

    expect(reply.status).toBe(409);
    expect(await referrer()).toContain('[[Archiv/x]]');
    expect(await read('Projekt/Plan.md')).toContain('geteilt');
  });

  it('and a rename that goes through rewrites them and indexes what it wrote', async () => {
    const reply = await h.as('julian', {
      method: 'POST',
      url: '/api/v1/rename',
      payload: { from: 'Archiv/x.md', to: 'Projekt/x.md' },
    });

    expect(reply.status).toBe(200);
    expect(reply.body.updatedLinks).toEqual(['Projekt/Ref.md']);
    expect(await referrer()).toContain('[[Projekt/x]]');

    // The index agrees with the file, without waiting for the watcher: the
    // rewritten note is found by its new text and its link resolves.
    const found = await h.as('julian', { url: '/api/v1/backlinks/Projekt/x.md' });
    expect(found.body.backlinks.map((link: { source: string }) => link.source)).toEqual(['Projekt/Ref.md']);
  });

  it('carries a note´s link to its own old name with it', async () => {
    await h.runtime.app.putNote('julian', 'Archiv/x.md', '# x\n\nich selbst: [[Archiv/x]]\n', 'julian');

    const reply = await h.as('julian', {
      method: 'POST',
      url: '/api/v1/rename',
      payload: { from: 'Archiv/x.md', to: 'Projekt/x.md' },
    });

    expect(reply.status).toBe(200);
    expect(await read('Projekt/x.md')).toContain('[[Projekt/x]]');
    expect(await exists('Archiv/x.md')).toBe(false);
  });
});

/**
 * A note renamed to another letter case behind ndBrain's back is still a note
 * that is gone from the path the share names. Saying so by name would hand the
 * grantee the new one.
 */
describe('the letter-case collision is reported to the owner only', () => {
  beforeEach(async () => {
    await share('ramona', 'note', 'Projekt/Plan.md', true);
    await fs.rename(onDisk('Projekt/Plan.md'), onDisk('Projekt/plan.md'));
  });

  for (const [what, payload] of [
    ['a save', { content: '# von ramona\n' }],
    ['a create-if-absent', { content: '# von ramona\n', ifAbsent: true }],
  ] as const) {
    it(`answers a grantee's ${what} as a missing note`, async () => {
      const reply = await h.as('ramona', {
        method: 'PUT',
        url: '/api/v1/notes/Projekt/Plan.md?owner=julian',
        payload,
      });

      expect(reply).toMatchObject(await absentAnswer());
      expect(reply.raw).not.toContain('plan.md');
      expect(await read('Projekt/plan.md')).not.toContain('ramona');
    });

    it(`names it to the owner, whose only explanation it is (${what})`, async () => {
      const reply = await h.as('julian', {
        method: 'PUT',
        url: '/api/v1/notes/Projekt/Plan.md',
        payload,
      });

      expect(reply.status).toBe(409);
      expect(reply.body.code).toBe('case_collision');
      expect(reply.body.message).toContain('plan.md');
    });
  }
});
