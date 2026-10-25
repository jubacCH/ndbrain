/**
 * Task lists through the API.
 *
 * What is worth testing is mostly not the happy path:
 *
 *  - **The file is the truth.** What a route answers is what is on disk, in the
 *    format the spec names, and a list written by hand is read as written.
 *  - **The tenant boundary holds without anything new.** A list is a file, so a
 *    folder share covers it and a refusal is the 404 of a list that is not
 *    there — byte for byte.
 *  - **Changes are per field.** Two writers on one task both land, and many at
 *    once lose nothing.
 *  - **A broken file is never written over**, and the generic file routes queue
 *    behind a list change instead of landing in its middle.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TASKLIST_FORMAT } from '../../shared/tasklist.js';
import { startHarness, type Harness } from './support/harness.js';

let h: Harness;
let julian: string;
let ramona: string;

const LIST = 'Kunden/Acme/Website.tasks.json';

beforeEach(async () => {
  h = await startHarness('tasklists');
  julian = (await h.runtime.users.create('julian', 'sein gutes passwort')).id;
  ramona = (await h.runtime.users.create('ramona', 'ihr gutes passwort')).id;
  await h.login('julian', 'sein gutes passwort');
  await h.login('ramona', 'ihr gutes passwort');
});

afterEach(async () => {
  await h.close();
});

function onDisk(owner: string, vaultPath: string): string {
  return path.join(h.dataDir, 'vaults', owner, ...vaultPath.split('/'));
}

async function fileOf(owner: string, vaultPath: string): Promise<string> {
  return fs.readFile(onDisk(owner, vaultPath), 'utf8');
}

/** `owner` in the query, the way the browser names somebody else's vault. */
function url(route: string, vaultPath: string, owner?: string): string {
  return `/api/v1/${route}/${encodeURI(vaultPath)}${owner === undefined ? '' : `?owner=${owner}`}`;
}

async function create(as = 'julian', owner?: string): Promise<void> {
  const reply = await h.as(as, { method: 'POST', url: url('tasklists', LIST, owner), payload: {} });
  expect(reply.status).toBe(201);
}

async function add(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const reply = await h.as('julian', {
    method: 'POST',
    url: url('tasklist-items', LIST),
    payload: { task: { title, ...extra } },
  });
  expect(reply.status).toBe(201);
  return reply.body.task.id as string;
}

