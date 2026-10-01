/**
 * The version of one note, asked on its own.
 *
 * `/api/v1/version/*` exists so the editor can be warned **before** it writes
 * that the file is no longer the one it loaded. The conflict copy already
 * catches the collision; this is the half that tells somebody in time to avoid
 * it. What the route must not become is a second, cheaper way to watch a
 * vault, so everything about who may ask is pinned here:
 *
 *  - the owner is told the version of their own note, and it moves when the
 *    text does — not when the clock does
 *  - the reply carries the version and nothing else: no text, no size, no
 *    stamp, no title
 *  - somebody who may write the note is told; somebody who may only read it is
 *    not, and neither is a stranger — and all three refusals are the same
 *    answer a note that does not exist gives, byte for byte
 *  - a note share whose file was replaced behind ndBrain's back is withdrawn
 *    before the version is handed out, exactly as it is for a read
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startHarness, type Harness, type Reply } from './support/harness.js';

let h: Harness;
// The real account id behind the 'julian' login — what every owner/vault
// parameter now takes, since the refactor split the typed name (login) from
// the random account id.
let julian: string;

const PLAN = 'Projekt/Plan.md';
const PLAN_TEXT = '# Plan\n\nZwei Nodes, Qdevice steht noch offen.\n';

beforeEach(async () => {
  h = await startHarness('note-version');
  for (const [id, password] of [
    ['julian', 'ein gutes passwort'],
    ['ramona', 'ihr gutes passwort'],
  ] as const) {
    await h.runtime.users.create(id, password);
    await h.login(id, password);
  }
  julian = h.runtime.users.byLogin('julian')!.id;
  await h.runtime.app.createNote(julian, PLAN, PLAN_TEXT, 'julian');
  await h.runtime.app.createNote(julian, 'Projekt/Geheim.md', '# Geheim\n\nnur für Julian\n', 'julian');
});

afterEach(async () => {
  await h.close();
});

const version = (user: string, notePath: string): Promise<Reply> =>
  h.as(user, { url: `/api/v1/version/${encodeURI(notePath)}?owner=${julian}` });

const read = (user: string, notePath: string): Promise<Reply> =>
  h.as(user, { url: `/api/v1/notes/${encodeURI(notePath)}?owner=${julian}` });

async function share(grantee: string, kind: 'note' | 'folder', sharePath: string, canWrite: boolean): Promise<void> {
  const reply = await h.as('julian', {
    method: 'POST',
    url: '/api/v1/shares',
    payload: { grantee, kind, path: sharePath, canWrite },
  });
  expect(reply.status).toBe(200);
}

describe('the owner asking about their own note', () => {
  it('is told the same version the read of that note hands out', async () => {
    const asked = await version('julian', PLAN);
    expect(asked.status).toBe(200);

    const opened = await read('julian', PLAN);
    expect(asked.body.hash).toBe(opened.body.note.hash);
  });

  it('answers the version and nothing else about the note', async () => {
    const asked = await version('julian', PLAN);
    // Named exhaustively rather than checked field by field: a field added here
    // later is a field the poll ships every two seconds, and the point of this
    // route is that it ships as little as a question can.
    expect(Object.keys(asked.body)).toEqual(['hash']);
    expect(asked.raw).not.toContain('Qdevice');
  });

  it('moves when the text changes and stands still when only the stamp does', async () => {
    const before = (await version('julian', PLAN)).body.hash;

    // A `touch`: the same bytes behind a newer stamp. This is the case the
    // whole design rests on — a version read off the clock would call this a
    // change and warn about nothing.
    const file = path.join(h.dataDir, 'vaults', julian, PLAN);
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(file, later, later);
    expect((await version('julian', PLAN)).body.hash).toBe(before);

    await h.runtime.app.putNote(julian, PLAN, `${PLAN_TEXT}\nQdevice bei Ramona.\n`, 'julian');
    expect((await version('julian', PLAN)).body.hash).not.toBe(before);
  });

  it('answers a note that is not there the way everything else does', async () => {
    const missing = await version('julian', 'Projekt/Gibtsnicht.md');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('not_found');
  });
});

describe('who may ask at all', () => {
  it('tells somebody who may write the note, and tells them when it changed', async () => {
    await share('ramona', 'note', PLAN, true);

    const before = await version('ramona', PLAN);
    expect(before.status).toBe(200);
    expect(before.body.hash).toBe((await version('julian', PLAN)).body.hash);

    await h.runtime.app.putNote(julian, PLAN, `${PLAN_TEXT}\nJulian hat weitergeschrieben.\n`, 'julian');
    expect((await version('ramona', PLAN)).body.hash).not.toBe(before.body.hash);
  });

  it('refuses a read-only grantee, a stranger and a missing note identically', async () => {
    await share('ramona', 'note', PLAN, false);
    const readOnly = await version('ramona', PLAN);
    // The share works — she can read the note. She still gets no version.
    expect((await read('ramona', PLAN)).status).toBe(200);

    for (const held of h.runtime.shares.byOwner(julian)) h.runtime.shares.revoke(held.id);
    const stranger = await version('ramona', PLAN);
    const missing = await version('ramona', 'Projekt/Gibtsnicht.md');
    const unreadable = await version('ramona', 'Projekt/Geheim.md');

    for (const refused of [stranger, missing, unreadable]) {
      expect([refused.status, refused.raw]).toEqual([readOnly.status, readOnly.raw]);
    }
    expect(readOnly.status).toBe(404);
  });

  it('withdraws a note share whose file was replaced behind ndBrain’s back before answering', async () => {
    await share('ramona', 'note', PLAN, true);
    expect((await version('ramona', PLAN)).status).toBe(200);

    // A different file at the same path, in one step, as `mv` over it does —
    // and long enough that an equal hash is not what vouches for it.
    const dir = path.join(h.dataDir, 'vaults', julian);
    await fs.writeFile(path.join(dir, 'Fremd.tmp'), '# Plan\n\nein ganz anderes Dokument, fremd und privat.\n', 'utf8');
    await fs.rename(path.join(dir, 'Fremd.tmp'), path.join(dir, PLAN));

    const after = await version('ramona', PLAN);
    expect(after.status).toBe(404);
    // And the owner still gets an answer, since nothing was withdrawn from him.
    expect((await version('julian', PLAN)).status).toBe(200);
  });

  it('is reachable through a folder share that carries write access', async () => {
    await share('ramona', 'folder', 'Projekt', true);
    expect((await version('ramona', PLAN)).status).toBe(200);
    expect((await version('ramona', 'Projekt/Geheim.md')).status).toBe(200);
  });
});
