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
/** Real account ids behind the login names, captured once the accounts exist. */
let julianId: string;
let ramonaId: string;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'ndBrain',
  GIT_AUTHOR_EMAIL: 'ndbrain@localhost',
  GIT_COMMITTER_NAME: 'ndBrain',
  GIT_COMMITTER_EMAIL: 'ndbrain@localhost',
};

function vaultDir(owner: string): string {
  const id = h.runtime.users.byLogin(owner)?.id ?? owner;
  return path.join(h.dataDir, 'vaults', id);
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
  const ownerId = h.runtime.users.byLogin(owner)?.id ?? owner;
  const reply = await h.as(user, {
    method: 'DELETE',
    url: `/api/v1/notes/${encodeURI(notePath)}?owner=${ownerId}`,
  });
  expect(reply.status).toBe(204);
}

async function list(user: string) {
  return h.as(user, { url: '/api/v1/deleted' });
}

async function restore(user: string, owner: string, notePath: string) {
  const ownerId = h.runtime.users.byLogin(owner)?.id ?? owner;
  return h.as(user, { method: 'POST', url: '/api/v1/deleted/restore', payload: { owner: ownerId, path: notePath } });
}

async function read(user: string, owner: string, notePath: string) {
  const ownerId = h.runtime.users.byLogin(owner)?.id ?? owner;
  return h.as(user, { url: `/api/v1/notes/${encodeURI(notePath)}?owner=${ownerId}` });
}

