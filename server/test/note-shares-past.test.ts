/**
 * A note share reaches the note, not everything that ever had its name.
 *
 * Two surfaces keep a past that belongs to a path rather than to a note: the
 * git history and the edit log. Before a note was shared, an earlier note
 * with the same name may have lived there and been deleted — or, after a
 * rename, the share may now name a path that another note used to have. None
 * of that is the grantee's. So for a caller who reaches a note only through a
 * note share, both surfaces start at the moment the share came to name that
 * path: when it was granted, or when it last moved.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from './support/harness.js';

const run = promisify(execFile);
const HOUR = 60 * 60 * 1000;

let h: Harness;

async function initRepo(owner: string): Promise<void> {
  const cwd = path.join(h.dataDir, 'vaults', owner);
  await run('git', ['init', '-q', '-b', 'main'], { cwd });
  await run('git', ['config', 'user.email', 'ndbrain@localhost'], { cwd });
  await run('git', ['config', 'user.name', 'ndBrain'], { cwd });
}

/** Commits the vault as the host timer would, dated `at`. */
async function commit(owner: string, subject: string, at: number): Promise<void> {
  const cwd = path.join(h.dataDir, 'vaults', owner);
  const date = new Date(at).toISOString();
  await run('git', ['add', '-A'], { cwd });
  await run('git', ['commit', '-q', '-m', subject, '--allow-empty'], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

beforeEach(async () => {
  h = await startHarness('note-past');
  await h.runtime.users.create('julian', 'ein gutes passwort');
  await h.runtime.users.create('ramona', 'ihr gutes passwort');
  await h.login('julian', 'ein gutes passwort');
  await h.login('ramona', 'ihr gutes passwort');
  await initRepo('julian');
});

afterEach(async () => {
  await h.close();
});

/** An earlier note called Plan.md, edited, committed and deleted; then a new one. */
async function aPastUnderTheSameName(): Promise<void> {
  const app = h.runtime.app;
  await app.createNote('julian', 'Projekt/Plan.md', '# Plan\n\nalter geheimer Plan\n', 'julian');
  await commit('julian', 'Stand 1', Date.now() - 3 * HOUR);
  await app.putNote('julian', 'Projekt/Plan.md', '# Plan\n\nalter geheimer Plan, überarbeitet\n', 'peter-agent');
  await commit('julian', 'Stand 2', Date.now() - 2 * HOUR);
  await app.deleteNote('julian', 'Projekt/Plan.md', 'julian');
  h.runtime.db.run("UPDATE edits SET at = at - ? WHERE path = 'Projekt/Plan.md'", 2 * HOUR);
  await app.createNote('julian', 'Projekt/Plan.md', '# Plan\n\nder neue Plan\n', 'julian');
  h.runtime.db.run(
    "UPDATE edits SET at = ? WHERE path = 'Projekt/Plan.md' AND action = 'create' AND at = (SELECT MAX(at) FROM edits WHERE path = 'Projekt/Plan.md')",
    Date.now() - HOUR,
  );
  await commit('julian', 'Stand 3', Date.now() - HOUR);
}

async function shareNote(canWrite = true): Promise<void> {
  const reply = await h.as('julian', {
    method: 'POST',
    url: '/api/v1/shares',
    payload: { grantee: 'ramona', kind: 'note', path: 'Projekt/Plan.md', canWrite },
  });
  expect(reply.status).toBe(200);
}

describe('the history of a shared note', () => {
  it('starts, for the grantee, when the share was given', async () => {
    await aPastUnderTheSameName();
    await shareNote();

    const owner = await h.as('julian', { url: '/api/v1/history/Projekt/Plan.md' });
    expect(owner.body.versions).toHaveLength(3);
    const old = owner.body.versions[2].id as string;

    const before = await h.as('ramona', { url: '/api/v1/history/Projekt/Plan.md?owner=julian' });
    expect(before.body).toEqual({ available: true, versions: [] });

    await h.runtime.app.putNote('julian', 'Projekt/Plan.md', '# Plan\n\nder neue Plan, weiter\n', 'julian');
    await commit('julian', 'Stand 4', Date.now() + HOUR);
    const after = await h.as('ramona', { url: '/api/v1/history/Projekt/Plan.md?owner=julian' });
    expect(after.body.versions.map((version: { subject: string }) => version.subject)).toEqual(['Stand 4']);

    const missing = await h.as('ramona', {
      url: '/api/v1/history/Projekt/Plan.md?owner=julian&version=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    const reading = await h.as('ramona', { url: `/api/v1/history/Projekt/Plan.md?owner=julian&version=${old}` });
    expect({ status: reading.status, raw: reading.raw }).toEqual({ status: missing.status, raw: missing.raw });
    expect(reading.raw).not.toContain('geheim');

    const restoring = await h.as('ramona', {
      method: 'POST',
      url: '/api/v1/history/restore',
      payload: { owner: 'julian', path: 'Projekt/Plan.md', version: old },
    });
    expect(restoring.status).toBe(404);
    expect((await h.runtime.app.notes.getNote('julian', 'Projekt/Plan.md')).content).not.toContain('geheim');
  });

  it('starts again when the share moves to a path with a past of its own', async () => {
    await aPastUnderTheSameName();
    await h.runtime.app.createNote('julian', 'Projekt/Neu.md', '# Neu\n', 'julian');
    const reply = await h.as('julian', {
      method: 'POST',
      url: '/api/v1/shares',
      payload: { grantee: 'ramona', kind: 'note', path: 'Projekt/Neu.md', canWrite: false },
    });
    expect(reply.status).toBe(200);
    // The share was given hours after Plan.md's past; the rename is now.
    h.runtime.db.run("UPDATE shares SET bound_at = ? WHERE kind = 'note'", Date.now() - 4 * HOUR);
    await h.runtime.app.deleteNote('julian', 'Projekt/Plan.md', 'julian');
    await h.as('julian', {
      method: 'POST',
      url: '/api/v1/rename',
      payload: { from: 'Projekt/Neu.md', to: 'Projekt/Plan.md' },
    });

    const history = await h.as('ramona', { url: '/api/v1/history/Projekt/Plan.md?owner=julian' });
    expect(history.body.versions).toEqual([]);
    // The rename itself is the note's own and shows; the old Plan.md's edits do not.
    const activity = await h.as('ramona', { url: '/api/v1/overview?days=30' });
    expect(activity.body.activity.filter((row: { owner: string }) => row.owner === 'julian')).toEqual([
      expect.objectContaining({ path: 'Projekt/Plan.md', action: 'rename', edits: 1, actor: 'julian' }),
    ]);
  });

  it('is left whole for a grantee of the folder, and for the owner', async () => {
    await aPastUnderTheSameName();
    h.runtime.shares.grant('julian', 'Projekt', 'ramona', false);
    await shareNote();
    const history = await h.as('ramona', { url: '/api/v1/history/Projekt/Plan.md?owner=julian' });
    expect(history.body.versions).toHaveLength(3);
  });
});

describe('the activity of a shared note', () => {
  it('shows the grantee only what happened to the note since it was shared', async () => {
    await aPastUnderTheSameName();
    await shareNote();

    const before = await h.as('ramona', { url: '/api/v1/overview?days=30' });
    expect(before.body.activity.filter((row: { owner: string }) => row.owner === 'julian')).toEqual([]);

    await h.as('ramona', {
      method: 'PUT',
      url: '/api/v1/notes/Projekt/Plan.md?owner=julian',
      payload: { content: '# Plan\n\nvon Ramona\n' },
    });
    const after = await h.as('ramona', { url: '/api/v1/overview?days=30' });
    const rows = after.body.activity.filter((row: { owner: string }) => row.owner === 'julian');
    expect(rows).toEqual([
      expect.objectContaining({ path: 'Projekt/Plan.md', actor: 'ramona', action: 'update', edits: 1 }),
    ]);
    expect(JSON.stringify(after.body)).not.toContain('peter-agent');

    const owner = await h.as('julian', { url: '/api/v1/overview?days=30' });
    expect(owner.body.activity.find((row: { path: string }) => row.path === 'Projekt/Plan.md').edits).toBe(5);
  });
});
