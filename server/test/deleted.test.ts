/**
 * Recently deleted notes: the list, the restore, and who may do either.
 *
 * The security half is written as two worlds. A caller without the right to
 * restore a note must get, byte for byte, the answer they would get if the note
 * had never existed — from the list and from the restore — or the feature is a
 * way to learn titles and paths of somebody else's deleted notes.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { restoredOriginal, restoredPath } from '../src/index/queries.js';
import { DELETED_WINDOW_MS } from '../src/notes/deleted.js';
import { startHarness, type Harness } from './support/harness.js';

const run = promisify(execFile);

let h: Harness;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'ndBrain',
  GIT_AUTHOR_EMAIL: 'ndbrain@localhost',
  GIT_COMMITTER_NAME: 'ndBrain',
  GIT_COMMITTER_EMAIL: 'ndbrain@localhost',
};

function vaultDir(owner: string): string {
  return path.join(h.dataDir, 'vaults', owner);
}

async function initRepo(owner: string): Promise<void> {
  const cwd = vaultDir(owner);
  await fs.mkdir(cwd, { recursive: true });
  await run('git', ['init', '-q', '-b', 'main'], { cwd });
}

/** Commits the vault as the host timer would. */
async function commit(owner: string): Promise<void> {
  const cwd = vaultDir(owner);
  await run('git', ['add', '-A'], { cwd });
  await run('git', ['commit', '-q', '-m', 'Vault-Stand · 1 geändert', '--allow-empty'], { cwd, env: GIT_ENV });
}

async function del(user: string, owner: string, notePath: string): Promise<void> {
  const reply = await h.as(user, {
    method: 'DELETE',
    url: `/api/v1/notes/${encodeURI(notePath)}?owner=${owner}`,
  });
  expect(reply.status).toBe(204);
}

async function list(user: string) {
  return h.as(user, { url: '/api/v1/deleted' });
}

async function restore(user: string, owner: string, notePath: string) {
  return h.as(user, { method: 'POST', url: '/api/v1/deleted/restore', payload: { owner, path: notePath } });
}

async function read(user: string, owner: string, notePath: string) {
  return h.as(user, { url: `/api/v1/notes/${encodeURI(notePath)}?owner=${owner}` });
}

beforeEach(async () => {
  const harness = await startHarness('deleted');
  for (const [id, password, role] of [
    ['admin', 'ein gutes passwort', 'admin'],
    ['julian', 'sein gutes passwort', 'user'],
    ['ramona', 'ihr gutes passwort', 'user'],
  ] as const) {
    await harness.runtime.users.create(id, password, { role });
    await harness.login(id, password);
  }
  h = harness;
}, 60_000);

afterEach(async () => {
  await h.close();
});

describe('the restored name', () => {
  it('reads back to the note it was made from, and nothing else does', () => {
    const when = new Date(2026, 8, 17, 10, 0);
    expect(restoredPath('Projekt/Plan.md', when)).toBe('Projekt/Plan (wiederhergestellt 2026-09-17).md');
    expect(restoredPath('Projekt/Plan.md', when, 2)).toBe('Projekt/Plan (wiederhergestellt 2026-09-17 2).md');
    expect(restoredOriginal('Projekt/Plan (wiederhergestellt 2026-09-17).md')).toBe('Projekt/Plan.md');
    expect(restoredOriginal('Projekt/Plan (wiederhergestellt 2026-09-17 12).md')).toBe('Projekt/Plan.md');
    expect(restoredOriginal('Projekt/Plan (wiederhergestellt gestern).md')).toBeNull();
    expect(restoredOriginal('Projekt/Plan (wiederhergestellt 2026-09-17 1).md')).toBeNull();
    expect(restoredOriginal('Projekt/Plan.md')).toBeNull();
  });
});