describe('a list, end to end', () => {
  it('is a file in the vault, in the format the spec names', async () => {
    await create();
    const id = await add('Send the offer', { due: '2026-10-30', priority: 'high' });

    const file = JSON.parse(await fileOf(julian, LIST));
    expect(file.ndbrain).toBe(TASKLIST_FORMAT);
    expect(file.tasks).toHaveLength(1);
    expect(file.tasks[0]).toMatchObject({
      id,
      title: 'Send the offer',
      status: 'todo',
      due: '2026-10-30',
      priority: 'high',
      parent: null,
    });

    const read = await h.as('julian', { url: url('tasklists', LIST) });
    expect(read.status).toBe(200);
    expect(read.body.name).toBe('Website');
    expect(read.body.list).toEqual(file);
  });

  it('reads a list written by hand, as written', async () => {
    const byHand = {
      ndbrain: TASKLIST_FORMAT,
      statuses: [{ id: 'open', name: 'Offen', done: false }],
      tasks: [],
      someday: 'a field a later version will know',
    };
    await fs.mkdir(path.dirname(onDisk(julian, LIST)), { recursive: true });
    await fs.writeFile(onDisk(julian, LIST), JSON.stringify(byHand));

    const id = await add('Neu');
    const file = JSON.parse(await fileOf(julian, LIST));
    expect(file.someday).toBe('a field a later version will know');
    expect(file.tasks[0]).toMatchObject({ id, status: 'open' });
  });

  it('changes only the fields a patch names', async () => {
    await create();
    const id = await add('Offerte', { tags: ['kunde'] });

    const patched = await h.as('julian', {
      method: 'PATCH',
      url: url('tasklist-items', LIST),
      payload: { id, set: { status: 'doing' } },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.task).toMatchObject({ status: 'doing', title: 'Offerte', tags: ['kunde'] });
  });

  it('removes a task together with its subtasks', async () => {
    await create();
    const parent = await add('Website');
    const child = await add('Texte', { parent });
    await add('Grandchild', { parent: child });
    const other = await add('Anderes');

    const reply = await h.as('julian', {
      method: 'DELETE',
      url: `${url('tasklist-items', LIST)}?id=${parent}`,
    });
    expect(reply.status).toBe(200);
    expect(reply.body.removed).toHaveLength(3);

    const file = JSON.parse(await fileOf(julian, LIST));
    expect(file.tasks.map((task: { id: string }) => task.id)).toEqual([other]);
  });

  it('puts new tasks at the end', async () => {
    await create();
    for (const title of ['a', 'b', 'c', 'd']) await add(title);
    const file = JSON.parse(await fileOf(julian, LIST));
    const orders = file.tasks.map((task: { order: string }) => task.order);
    expect(orders).toEqual([...orders].sort());
  });
});

describe('what a list refuses', () => {
  it('a status it does not have, and a parent that would make a loop', async () => {
    await create();
    const parent = await add('Parent');
    const child = await add('Child', { parent });

    const unknownStatus = await h.as('julian', {
      method: 'PATCH',
      url: url('tasklist-items', LIST),
      payload: { id: child, set: { status: 'archived' } },
    });
    expect(unknownStatus.status).toBe(400);
    expect(unknownStatus.body.code).toBe('invalid_task');

    const loop = await h.as('julian', {
      method: 'PATCH',
      url: url('tasklist-items', LIST),
      payload: { id: parent, set: { parent: child } },
    });
    expect(loop.status).toBe(400);
    expect(loop.body.code).toBe('invalid_task');
  });

  it('a field it does not know, in a request', async () => {
    await create();
    const id = await add('Offerte');
    const reply = await h.as('julian', {
      method: 'PATCH',
      url: url('tasklist-items', LIST),
      payload: { id, set: { stauts: 'done' } },
    });
    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe('invalid_body');
  });

  it('a second list of the same name, in any letter case', async () => {
    await create();
    const same = await h.as('julian', { method: 'POST', url: url('tasklists', LIST), payload: {} });
    expect(same.status).toBe(409);
    const folded = await h.as('julian', {
      method: 'POST',
      url: url('tasklists', 'Kunden/Acme/WEBSITE.tasks.json'),
      payload: {},
    });
    expect(folded.status).toBe(409);
    expect(folded.body.code).toBe('case_collision');
  });

  it('a path that is not a list', async () => {
    const reply = await h.as('julian', { method: 'POST', url: url('tasklists', 'Kunden/Acme.json'), payload: {} });
    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe('invalid_path');
  });

  it('to be written over while the file is broken', async () => {
    await create();
    const broken = '{ "ndbrain": "tasklist/1", "statuses": [ \n';
    await fs.writeFile(onDisk(julian, LIST), broken);

    const read = await h.as('julian', { url: url('tasklists', LIST) });
    expect(read.status).toBe(422);
    expect(read.body.code).toBe('tasklist_invalid');

    const write = await h.as('julian', {
      method: 'POST',
      url: url('tasklist-items', LIST),
      payload: { task: { title: 'Would replace the file' } },
    });
    expect(write.status).toBe(422);
    expect(await fileOf(julian, LIST)).toBe(broken);
  });
});

describe('two writers', () => {
  it('both land when they change different fields of one task', async () => {
    await create();
    const id = await add('Offerte');
    const [status, due] = await Promise.all([
      h.as('julian', {
        method: 'PATCH',
        url: url('tasklist-items', LIST),
        payload: { id, set: { status: 'done' } },
      }),
      h.as('julian', {
        method: 'PATCH',
        url: url('tasklist-items', LIST),
        payload: { id, set: { due: '2026-11-02' } },
      }),
    ]);
    expect([status.status, due.status]).toEqual([200, 200]);
    const file = JSON.parse(await fileOf(julian, LIST));
    expect(file.tasks[0]).toMatchObject({ status: 'done', due: '2026-11-02' });
  });

  it('lose nothing when many add at once', async () => {
    await create();
    const ids = await Promise.all(Array.from({ length: 25 }, (_, i) => add(`Task ${i}`)));
    const file = JSON.parse(await fileOf(julian, LIST));
    expect(new Set(file.tasks.map((task: { id: string }) => task.id))).toEqual(new Set(ids));
  });

  it('an upload through the file routes waits for a list change in progress', async () => {
    await create();
    const order: string[] = [];
    let release!: () => void;
    const held = h.runtime.app.tasklists.withLock(julian, LIST, async () => {
      order.push('list change');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    const upload = h.server
      .inject({
        method: 'POST',
        url: url('files', LIST),
        headers: { cookie: h.cookieOf('julian'), 'content-type': 'application/octet-stream' },
        payload: Buffer.from(JSON.stringify({ ndbrain: TASKLIST_FORMAT, statuses: [{ id: 'x', name: 'X', done: false }], tasks: [] })),
      })
      .then((reply) => {
        order.push('upload');
        return reply;
      });

    // Give the upload every chance to overtake the lock.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual(['list change']);
    release();
    await held;
    expect((await upload).statusCode).toBe(200);
    expect(order).toEqual(['list change', 'upload']);
  });
});

describe('the tenant boundary', () => {
  it('answers a stranger exactly as it answers for a list that is not there', async () => {
    await create();
    const theirs = await h.as('ramona', { url: url('tasklists', LIST, julian) });
    const nothing = await h.as('ramona', { url: url('tasklists', 'Kunden/Nichts.tasks.json', julian) });
    const ownMissing = await h.as('julian', { url: url('tasklists', 'Kunden/Nichts.tasks.json') });
    expect(theirs.status).toBe(404);
    expect(theirs.raw).toBe(nothing.raw);
    expect(theirs.raw).toBe(ownMissing.raw);

    const write = await h.as('ramona', {
      method: 'POST',
      url: url('tasklist-items', LIST, julian),
      payload: { task: { title: 'Eingeschmuggelt' } },
    });
    expect(write.status).toBe(404);
    expect(write.raw).toBe(nothing.raw);
    expect(JSON.parse(await fileOf(julian, LIST)).tasks).toEqual([]);
  });

  it('lets a read-only folder share read the lists in it and change none', async () => {
    await create();
    h.runtime.shares.grant(julian, 'Kunden/', ramona, false);

    expect((await h.as('ramona', { url: url('tasklists', LIST, julian) })).status).toBe(200);

    const write = await h.as('ramona', {
      method: 'POST',
      url: url('tasklist-items', LIST, julian),
      payload: { task: { title: 'Nope' } },
    });
    const nothing = await h.as('ramona', { url: url('tasklists', 'Kunden/Nichts.tasks.json', julian) });
    expect(write.status).toBe(404);
    expect(write.raw).toBe(nothing.raw);
  });

  it('lets a writable folder share change the lists in it, and only those', async () => {
    await create();
    await fs.mkdir(path.dirname(onDisk(julian, 'Privat/Geheim.tasks.json')), { recursive: true });
    await h.as('julian', { method: 'POST', url: url('tasklists', 'Privat/Geheim.tasks.json'), payload: {} });
    h.runtime.shares.grant(julian, 'Kunden/', ramona, true);

    const inside = await h.as('ramona', {
      method: 'POST',
      url: url('tasklist-items', LIST, julian),
      payload: { task: { title: 'Von Ramona' } },
    });
    expect(inside.status).toBe(201);

    const outside = await h.as('ramona', { url: url('tasklists', 'Privat/Geheim.tasks.json', julian) });
    expect(outside.status).toBe(404);
  });

  it('keeps a grantee from creating a list outside the shared folder', async () => {
    h.runtime.shares.grant(julian, 'Kunden/', ramona, true);
    const reply = await h.as('ramona', {
      method: 'POST',
      url: url('tasklists', 'Privat/Neu.tasks.json', julian),
      payload: {},
    });
    expect(reply.status).toBe(404);
    await expect(fs.stat(onDisk(julian, 'Privat/Neu.tasks.json'))).rejects.toThrow();
  });
});
