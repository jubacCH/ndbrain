/**
 * What spaces add to the surface, checked in two worlds.
 *
 * The owner list in the tree, folder operations inside a space and the
 * administrator's view of a space's structure. Each is run once against a
 * small world and once against the same world with everything a leak would
 * show — other people, other spaces, a disabled space, folders beside the
 * shared one — and must answer the caller byte for byte the same.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from './support/harness.js';

let h: Harness;

beforeEach(async () => {
  // Built on a local and published only when complete. Three password hashes
  // and three sign-ins are slow on a busy machine; if this hook ever overran
  // its timeout, the late remainder would otherwise carry on against the next
  // test's harness and fail there with "a user with that name already exists".
  const harness = await startHarness('spaces-surface');
  for (const [id, password, role] of [
    ['admin', 'ein gutes passwort', 'admin'],
    ['julian', 'sein gutes passwort', 'user'],
    ['ramona', 'ihr gutes passwort', 'user'],
  ] as const) {
    await harness.runtime.users.create(id, password, { role });
    await harness.login(id, password);
  }
  await harness.runtime.users.createSpace('familie', 'Familie');
  h = harness;
}, 60_000);

afterEach(async () => {
  await h.close();
});

async function member(space: string, grantee: string, kind: string, path: string, canWrite: boolean): Promise<void> {
  const reply = await h.as('admin', {
    method: 'POST',
    url: `/api/v1/admin/spaces/${space}/members`,
    payload: { grantee, kind, path, canWrite },
  });
  expect(reply.status).toBe(201);
}

type Surface = Record<string, { status: number; raw: string }>;

function differing(before: Surface, after: Surface): string[] {
  expect(Object.keys(after)).toEqual(Object.keys(before));
  return Object.keys(before).filter((name) => JSON.stringify(after[name]) !== JSON.stringify(before[name]));
}

describe('the owners in the tree', () => {
  it('name exactly the owners the caller holds a scope in, spaces without notes included', async () => {
    await h.runtime.app.createNote('julian', 'Projekt/Plan.md', '# Plan\n', 'julian');
    h.runtime.shares.grant('julian', 'Projekt', 'ramona', false);
    await member('familie', 'ramona', 'vault', '', false);

    const probe = async (): Promise<Surface> => {
      const tree = await h.as('ramona', { url: '/api/v1/tree' });
      const shares = await h.as('ramona', { url: '/api/v1/shares' });
      return {
        tree: { status: tree.status, raw: tree.raw },
        shares: { status: shares.status, raw: shares.raw },
      };
    };

    const before = await probe();
    const tree = JSON.parse(before['tree']!.raw);
    expect(tree.owners).toEqual([
      { id: 'ramona', kind: 'person', displayName: 'ramona' },
      { id: 'familie', kind: 'space', displayName: 'Familie' },
      { id: 'julian', kind: 'person', displayName: 'julian' },
    ]);

    // Everybody and everything Ramona has no scope in.
    await h.runtime.users.create('peter', 'sein gutes passwort');
    await h.runtime.app.createNote('peter', 'Peter.md', '# Peter\n', 'peter');
    h.runtime.shares.grant('peter', '', 'julian', true);
    await h.runtime.users.createSpace('verein', 'Turnverein');
    await h.runtime.app.createNote('verein', 'Statuten.md', '# Statuten\n', 'admin');
    await member('verein', 'julian', 'vault', '', true);
    await h.runtime.users.createSpace('alt', 'Altes Projekt');
    await h.runtime.app.createNote('alt', 'Archiv.md', '# Archiv\n', 'admin');
    await member('alt', 'ramona', 'vault', '', true);
    h.runtime.users.setDisabled('alt', true);
    await h.runtime.app.createNote('julian', 'Privat/Geheim.md', '# Geheim\n', 'julian');
    await h.runtime.app.createNote('julian', 'Projekt/Anhang.md', '# Anhang\n', 'julian');
    await h.as('julian', {
      method: 'POST',
      url: '/api/v1/shares',
      payload: { grantee: 'peter', kind: 'note', path: 'Privat/Geheim.md', canWrite: false },
    });

    const after = await probe();
    // The new note in the shared folder is legitimately visible; everything
    // else must not be. Compare the owners exactly, and the rest with that
    // one note taken out.
    expect(JSON.parse(after['tree']!.raw).owners).toEqual(tree.owners);
    const withoutAnhang = (raw: string): string => {
      const parsed = JSON.parse(raw);
      parsed.notes = parsed.notes.filter((note: { path: string }) => note.path !== 'Projekt/Anhang.md');
      return JSON.stringify(parsed);
    };
    expect(withoutAnhang(after['tree']!.raw)).toBe(withoutAnhang(before['tree']!.raw));
    expect(after['shares']).toEqual(before['shares']);
  });
});

describe('folders in a space', () => {
  beforeEach(async () => {
    await h.runtime.app.createNote('familie', 'Projekt/Plan.md', '# Plan\n', 'admin');
    await h.runtime.app.createFolder('familie', 'Projekt/Leer');
    await member('familie', 'ramona', 'folder', 'Projekt', true);
    await member('familie', 'julian', 'folder', 'Projekt', false);
  });

  const refusedProbe = async (): Promise<Surface> => {
    const out: Surface = {};
    const send = async (name: string, method: string, url: string, payload?: unknown): Promise<void> => {
      const reply = await h.as('ramona', { method, url, ...(payload === undefined ? {} : { payload }) });
      out[name] = { status: reply.status, raw: reply.raw };
    };
    await send('create beside', 'POST', '/api/v1/folders', { owner: 'familie', path: 'Projektil' });
    await send('create beside, deeper', 'POST', '/api/v1/folders', { owner: 'familie', path: 'Projektil/Neu' });
    await send('create elsewhere', 'POST', '/api/v1/folders', { owner: 'familie', path: 'Andere/Neu' });
    await send('create the shared root', 'POST', '/api/v1/folders', { owner: 'familie', path: 'Projekt' });
    await send('rename out', 'POST', '/api/v1/folders/rename', {
      owner: 'familie',
      from: 'Projekt/Leer',
      to: 'Andere/Leer',
    });
    await send('rename in', 'POST', '/api/v1/folders/rename', {
      owner: 'familie',
      from: 'Projektil',
      to: 'Projekt/Geholt',
    });
    await send('rename the shared root', 'POST', '/api/v1/folders/rename', {
      owner: 'familie',
      from: 'Projekt',
      to: 'Projekt2',
    });
    await send('delete beside', 'DELETE', '/api/v1/folders/Projektil?owner=familie');
    await send('delete elsewhere', 'DELETE', '/api/v1/folders/Andere?owner=familie');
    await send('delete missing', 'DELETE', '/api/v1/folders/Gibtsnicht?owner=familie');
    return out;
  };

  it('refuses everything beside the shared folder, the same whether it exists or not', async () => {
    const before = await refusedProbe();
    for (const [name, reply] of Object.entries(before)) {
      expect({ name, status: reply.status }).toEqual({ name, status: 404 });
    }

    await h.runtime.app.createFolder('familie', 'Projektil');
    await h.runtime.app.createFolder('familie', 'Andere');
    await h.runtime.app.createNote('familie', 'Andere/Notiz.md', '# Notiz\n', 'admin');

    const after = await refusedProbe();
    expect(differing(before, after)).toEqual([]);
    expect(await h.runtime.app.notes.listDirs('familie')).toEqual(
      expect.arrayContaining(['Projektil', 'Andere', 'Projekt/Leer']),
    );
  });

  it('refuses a member who may only read', async () => {
    const reply = await h.as('julian', {
      method: 'POST',
      url: '/api/v1/folders',
      payload: { owner: 'familie', path: 'Projekt/Neu' },
    });
    expect(reply.status).toBe(404);
  });

  it('lets a member with write access create, rename and delete inside, with shares following', async () => {
    await member('familie', 'julian', 'note', 'Projekt/Plan.md', true);

    expect(
      (await h.as('ramona', { method: 'POST', url: '/api/v1/folders', payload: { owner: 'familie', path: 'Projekt/Neu' } }))
        .status,
    ).toBe(201);
    await h.as('ramona', {
      method: 'PUT',
      url: '/api/v1/notes/Projekt/Neu/Plan.md?owner=familie',
      payload: { content: '# Plan im Unterordner\n' },
    });
    await h.as('ramona', {
      method: 'POST',
      url: '/api/v1/rename',
      payload: { owner: 'familie', from: 'Projekt/Plan.md', to: 'Projekt/Neu/Haupt.md' },
    });

    const renamed = await h.as('ramona', {
      method: 'POST',
      url: '/api/v1/folders/rename',
      payload: { owner: 'familie', from: 'Projekt/Neu', to: 'Projekt/Umbenannt' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.movedNotes.sort()).toEqual(['Projekt/Umbenannt/Haupt.md', 'Projekt/Umbenannt/Plan.md']);

    // Julian's note share went with the note, twice.
    const julian = h.runtime.shares.byOwner('familie').find((share) => share.grantee === 'julian' && share.kind === 'note');
    expect(julian?.prefix).toBe('Projekt/Umbenannt/Haupt.md');
    expect(
      h.runtime.app.queries
        .activity(h.runtime.shares.view('ramona'), 0)
        .filter((row) => row.owner === 'familie' && row.path.startsWith('Projekt/Umbenannt/'))
        .map((row) => row.actor),
    ).toEqual(['ramona', 'ramona']);

    expect(
      (await h.as('ramona', { method: 'DELETE', url: '/api/v1/folders/Projekt/Leer?owner=familie' })).status,
    ).toBe(204);
  });
});

describe("an administrator's view of a space", () => {
  beforeEach(async () => {
    await h.runtime.app.createNote('familie', 'Ferien/Packliste.md', '# Packliste\n\nSonnencreme geheim\n', 'admin');
    await h.runtime.app.createNote('familie', 'Budget.md', '# Budget\n\n1000 Franken\n', 'admin');
    await h.runtime.app.createFolder('familie', 'Leer');
  });

  it('lists folders and notes as paths and titles, never contents', async () => {
    const reply = await h.as('admin', { url: '/api/v1/admin/spaces/familie/tree' });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      dirs: expect.arrayContaining(['Ferien', 'Leer']),
      notes: [
        { path: 'Budget.md', title: 'Budget' },
        { path: 'Ferien/Packliste.md', title: 'Packliste' },
      ],
    });
    expect(reply.body.dirs).toHaveLength(2);
    expect(reply.raw).not.toContain('Sonnencreme');
    expect(reply.raw).not.toContain('Franken');
  });

  it('is refused to anybody else, and for a person or a stranger', async () => {
    const reference = await h.as('julian', { url: '/api/v1/admin/users' });
    const refused = await h.as('julian', { url: '/api/v1/admin/spaces/familie/tree' });
    expect({ status: refused.status, raw: refused.raw }).toEqual({ status: reference.status, raw: reference.raw });

    for (const id of ['julian', 'niemand']) {
      expect((await h.as('admin', { url: `/api/v1/admin/spaces/${id}/tree` })).status).toBe(404);
    }
  });
});