describe('with a history on the host', () => {
  beforeEach(async () => {
    await initRepo('julian');
  });

  it('lists a deleted note with its folder, the moment and who deleted it, and brings it back', async () => {
    await h.runtime.app.createNote('julian', 'Projekt/Plan.md', '# Plan\n\nDer letzte Stand.\n', 'julian');
    await commit('julian');
    const before = Date.now();
    await del('julian', 'julian', 'Projekt/Plan.md');

    const listed = await list('julian');
    expect(listed.status).toBe(200);
    expect(listed.body.notes).toHaveLength(1);
    const [row] = listed.body.notes;
    expect(row).toMatchObject({
      owner: 'julian',
      path: 'Projekt/Plan.md',
      title: 'Plan',
      folder: 'Projekt',
      actor: 'julian',
      restore: 'ready',
    });
    expect(row.at).toBeGreaterThanOrEqual(before);
    expect(typeof row.savedAt).toBe('number');

    const restored = await restore('julian', 'julian', 'Projekt/Plan.md');
    expect(restored.status).toBe(200);
    expect(restored.body.samePath).toBe(true);
    expect(restored.body.note.path).toBe('Projekt/Plan.md');
    expect(await fs.readFile(path.join(vaultDir('julian'), 'Projekt/Plan.md'), 'utf8')).toBe(
      '# Plan\n\nDer letzte Stand.\n',
    );

    // Back, so no longer deleted — and indexed like any new note.
    expect((await list('julian')).body.notes).toEqual([]);
    expect((await read('julian', 'julian', 'Projekt/Plan.md')).status).toBe(200);
    expect(h.runtime.app.queries.getNote('julian', 'julian', 'Projekt/Plan.md')).toBeDefined();

    // A second restore finds nothing to restore.
    expect((await restore('julian', 'julian', 'Projekt/Plan.md')).status).toBe(404);
  });

  it('brings back the last saved version before the delete, not a later note of that name', async () => {
    await h.runtime.app.createNote('julian', 'Plan.md', 'Erste Notiz, gelöscht.\n', 'julian');
    await commit('julian');
    await del('julian', 'julian', 'Plan.md');
    await commit('julian');
    await h.runtime.app.createNote('julian', 'Plan.md', 'Zweite Notiz mit dem Namen.\n', 'julian');
    await commit('julian');
    await del('julian', 'julian', 'Plan.md');

    const restored = await restore('julian', 'julian', 'Plan.md');
    expect(restored.status).toBe(200);
    expect(restored.body.note.content).toBe('Zweite Notiz mit dem Namen.\n');
  });

  it('never brings back what was saved at the path after the delete', async () => {
    await h.runtime.app.createNote('julian', 'Plan.md', 'Vor dem Löschen.\n', 'julian');
    await commit('julian');
    await del('julian', 'julian', 'Plan.md');
    // Written behind ndBrain's back and saved by a later tick.
    await fs.writeFile(path.join(vaultDir('julian'), 'Plan.md'), 'Danach, von aussen.\n');
    const later = new Date(Date.now() + 10_000).toISOString();
    const cwd = vaultDir('julian');
    await run('git', ['add', '-A'], { cwd });
    await run('git', ['commit', '-q', '-m', 'später'], {
      cwd,
      env: { ...GIT_ENV, GIT_AUTHOR_DATE: later, GIT_COMMITTER_DATE: later },
    });

    const restored = await restore('julian', 'julian', 'Plan.md');
    expect(restored.status).toBe(200);
    expect(restored.body.note.content).toBe('Vor dem Löschen.\n');
  });

  it('skips a saved state that recorded the note as gone, and shows when the version it brings was saved', async () => {
    await h.runtime.app.createNote('julian', 'Plan.md', 'Erste Fassung.\n', 'julian');
    await commit('julian');
    await del('julian', 'julian', 'Plan.md');
    await commit('julian');
    const [first] = await h.runtime.history.versions('julian', 'Plan.md');
    await h.runtime.app.createNote('julian', 'Plan.md', 'Nie gesichert.\n', 'julian');
    await del('julian', 'julian', 'Plan.md');

    const [row] = (await list('julian')).body.notes;
    expect(row.restore).toBe('ready');
    const versions = await h.runtime.history.versions('julian', 'Plan.md');
    expect(versions[0]?.id).toBe(first?.id);
    expect(row.savedAt).toBe(versions[1]?.at);
    const restored = await restore('julian', 'julian', 'Plan.md');
    expect(restored.status).toBe(200);
    expect(restored.body.note.content).toBe('Erste Fassung.\n');
  });

  it('comes back under a free name when the path is taken, and leaves what is there alone', async () => {
    await h.runtime.app.createNote('julian', 'Projekt/Plan.md', 'Alter Plan.\n', 'julian');
    await commit('julian');
    await del('julian', 'julian', 'Projekt/Plan.md');
    // Taken behind ndBrain's back: no edit is logged, so the note stays deleted.
    await fs.mkdir(path.join(vaultDir('julian'), 'Projekt'), { recursive: true });
    await fs.writeFile(path.join(vaultDir('julian'), 'Projekt/Plan.md'), 'Neuer Plan.\n');

    const first = await restore('julian', 'julian', 'Projekt/Plan.md');
    expect(first.status).toBe(200);
    expect(first.body.samePath).toBe(false);
    const name = restoredPath('Projekt/Plan.md', new Date());
    expect(first.body.note.path).toBe(name);
    expect(first.body.note.content).toBe('Alter Plan.\n');
    expect(await fs.readFile(path.join(vaultDir('julian'), 'Projekt/Plan.md'), 'utf8')).toBe('Neuer Plan.\n');

    // Restored elsewhere is restored: gone from the list.
    expect((await list('julian')).body.notes).toEqual([]);
  });

  it('takes the next free name when the first one is taken too, also by letter case', async () => {
    await h.runtime.app.createNote('julian', 'Plan.md', 'Alter Plan.\n', 'julian');
    await commit('julian');
    await del('julian', 'julian', 'Plan.md');
    await fs.writeFile(path.join(vaultDir('julian'), 'plan.md'), 'anders geschrieben\n');
    const taken = restoredPath('Plan.md', new Date());
    await fs.writeFile(path.join(vaultDir('julian'), taken.toLowerCase()), 'auch belegt\n');

    const restored = await restore('julian', 'julian', 'Plan.md');
    expect(restored.status).toBe(200);
    expect(restored.body.note.path).toBe(restoredPath('Plan.md', new Date(), 2));
    expect(await fs.readFile(path.join(vaultDir('julian'), 'plan.md'), 'utf8')).toBe('anders geschrieben\n');
  });

  it('restores a note once when asked twice at the same moment', async () => {
    await h.runtime.app.createNote('julian', 'Plan.md', 'Einmal bitte.\n', 'julian');
    await commit('julian');
    await del('julian', 'julian', 'Plan.md');

    const replies = await Promise.all([restore('julian', 'julian', 'Plan.md'), restore('julian', 'julian', 'Plan.md')]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 404]);
    const names = (await fs.readdir(vaultDir('julian'))).filter((name) => name.endsWith('.md'));
    expect(names).toEqual(['Plan.md']);
  });

  it('gives no share back: a restored note is a new file', async () => {
    await h.runtime.app.createNote('julian', 'Plan.md', '# Plan\n\nGeteilt, dann gelöscht.\n', 'julian');
    await h.runtime.app.grantShare('julian', 'ramona', { kind: 'note', path: 'Plan.md' }, true);
    expect((await read('ramona', 'julian', 'Plan.md')).status).toBe(200);
    await commit('julian');
    await del('julian', 'julian', 'Plan.md');

    expect((await restore('julian', 'julian', 'Plan.md')).status).toBe(200);
    expect(h.runtime.shares.byOwner('julian')).toEqual([]);
    expect((await read('ramona', 'julian', 'Plan.md')).status).toBe(404);
  });

  it('marks a note no saved version holds, and refuses to invent one', async () => {
    await h.runtime.app.createNote('julian', 'Alt.md', 'gesichert\n', 'julian');
    await commit('julian');
    await h.runtime.app.createNote('julian', 'Flüchtig.md', 'zwischen zwei Takten\n', 'julian');
    await del('julian', 'julian', 'Flüchtig.md');

    const [row] = (await list('julian')).body.notes;
    expect(row).toMatchObject({ path: 'Flüchtig.md', restore: 'no-version', savedAt: null });
    const refused = await restore('julian', 'julian', 'Flüchtig.md');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('nothing_to_restore');
    await expect(fs.access(path.join(vaultDir('julian'), 'Flüchtig.md'))).rejects.toThrow();
  });

  it('lists a note created and deleted within the same millisecond', async () => {
    await h.runtime.app.createNote('julian', 'Schnell.md', 'im selben Takt\n', 'julian');
    await commit('julian');
    await del('julian', 'julian', 'Schnell.md');
    // A fast machine writes both edits with the same stamp; the order of the
    // rows, not the clock, decides what happened last.
    const [row] = h.runtime.db.all("SELECT at FROM edits WHERE path = 'Schnell.md' AND action = 'delete'");
    h.runtime.db.run("UPDATE edits SET at = ? WHERE path = 'Schnell.md'", Number(row!['at']));

    expect((await list('julian')).body.notes[0]).toMatchObject({ path: 'Schnell.md', restore: 'ready' });
  });

  it('leaves out deletes older than the window and notes that are back', async () => {
    await h.runtime.app.createNote('julian', 'Alt.md', 'alt\n', 'julian');
    await h.runtime.app.createNote('julian', 'Wieder.md', 'wieder\n', 'julian');
    await commit('julian');
    await del('julian', 'julian', 'Alt.md');
    await del('julian', 'julian', 'Wieder.md');
    await h.runtime.app.createNote('julian', 'Wieder.md', 'neu angelegt\n', 'julian');
    h.runtime.db.run(
      "UPDATE edits SET at = ? WHERE path = 'Alt.md' AND action = 'delete'",
      Date.now() - DELETED_WINDOW_MS - 60_000,
    );

    expect((await list('julian')).body.notes).toEqual([]);
    expect((await restore('julian', 'julian', 'Alt.md')).status).toBe(404);
  });
});