beforeEach(async () => {
  const harness = await startHarness('deleted');
  for (const [id, password, role] of [
    ['admin', 'ein gutes passwort', 'admin'],
    ['julian', 'sein gutes passwort', 'user'],
    ['ramona', 'ihr gutes passwort', 'user'],
  ] as const) {
    const created = await harness.runtime.users.create(id, password, { role });
    await harness.login(id, password);
    if (id === 'julian') julianId = created.id;
    if (id === 'ramona') ramonaId = created.id;
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
    await h.runtime.app.createNote(julianId, 'Projekt/Plan.md', '# Plan\n\nDer letzte Stand.\n', 'julian');
    await commit('julian');
    const before = Date.now();
    await del('julian', 'julian', 'Projekt/Plan.md');

    const listed = await list('julian');
    expect(listed.status).toBe(200);
    expect(listed.body.notes).toHaveLength(1);
    const [row] = listed.body.notes;
    expect(row).toMatchObject({
      owner: julianId,
      path: 'Projekt/Plan.md',
      title: 'Plan',
      folder: 'Projekt',
      actor: julianId,
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
    expect(h.runtime.app.queries.getNote(julianId, julianId, 'Projekt/Plan.md')).toBeDefined();

    // A second restore finds nothing to restore.
    expect((await restore('julian', 'julian', 'Projekt/Plan.md')).status).toBe(404);
  });

  it('brings back the last saved version before the delete, not a later note of that name', async () => {
    await h.runtime.app.createNote(julianId, 'Plan.md', 'Erste Notiz, gelöscht.\n', 'julian');
    await commit('julian');
    await del('julian', 'julian', 'Plan.md');
    await commit('julian');
    await h.runtime.app.createNote(julianId, 'Plan.md', 'Zweite Notiz mit dem Namen.\n', 'julian');
    await commit('julian');
    await del('julian', 'julian', 'Plan.md');

    const restored = await restore('julian', 'julian', 'Plan.md');
    expect(restored.status).toBe(200);
    expect(restored.body.note.content).toBe('Zweite Notiz mit dem Namen.\n');
  });

  it('never brings back what was saved at the path after the delete', async () => {
    await h.runtime.app.createNote(julianId, 'Plan.md', 'Vor dem Löschen.\n', 'julian');
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
    await h.runtime.app.createNote(julianId, 'Plan.md', 'Erste Fassung.\n', 'julian');
    await commit('julian');
    await del('julian', 'julian', 'Plan.md');
    await commit('julian');
    const [first] = (await h.runtime.history.versions(julianId, 'Plan.md')).versions;
    await h.runtime.app.createNote(julianId, 'Plan.md', 'Nie gesichert.\n', 'julian');
    await del('julian', 'julian', 'Plan.md');

    const [row] = (await list('julian')).body.notes;
    expect(row.restore).toBe('ready');
    const { versions } = await h.runtime.history.versions(julianId, 'Plan.md');
    expect(versions[0]?.id).toBe(first?.id);
    expect(row.savedAt).toBe(versions[1]?.at);
    const restored = await restore('julian', 'julian', 'Plan.md');
    expect(restored.status).toBe(200);
    expect(restored.body.note.content).toBe('Erste Fassung.\n');
  });

  it('comes back under a free name when the path is taken, and leaves what is there alone', async () => {
    await h.runtime.app.createNote(julianId, 'Projekt/Plan.md', 'Alter Plan.\n', 'julian');
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
    await h.runtime.app.createNote(julianId, 'Plan.md', 'Alter Plan.\n', 'julian');
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
    await h.runtime.app.createNote(julianId, 'Plan.md', 'Einmal bitte.\n', 'julian');
    await commit('julian');
    await del('julian', 'julian', 'Plan.md');

    const replies = await Promise.all([restore('julian', 'julian', 'Plan.md'), restore('julian', 'julian', 'Plan.md')]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 404]);
    const names = (await fs.readdir(vaultDir('julian'))).filter((name) => name.endsWith('.md'));
    expect(names).toEqual(['Plan.md']);
  });

  it('gives no share back: a restored note is a new file', async () => {
    await h.runtime.app.createNote(julianId, 'Plan.md', '# Plan\n\nGeteilt, dann gelöscht.\n', 'julian');
    await h.runtime.app.grantShare(julianId, ramonaId, { kind: 'note', path: 'Plan.md' }, true);
    expect((await read('ramona', 'julian', 'Plan.md')).status).toBe(200);
    await commit('julian');
    await del('julian', 'julian', 'Plan.md');

    expect((await restore('julian', 'julian', 'Plan.md')).status).toBe(200);
    expect(h.runtime.shares.byOwner(julianId)).toEqual([]);
    expect((await read('ramona', 'julian', 'Plan.md')).status).toBe(404);
  });

  it('marks a note no saved version holds, and refuses to invent one', async () => {
    await h.runtime.app.createNote(julianId, 'Alt.md', 'gesichert\n', 'julian');
    await commit('julian');
    await h.runtime.app.createNote(julianId, 'Flüchtig.md', 'zwischen zwei Takten\n', 'julian');
    await del('julian', 'julian', 'Flüchtig.md');

    const [row] = (await list('julian')).body.notes;
    expect(row).toMatchObject({ path: 'Flüchtig.md', restore: 'no-version', savedAt: null });
    const refused = await restore('julian', 'julian', 'Flüchtig.md');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('nothing_to_restore');
    await expect(fs.access(path.join(vaultDir('julian'), 'Flüchtig.md'))).rejects.toThrow();
  });

  it('lists a note created and deleted within the same millisecond', async () => {
    await h.runtime.app.createNote(julianId, 'Schnell.md', 'im selben Takt\n', 'julian');
    await commit('julian');
    await del('julian', 'julian', 'Schnell.md');
    // A fast machine writes both edits with the same stamp; the order of the
    // rows, not the clock, decides what happened last.
    const [row] = h.runtime.db.all("SELECT at FROM edits WHERE path = 'Schnell.md' AND action = 'delete'");
    h.runtime.db.run("UPDATE edits SET at = ? WHERE path = 'Schnell.md'", Number(row!['at']));

    expect((await list('julian')).body.notes[0]).toMatchObject({ path: 'Schnell.md', restore: 'ready' });
  });

  it('leaves out deletes older than the window and notes that are back', async () => {
    await h.runtime.app.createNote(julianId, 'Alt.md', 'alt\n', 'julian');
    await h.runtime.app.createNote(julianId, 'Wieder.md', 'wieder\n', 'julian');
    await commit('julian');
    await del('julian', 'julian', 'Alt.md');
    await del('julian', 'julian', 'Wieder.md');
    await h.runtime.app.createNote(julianId, 'Wieder.md', 'neu angelegt\n', 'julian');
    // The whole note, moved out of the window: its create as well, or the
    // create would be the last thing that happened to the path anyway.
    h.runtime.db.run("UPDATE edits SET at = ? WHERE path = 'Alt.md'", Date.now() - DELETED_WINDOW_MS - 60_000);

    expect((await list('julian')).body.notes).toEqual([]);
    expect((await restore('julian', 'julian', 'Alt.md')).status).toBe(404);
  });
});