describe('without a history on the host', () => {
  it('lists the note but cannot restore it, and says why', async () => {
    await h.runtime.app.createNote('julian', 'Plan.md', 'ohne Verlauf\n', 'julian');
    await del('julian', 'julian', 'Plan.md');

    const [row] = (await list('julian')).body.notes;
    expect(row).toMatchObject({ path: 'Plan.md', restore: 'no-history', savedAt: null });
    const refused = await restore('julian', 'julian', 'Plan.md');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('nothing_to_restore');
  });

  it('tells a repository without a commit apart from none', async () => {
    await initRepo('julian');
    await h.runtime.app.createNote('julian', 'Plan.md', 'noch kein Takt\n', 'julian');
    await del('julian', 'julian', 'Plan.md');

    const [row] = (await list('julian')).body.notes;
    expect(row).toMatchObject({ restore: 'no-commit' });
    expect((await restore('julian', 'julian', 'Plan.md')).status).toBe(409);
  });

  it('does not take a repository the vault merely sits inside for its history', async () => {
    // The whole data directory is a repository with commits; the vault has none of its own.
    await run('git', ['init', '-q', '-b', 'main'], { cwd: h.dataDir });
    await h.runtime.app.createNote('julian', 'Plan.md', 'fremdes Repo\n', 'julian');
    await run('git', ['add', '-A'], { cwd: h.dataDir });
    await run('git', ['commit', '-q', '-m', 'außen'], { cwd: h.dataDir, env: GIT_ENV });
    await del('julian', 'julian', 'Plan.md');

    expect((await list('julian')).body.notes[0]).toMatchObject({ restore: 'no-history' });
  });
});

describe('who may see and restore a deleted note', () => {
  beforeEach(async () => {
    await initRepo('julian');
  });

  /** Everything Ramona can ask about deleted notes in Julian's vault. */
  async function probe(): Promise<Record<string, { status: number; raw: string }>> {
    const listed = await list('ramona');
    const deletedOne = await restore('ramona', 'julian', 'Projekt/Plan.md');
    const preview = await h.as('ramona', {
      method: 'POST',
      url: '/api/v1/deleted/preview',
      payload: { owner: 'julian', paths: ['Projekt/Plan.md'] },
    });
    return {
      list: { status: listed.status, raw: listed.raw },
      restore: { status: deletedOne.status, raw: deletedOne.raw },
      preview: { status: preview.status, raw: preview.raw },
    };
  }

  /** The same question about a path that never held anything. */
  async function never(): Promise<{ status: number; raw: string }> {
    const reply = await restore('ramona', 'julian', 'Projekt/Nie.md');
    return { status: reply.status, raw: reply.raw };
  }

  it('hides a deleted note from somebody who held only a note share on it — as if it never existed', async () => {
    const empty = await probe();

    await h.runtime.app.createNote('julian', 'Projekt/Plan.md', '# Plan\n\nGeheimer Inhalt.\n', 'julian');
    await h.runtime.app.grantShare('julian', 'ramona', { kind: 'note', path: 'Projekt/Plan.md' }, true);
    await commit('julian');
    // Ramona deletes it herself, with the write access the share gave her.
    await del('ramona', 'julian', 'Projekt/Plan.md');

    // Julian, the owner, sees it and who deleted it.
    expect((await list('julian')).body.notes[0]).toMatchObject({ path: 'Projekt/Plan.md', actor: 'ramona' });

    const after = await probe();
    expect(after).toEqual(empty);
    expect(after['restore']).toEqual(await never());
    expect(after['list']!.raw).toBe('{"notes":[]}');
  });

  it('keeps a note share that somehow outlived its note from becoming a key to it', async () => {
    await h.runtime.app.createNote('julian', 'Projekt/Plan.md', '# Plan\n\nGeheimer Inhalt.\n', 'julian');
    await commit('julian');
    const empty = await probe();
    await del('julian', 'julian', 'Projekt/Plan.md');
    // A stale row, as a crash between the delete and the share clean-up would leave it.
    h.runtime.db.run(
      "INSERT INTO shares (id, owner, kind, prefix, grantee, can_write, created_at, bound_at) VALUES ('shr_stale', 'julian', 'note', 'Projekt/Plan.md', 'ramona', 1, 0, 0)",
    );

    expect(await probe()).toEqual(empty);
  });

  it('hides it from a read-only folder share and from other folders', async () => {
    const empty = await probe();
    h.runtime.shares.grant('julian', 'Projekt', 'ramona', false);
    h.runtime.shares.grant('julian', 'Anderes', 'ramona', true);
    await h.runtime.app.createNote('julian', 'Projekt/Plan.md', '# Plan\n', 'julian');
    await commit('julian');
    await del('julian', 'julian', 'Projekt/Plan.md');

    expect(await probe()).toEqual(empty);
  });

  it('shows and restores it to a folder share with write access over the path', async () => {
    h.runtime.shares.grant('julian', 'Projekt', 'ramona', true);
    await h.runtime.app.createNote('julian', 'Projekt/Plan.md', '# Plan\n\nIm geteilten Ordner.\n', 'julian');
    await h.runtime.app.createNote('julian', 'Privat/Tagebuch.md', '# Tagebuch\n', 'julian');
    await commit('julian');
    await del('julian', 'julian', 'Projekt/Plan.md');
    await del('julian', 'julian', 'Privat/Tagebuch.md');

    const listed = (await list('ramona')).body.notes;
    expect(listed.map((row: { path: string }) => row.path)).toEqual(['Projekt/Plan.md']);
    expect((await restore('ramona', 'julian', 'Privat/Tagebuch.md')).status).toBe(404);

    const restored = await restore('ramona', 'julian', 'Projekt/Plan.md');
    expect(restored.status).toBe(200);
    expect(restored.body.note.content).toBe('# Plan\n\nIm geteilten Ordner.\n');
    const [edit] = h.runtime.db.all(
      "SELECT actor FROM edits WHERE path = 'Projekt/Plan.md' AND action = 'create' ORDER BY at DESC LIMIT 1",
    );
    expect(edit?.['actor']).toBe('ramona');
  });

  it('in a space, only members who may write the path', async () => {
    await h.runtime.users.createSpace('familie', 'Familie');
    await initRepo('familie');
    h.runtime.shares.grant('familie', { kind: 'folder', path: 'Ferien' }, 'ramona', false);
    h.runtime.shares.grant('familie', { kind: 'folder', path: 'Ferien' }, 'julian', true);
    await h.runtime.app.createNote('familie', 'Ferien/Packliste.md', '# Packliste\n', 'julian');
    await commit('familie');
    await del('julian', 'familie', 'Ferien/Packliste.md');

    expect((await list('julian')).body.notes[0]).toMatchObject({
      owner: 'familie',
      path: 'Ferien/Packliste.md',
      restore: 'ready',
    });
    expect((await list('ramona')).raw).toBe('{"notes":[]}');
    const refused = await restore('ramona', 'familie', 'Ferien/Packliste.md');
    const never = await restore('ramona', 'familie', 'Ferien/Nie.md');
    expect(refused.status).toBe(404);
    expect(refused.raw).toBe(never.raw);
    expect((await restore('julian', 'familie', 'Ferien/Packliste.md')).status).toBe(200);
  });
});