describe('without a history on the host', () => {
  it('lists the note but cannot restore it, and says why', async () => {
    await h.runtime.app.createNote(julianId, 'Plan.md', 'ohne Verlauf\n', 'julian');
    await del('julian', 'julian', 'Plan.md');

    const [row] = (await list('julian')).body.notes;
    expect(row).toMatchObject({ path: 'Plan.md', restore: 'no-history', savedAt: null });
    const refused = await restore('julian', 'julian', 'Plan.md');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('nothing_to_restore');
  });

  it('answers a path that was never deleted like a note that never existed, history or not', async () => {
    // The owner, in their own vault, with no sidecar at all: still the 404 of a
    // missing note, not a complaint about the history — that answer is only for
    // a note that really is in the list.
    const refused = await restore('julian', 'julian', 'Nie.md');
    expect(refused.status).toBe(404);
    expect(refused.body.code).toBe('not_found');
  });

  it('tells a repository without a commit apart from none', async () => {
    await initRepo('julian');
    await h.runtime.app.createNote(julianId, 'Plan.md', 'noch kein Takt\n', 'julian');
    await del('julian', 'julian', 'Plan.md');

    const [row] = (await list('julian')).body.notes;
    expect(row).toMatchObject({ restore: 'no-commit' });
    expect((await restore('julian', 'julian', 'Plan.md')).status).toBe(409);
  });

  it('does not take a repository the vault merely sits inside for its history', async () => {
    // The whole data directory is a repository with commits; the vault has none of its own.
    await run('git', ['init', '-q', '-b', 'main'], { cwd: h.dataDir });
    await h.runtime.app.createNote(julianId, 'Plan.md', 'fremdes Repo\n', 'julian');
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
      payload: { owner: julianId, paths: ['Projekt/Plan.md'] },
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

    await h.runtime.app.createNote(julianId, 'Projekt/Plan.md', '# Plan\n\nGeheimer Inhalt.\n', 'julian');
    await h.runtime.app.grantShare(julianId, ramonaId, { kind: 'note', path: 'Projekt/Plan.md' }, true);
    await commit('julian');
    // Ramona deletes it herself, with the write access the share gave her.
    await del('ramona', 'julian', 'Projekt/Plan.md');

    // Julian, the owner, sees it and who deleted it.
    expect((await list('julian')).body.notes[0]).toMatchObject({ path: 'Projekt/Plan.md', actor: ramonaId });

    const after = await probe();
    expect(after).toEqual(empty);
    expect(after['restore']).toEqual(await never());
    expect(after['list']!.raw).toBe('{"notes":[]}');
  });

  it('keeps a note share that somehow outlived its note from becoming a key to it', async () => {
    await h.runtime.app.createNote(julianId, 'Projekt/Plan.md', '# Plan\n\nGeheimer Inhalt.\n', 'julian');
    await commit('julian');
    const empty = await probe();
    await del('julian', 'julian', 'Projekt/Plan.md');
    // A stale row, as a crash between the delete and the share clean-up would leave it.
    h.runtime.db.run(
      "INSERT INTO shares (id, owner, kind, prefix, grantee, can_write, created_at, bound_at) VALUES ('shr_stale', ?, 'note', 'Projekt/Plan.md', ?, 1, 0, 0)",
      julianId,
      ramonaId,
    );

    expect(await probe()).toEqual(empty);
  });

  it('hides it from a read-only folder share and from other folders', async () => {
    const empty = await probe();
    h.runtime.shares.grant(julianId, 'Projekt', ramonaId, false);
    h.runtime.shares.grant(julianId, 'Anderes', ramonaId, true);
    await h.runtime.app.createNote(julianId, 'Projekt/Plan.md', '# Plan\n', 'julian');
    await commit('julian');
    await del('julian', 'julian', 'Projekt/Plan.md');

    expect(await probe()).toEqual(empty);
  });

  it('shows and restores it to a folder share with write access over the path', async () => {
    h.runtime.shares.grant(julianId, 'Projekt', ramonaId, true);
    await h.runtime.app.createNote(julianId, 'Projekt/Plan.md', '# Plan\n\nIm geteilten Ordner.\n', 'julian');
    await h.runtime.app.createNote(julianId, 'Privat/Tagebuch.md', '# Tagebuch\n', 'julian');
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
    expect(edit?.['actor']).toBe(ramonaId);
  });

  it('in a space, only members who may write the path', async () => {
    const familieId = (await h.runtime.users.createSpace('familie', 'Familie')).id;
    await initRepo('familie');
    h.runtime.shares.grant(familieId, { kind: 'folder', path: 'Ferien' }, ramonaId, false);
    h.runtime.shares.grant(familieId, { kind: 'folder', path: 'Ferien' }, julianId, true);
    await h.runtime.app.createNote(familieId, 'Ferien/Packliste.md', '# Packliste\n', 'julian');
    await commit('familie');
    await del('julian', 'familie', 'Ferien/Packliste.md');

    expect((await list('julian')).body.notes[0]).toMatchObject({
      owner: familieId,
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
    const ownerId = h.runtime.users.byLogin(owner)?.id ?? owner;
    const reply = await h.as(user, {
      method: 'POST',
      url: '/api/v1/deleted/preview',
      payload: { owner: ownerId, paths },
    });
    expect(reply.status).toBe(200);
    return reply.body;
  }

  it('says whether a saved version exists', async () => {
    await initRepo('julian');
    await h.runtime.app.createNote(julianId, 'Gesichert.md', 'a\n', 'julian');
    await commit('julian');
    await h.runtime.app.createNote(julianId, 'Neu.md', 'b\n', 'julian');

    expect(await preview('julian', 'julian', ['Gesichert.md', 'Neu.md'])).toEqual({
      restorable: 1,
      unsaved: 1,
      notYours: 0,
      unknown: 0,
      history: 'ready',
    });
  });

  it('says there is no history where the host keeps none', async () => {
    await h.runtime.app.createNote(julianId, 'Plan.md', 'a\n', 'julian');
    expect(await preview('julian', 'julian', ['Plan.md'])).toEqual({
      restorable: 0,
      unsaved: 1,
      notYours: 0,
      unknown: 0,
      history: 'none',
    });
  });

  it('counts a note the caller could not bring back as not theirs, without looking', async () => {
    await initRepo('julian');
    await h.runtime.app.createNote(julianId, 'Plan.md', 'a\n', 'julian');
    await commit('julian');
    await h.runtime.app.grantShare(julianId, ramonaId, { kind: 'note', path: 'Plan.md' }, true);

    expect(await preview('ramona', 'julian', ['Plan.md'])).toEqual({
      restorable: 0,
      unsaved: 0,
      notYours: 1,
      unknown: 0,
      history: 'none',
    });
  });
});

/**
 * A history that is there and cannot be read.
 *
 * Kept apart from "no history on the host" above on purpose, because that is
 * the confusion being fixed: both used to answer `no-history`, so a vault whose
 * repository had broken was told "this server keeps no history, so it cannot be
 * restored" — a flat statement of loss about notes whose versions were sitting
 * right there. The copy for `broken` promises nothing instead, and the restore
 * refuses with a different code so a client can tell "gone" from "come back".
 */
describe('with a history the server cannot read', () => {
  /** A repository git will not accept: the object store is gone. */
  async function breakRepo(owner: string): Promise<void> {
    await fs.rm(path.join(vaultDir(owner), '.git', 'objects'), { recursive: true, force: true });
  }

  async function preview(user: string, owner: string, paths: string[]) {
    const ownerId = h.runtime.users.byLogin(owner)?.id ?? owner;
    const reply = await h.as(user, {
      method: 'POST',
      url: '/api/v1/deleted/preview',
      payload: { owner: ownerId, paths },
    });
    expect(reply.status).toBe(200);
    return reply.body;
  }

  it('says the way back is unknown rather than that there is none', async () => {
    await initRepo('julian');
    await h.runtime.app.createNote(julianId, 'Plan.md', 'Vor dem Löschen.\n', 'julian');
    await commit('julian');
    await del('julian', 'julian', 'Plan.md');
    await breakRepo('julian');

    const [row] = (await list('julian')).body.notes;
    expect(row).toMatchObject({ path: 'Plan.md', restore: 'broken', savedAt: null });
  });

  it('refuses the restore as unreadable, not as nothing to restore', async () => {
    await initRepo('julian');
    await h.runtime.app.createNote(julianId, 'Plan.md', 'Vor dem Löschen.\n', 'julian');
    await commit('julian');
    await del('julian', 'julian', 'Plan.md');
    await breakRepo('julian');

    const refused = await restore('julian', 'julian', 'Plan.md');
    // 409 `nothing_to_restore` is the answer for a note no saved version holds,
    // and it is final. This one is worth trying again once somebody has fixed
    // the repository, and the status says so.
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe('history_unreadable');
  });

  it('one unreadable vault does not hide the deleted notes in the others', async () => {
    // The list spans every vault the caller can restore in, so a throw would
    // take the working ones down with the broken one.
    await initRepo('julian');
    const familieId = (await h.runtime.users.createSpace('familie', 'Familie')).id;
    await initRepo('familie');
    h.runtime.shares.grant(familieId, { kind: 'folder', path: 'Ferien' }, julianId, true);
    await h.runtime.app.createNote(familieId, 'Ferien/Plan.md', 'geteilt\n', 'julian');
    await commit('familie');
    await h.runtime.app.createNote(julianId, 'Eigen.md', 'meins\n', 'julian');
    await commit('julian');
    await del('julian', 'familie', 'Ferien/Plan.md');
    await del('julian', 'julian', 'Eigen.md');
    await breakRepo('julian');

    const rows = (await list('julian')).body.notes as Array<{ path: string; restore: string }>;
    const byPath = new Map(rows.map((row) => [row.path, row.restore]));
    expect(byPath.get('Eigen.md')).toBe('broken');
    expect(byPath.get('Ferien/Plan.md')).toBe('ready');
  });

  it('counts the notes it could not look up separately in the delete question', async () => {
    await initRepo('julian');
    await h.runtime.app.createNote(julianId, 'Eins.md', 'a\n', 'julian');
    await h.runtime.app.createNote(julianId, 'Zwei.md', 'b\n', 'julian');
    await commit('julian');
    await breakRepo('julian');

    // Not `unsaved`, which the confirmation renders as "no version of them has
    // been saved yet" — a claim nothing here is in a position to make.
    expect(await preview('julian', 'julian', ['Eins.md', 'Zwei.md'])).toEqual({
      restorable: 0,
      unsaved: 0,
      notYours: 0,
      unknown: 2,
      history: 'broken',
    });
  });
});

/**
 * The half of the damage that gets past the state probe.
 *
 * `state` reads the commit at HEAD and nothing else, so a repository missing
 * only the tree that commit points at still answers `ready` — and every
 * per-note read then fails, because a path can only be looked up through a
 * tree. This is the fixture that actually exercises the two places `DeletedNotes`
 * has to catch for itself; with a repository broken any harder, `state` reports
 * `broken` first and those lines are never reached.
 *
 * It is not a contrived shape. A partially fetched or partially restored
 * repository, and a disk that lost one object, look exactly like this.
 */
describe('with a history that reads at the top and not below it', () => {
  /** Removes the loose object for HEAD's root tree, leaving the commit intact. */
  async function dropRootTree(owner: string): Promise<void> {
    const cwd = vaultDir(owner);
    const tree = (await run('git', ['rev-parse', 'HEAD^{tree}'], { cwd })).stdout.trim();
    await fs.rm(path.join(cwd, '.git', 'objects', tree.slice(0, 2), tree.slice(2)), { force: true });
  }

  beforeEach(async () => {
    await initRepo('julian');
    await h.runtime.app.createNote(julianId, 'Plan.md', 'Vor dem Löschen.\n', 'julian');
    await commit('julian');
  });

  it('is ready at the top and still reports the note as unreadable', async () => {
    await del('julian', 'julian', 'Plan.md');
    await dropRootTree('julian');

    // The state probe is satisfied, which is the whole reason the per-note
    // paths need their own answer rather than relying on it.
    expect(await h.runtime.history.state(julianId)).toBe('ready');

    const [row] = (await list('julian')).body.notes;
    expect(row).toMatchObject({ path: 'Plan.md', restore: 'broken', savedAt: null });
  });

  it('refuses the restore rather than claiming no version holds the note', async () => {
    await del('julian', 'julian', 'Plan.md');
    await dropRootTree('julian');

    const refused = await restore('julian', 'julian', 'Plan.md');
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe('history_unreadable');
  });

  it('does not promise the delete question a way back it could not find', async () => {
    await dropRootTree('julian');

    const reply = await h.as('julian', {
      method: 'POST',
      url: '/api/v1/deleted/preview',
      payload: { owner: julianId, paths: ['Plan.md'] },
    });

    // The confirmation still has to appear — refusing to answer would leave the
    // question with nothing to say about the way back at all — and it has to
    // say the way back is unknown rather than that there is none.
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      restorable: 0,
      unsaved: 0,
      notYours: 0,
      unknown: 1,
      history: 'broken',
    });
  });
});