describe('the delete preview', () => {
  async function preview(user: string, owner: string, paths: string[]) {
    const reply = await h.as(user, { method: 'POST', url: '/api/v1/deleted/preview', payload: { owner, paths } });
    expect(reply.status).toBe(200);
    return reply.body;
  }

  it('says whether a saved version exists', async () => {
    await initRepo('julian');
    await h.runtime.app.createNote('julian', 'Gesichert.md', 'a\n', 'julian');
    await commit('julian');
    await h.runtime.app.createNote('julian', 'Neu.md', 'b\n', 'julian');

    expect(await preview('julian', 'julian', ['Gesichert.md', 'Neu.md'])).toEqual({
      restorable: 1,
      unsaved: 1,
      notYours: 0,
      history: true,
    });
  });

  it('says there is no history where the host keeps none', async () => {
    await h.runtime.app.createNote('julian', 'Plan.md', 'a\n', 'julian');
    expect(await preview('julian', 'julian', ['Plan.md'])).toEqual({
      restorable: 0,
      unsaved: 1,
      notYours: 0,
      history: false,
    });
  });

  it('counts a note the caller could not bring back as not theirs, without looking', async () => {
    await initRepo('julian');
    await h.runtime.app.createNote('julian', 'Plan.md', 'a\n', 'julian');
    await commit('julian');
    await h.runtime.app.grantShare('julian', 'ramona', { kind: 'note', path: 'Plan.md' }, true);

    expect(await preview('ramona', 'julian', ['Plan.md'])).toEqual({
      restorable: 0,
      unsaved: 0,
      notYours: 1,
      history: false,
    });
  });
});
