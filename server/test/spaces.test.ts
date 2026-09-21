/**
 * Spaces: shared vaults as an account nobody signs in to.
 *
 * The rules pinned here, in the order a reader would ask about them: a space
 * cannot sign in, and trying looks exactly like a wrong password; only an
 * administrator can see or change spaces, and everybody else is told the
 * routes do not exist; members are ordinary shares and see the space as a
 * root of its own; what they change is recorded under their own name; keys
 * can be confined to a space; and a disabled space is gone for its members and
 * its keys alike.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runSpaceCommand } from '../src/cliSpaces.js';
import { startHarness, type Harness, type Reply } from './support/harness.js';

let h: Harness;

beforeEach(async () => {
  h = await startHarness('spaces');
  await h.runtime.users.create('admin', 'ein gutes passwort', { role: 'admin' });
  await h.runtime.users.create('julian', 'sein gutes passwort');
  await h.runtime.users.create('ramona', 'ihr gutes passwort');
  await h.login('admin', 'ein gutes passwort');
  await h.login('julian', 'sein gutes passwort');
  await h.login('ramona', 'ihr gutes passwort');
});

afterEach(async () => {
  await h.close();
});

async function createSpace(id = 'familie', displayName = 'Familie'): Promise<void> {
  const reply = await h.as('admin', { method: 'POST', url: '/api/v1/admin/spaces', payload: { id, displayName } });
  expect(reply.status).toBe(201);
}

async function addMember(
  space: string,
  payload: { grantee: string; kind: string; path: string; canWrite: boolean },
): Promise<Reply> {
  return h.as('admin', { method: 'POST', url: `/api/v1/admin/spaces/${space}/members`, payload });
}

describe('a space cannot sign in', () => {
  it('refuses a login exactly as a wrong password or an unknown name', async () => {
    await createSpace();
    // Even a password that would match what is stored in the row.
    const asSpace = await h.login('familie', '!space');
    const wrong = await h.login('julian', 'falsches passwort');
    const unknown = await h.login('niemand', 'irgendein passwort');

    for (const reply of [asSpace, unknown]) {
      expect({ status: reply.status, raw: reply.raw }).toEqual({ status: wrong.status, raw: wrong.raw });
    }
    expect(wrong.status).toBe(401);
  });

  it('is refused even when its row carries a real password hash', async () => {
    await createSpace();
    // However that row came about — a restored backup, a hand edit — the kind
    // decides, not whether the hash happens to verify.
    const { hashPassword } = await import('../src/auth/password.js');
    h.runtime.db.run(
      "UPDATE users SET password_hash = ? WHERE id = 'familie'",
      await hashPassword('ein echtes passwort'),
    );
    const asSpace = await h.login('familie', 'ein echtes passwort');
    const wrong = await h.login('julian', 'falsches passwort');
    expect({ status: asSpace.status, raw: asSpace.raw }).toEqual({ status: wrong.status, raw: wrong.raw });
    expect(asSpace.raw).not.toContain('set-cookie');
  });

  it('has no password that could be set', async () => {
    await createSpace();
    await expect(h.runtime.users.setPassword('familie', 'ein neues passwort')).rejects.toThrow();
    const reply = await h.as('admin', {
      method: 'POST',
      url: '/api/v1/admin/users/familie/password',
      payload: { password: 'ein neues passwort' },
    });
    expect(reply.status).toBe(404);
    expect(await h.runtime.users.authenticate('familie', 'ein neues passwort')).toBeNull();
  });

  it('is never the caller, even with a session row that names it', async () => {
    await createSpace();
    const { token } = h.runtime.sessions.create('familie');
    const reply = await h.server.inject({ url: '/api/v1/auth/me', headers: { cookie: `ndbrain_session=${token}` } });
    expect(reply.statusCode).toBe(401);
  });
});

describe('administering spaces', () => {
  const ROUTES = [
    { method: 'GET', url: '/api/v1/admin/spaces' },
    { method: 'POST', url: '/api/v1/admin/spaces', payload: { id: 'neu', displayName: 'Neu' } },
    { method: 'PATCH', url: '/api/v1/admin/spaces/familie', payload: { disabled: true } },
    { method: 'GET', url: '/api/v1/admin/spaces/familie/members' },
    {
      method: 'POST',
      url: '/api/v1/admin/spaces/familie/members',
      payload: { grantee: 'julian', kind: 'vault', path: '', canWrite: true },
    },
    { method: 'DELETE', url: '/api/v1/admin/spaces/familie/members/shr_x' },
  ] as const;

  it('answers somebody who is not an administrator like every refused admin route', async () => {
    await createSpace();
    const reference = await h.as('julian', { url: '/api/v1/admin/users' });
    expect(reference.status).toBe(404);

    for (const route of ROUTES) {
      const reply = await h.as('julian', route);
      expect({ route: route.url, status: reply.status, raw: reply.raw }).toEqual({
        route: route.url,
        status: reference.status,
        raw: reference.raw,
      });
    }
    // And nothing happened.
    expect(h.runtime.users.get('neu')).toBeUndefined();
    expect(h.runtime.users.get('familie')?.disabled).toBe(false);
    expect(h.runtime.shares.byOwner('familie')).toEqual([]);
  });

  it('creates a space with an empty vault and lists it', async () => {
    await createSpace();
    await fs.access(path.join(h.dataDir, 'vaults', 'familie'));

    const list = await h.as('admin', { url: '/api/v1/admin/spaces' });
    expect(list.body).toEqual({
      spaces: [{ id: 'familie', displayName: 'Familie', disabled: false, noteCount: 0, members: 0 }],
    });

    const users = await h.as('admin', { url: '/api/v1/admin/users' });
    expect(users.body.users.map((user: { id: string }) => user.id)).toEqual(['admin', 'julian', 'ramona']);
  });

  it('shares one namespace with people, both ways', async () => {
    const taken = await h.as('admin', {
      method: 'POST',
      url: '/api/v1/admin/spaces',
      payload: { id: 'julian', displayName: 'Julian' },
    });
    expect(taken.status).toBe(409);

    await createSpace();
    const person = await h.as('admin', {
      method: 'POST',
      url: '/api/v1/admin/users',
      payload: { id: 'familie', password: 'ein gutes passwort' },
    });
    expect(person.status).toBe(409);
    await expect(h.runtime.users.create('familie', 'ein gutes passwort')).rejects.toThrow();
  });

  it('applies the account name rules', async () => {
    for (const id of ['../x', 'mit leerzeichen', '', '-vorne']) {
      const reply = await h.as('admin', { method: 'POST', url: '/api/v1/admin/spaces', payload: { id } });
      expect({ id, status: reply.status }).toEqual({ id, status: 400 });
    }
  });

  it('renames and disables a space, and answers a person or a stranger as missing', async () => {
    await createSpace();
    const renamed = await h.as('admin', {
      method: 'PATCH',
      url: '/api/v1/admin/spaces/familie',
      payload: { displayName: 'Familie Bachmann', disabled: true },
    });
    expect(renamed.body).toMatchObject({ id: 'familie', displayName: 'Familie Bachmann', disabled: true });

    for (const id of ['julian', 'niemand']) {
      const reply = await h.as('admin', { method: 'PATCH', url: `/api/v1/admin/spaces/${id}`, payload: { disabled: true } });
      expect(reply.status).toBe(404);
      const members = await h.as('admin', { url: `/api/v1/admin/spaces/${id}/members` });
      expect(members.status).toBe(404);
    }
    expect(h.runtime.users.get('julian')?.disabled).toBe(false);
  });

  it('adds, lists and removes members of every kind', async () => {
    await createSpace();
    await h.runtime.app.createNote('familie', 'Ferien/Packliste.md', '# Packliste\n', 'admin');

    const vault = await addMember('familie', { grantee: 'julian', kind: 'vault', path: '', canWrite: true });
    const folder = await addMember('familie', { grantee: 'ramona', kind: 'folder', path: 'Ferien', canWrite: false });
    const note = await addMember('familie', {
      grantee: 'ramona',
      kind: 'note',
      path: 'Ferien/Packliste.md',
      canWrite: true,
    });
    expect([vault.status, folder.status, note.status]).toEqual([201, 201, 201]);

    const members = await h.as('admin', { url: '/api/v1/admin/spaces/familie/members' });
    expect(
      members.body.members.map((share: any) => ({ kind: share.kind, prefix: share.prefix, grantee: share.grantee, canWrite: share.canWrite })),
    ).toEqual([
      { kind: 'vault', prefix: '', grantee: 'julian', canWrite: true },
      { kind: 'folder', prefix: 'Ferien/', grantee: 'ramona', canWrite: false },
      { kind: 'note', prefix: 'Ferien/Packliste.md', grantee: 'ramona', canWrite: true },
    ]);

    const list = await h.as('admin', { url: '/api/v1/admin/spaces' });
    expect(list.body.spaces[0]).toMatchObject({ noteCount: 1, members: 3 });
    expect(note.body).toMatchObject({ kind: 'note', prefix: 'Ferien/Packliste.md', grantee: 'ramona', canWrite: true });
    expect(members.body.members[0]).toEqual(vault.body);

    const removed = await h.as('admin', {
      method: 'DELETE',
      url: `/api/v1/admin/spaces/familie/members/${folder.body.id}`,
    });
    expect(removed.status).toBe(204);
    expect(h.runtime.shares.byOwner('familie')).toHaveLength(2);
  });

  it('refuses members that cannot be: a space, a missing note, a share of another vault', async () => {
    await createSpace();
    await createSpace('verein', 'Verein');
    const space = await addMember('familie', { grantee: 'verein', kind: 'vault', path: '', canWrite: false });
    const nobody = await addMember('familie', { grantee: 'niemand', kind: 'vault', path: '', canWrite: false });
    expect(space.status).toBe(404);
    expect(space.raw).toBe(nobody.raw);

    const missing = await addMember('familie', { grantee: 'julian', kind: 'note', path: 'Gibtsnicht.md', canWrite: false });
    expect(missing.status).toBe(404);

    const foreign = h.runtime.shares.grant('julian', '', 'ramona', false);
    const reply = await h.as('admin', {
      method: 'DELETE',
      url: `/api/v1/admin/spaces/familie/members/${foreign.id}`,
    });
    expect(reply.status).toBe(404);
    expect(h.runtime.shares.get(foreign.id)).toBeDefined();
  });

  it('can be created and listed from the command line', async () => {
    const out: string[] = [];
    await runSpaceCommand(h.runtime, ['create', 'verein', '--display', 'Turnverein'], (text) => out.push(text));
    await runSpaceCommand(h.runtime, ['list'], (text) => out.push(text));

    expect(h.runtime.users.get('verein')).toMatchObject({ kind: 'space', displayName: 'Turnverein' });
    expect(out.join('')).toContain('created space verein (Turnverein)');
    expect(out.join('')).toMatch(/verein\s+Turnverein\s+0 notes, 0 members/);
    await expect(runSpaceCommand(h.runtime, ['create', 'julian'], () => undefined)).rejects.toThrow();
  });
});

describe('members', () => {
  beforeEach(async () => {
    await createSpace();
    await h.runtime.app.createNote('familie', 'Ferien/Packliste.md', '# Packliste\n\nSonnencreme\n', 'admin');
    await h.runtime.app.createNote('familie', 'Budget.md', '# Budget\n\nSonnencreme teuer\n', 'admin');
    await addMember('familie', { grantee: 'julian', kind: 'vault', path: '', canWrite: true });
    await addMember('familie', { grantee: 'ramona', kind: 'folder', path: 'Ferien', canWrite: false });
  });

  it('see the space as a root of its own, with its kind and name', async () => {
    const tree = await h.as('julian', { url: '/api/v1/tree' });
    expect(tree.body.owners).toEqual([
      { id: 'julian', kind: 'person', displayName: 'julian' },
      { id: 'familie', kind: 'space', displayName: 'Familie' },
    ]);
    expect(tree.body.notes.filter((note: any) => note.owner === 'familie').map((note: any) => note.path).sort()).toEqual([
      'Budget.md',
      'Ferien/Packliste.md',
    ]);

    const shares = await h.as('ramona', { url: '/api/v1/shares' });
    expect(shares.body.received.map((share: any) => ({ owner: share.owner, kind: share.kind, prefix: share.prefix }))).toEqual([
      { owner: 'familie', kind: 'folder', prefix: 'Ferien/' },
    ]);
    const search = await h.as('ramona', { url: '/api/v1/search?q=Sonnencreme' });
    expect(search.body.hits.map((hit: any) => hit.path)).toEqual(['Ferien/Packliste.md']);
  });

  it('are recorded as themselves when they write into the space', async () => {
    const reply = await h.as('julian', {
      method: 'PUT',
      url: '/api/v1/notes/Budget.md?owner=familie',
      payload: { content: '# Budget\n\ngeändert\n' },
    });
    expect(reply.status).toBe(200);
    await h.as('julian', {
      method: 'POST',
      url: '/api/v1/rename',
      payload: { owner: 'familie', from: 'Budget.md', to: 'Finanzen.md' },
    });

    const actors = h.runtime.db
      .all("SELECT actor, action FROM edits WHERE owner = 'familie' AND actor <> 'admin' ORDER BY at")
      .map((row) => ({ ...row }));
    expect(actors).toEqual([
      { actor: 'julian', action: 'update' },
      { actor: 'julian', action: 'rename' },
    ]);
    const overview = await h.as('julian', { url: '/api/v1/overview' });
    expect(overview.body.activity.find((row: any) => row.path === 'Finanzen.md')).toMatchObject({
      owner: 'familie',
      actor: 'julian',
    });
  });

  it('stop seeing a disabled space, and see it again when it is enabled', async () => {
    const disable = (disabled: boolean) =>
      h.as('admin', { method: 'PATCH', url: '/api/v1/admin/spaces/familie', payload: { disabled } });

    await disable(true);
    expect((await h.as('julian', { url: '/api/v1/notes/Budget.md?owner=familie' })).status).toBe(404);
    const tree = await h.as('julian', { url: '/api/v1/tree' });
    expect(tree.body.notes.some((note: any) => note.owner === 'familie')).toBe(false);
    expect(tree.body.owners.map((owner: any) => owner.id)).toEqual(['julian']);
    expect((await h.as('julian', { url: '/api/v1/shares' })).body.received).toEqual([]);
    expect((await h.as('ramona', { url: '/api/v1/search?q=Sonnencreme' })).body.hits).toEqual([]);
    const write = await h.as('julian', {
      method: 'PUT',
      url: '/api/v1/notes/Budget.md?owner=familie',
      payload: { content: 'x' },
    });
    expect(write.status).toBe(404);

    await disable(false);
    expect((await h.as('julian', { url: '/api/v1/notes/Budget.md?owner=familie' })).status).toBe(200);
  });
});

describe('agent keys of a space', () => {
  beforeEach(async () => {
    await createSpace();
    await h.runtime.app.createNote('familie', 'Ferien/Packliste.md', '# Packliste\n\nSonnencreme\n', 'admin');
    await h.runtime.app.createNote('familie', 'Budget.md', '# Budget\n\nSonnencreme teuer\n', 'admin');
    await h.runtime.app.createNote('julian', 'Privat.md', '# Privat\n\nSonnencreme privat\n', 'julian');
    await addMember('familie', { grantee: 'julian', kind: 'vault', path: '', canWrite: true });
  });

  async function spaceKey(scope?: string): Promise<string> {
    const reply = await h.as('admin', {
      method: 'POST',
      url: '/api/v1/admin/keys',
      payload: { owner: 'familie', name: 'familien-agent', canWrite: true, ...(scope === undefined ? {} : { scope }) },
    });
    expect(reply.status).toBe(201);
    expect(reply.body.owner).toBe('familie');
    return reply.body.secret;
  }

  it('see the space and nothing beyond its scope', async () => {
    const secret = await spaceKey('Ferien');
    const found = await h.tool(secret, 'search_notes', { query: 'Sonnencreme' });
    expect(found.body.result.content[0].text).toContain('Ferien/Packliste.md');
    expect(found.body.result.content[0].text).not.toContain('Budget.md');
    expect(found.body.result.content[0].text).not.toContain('Privat');

    const outside = await h.tool(secret, 'get_note', { path: 'Budget.md' });
    expect(outside.body.result.isError).toBe(true);
  });

  it('record their key name when they write, never a member', async () => {
    const secret = await spaceKey();
    await h.tool(secret, 'append_note', { path: 'Budget.md', content: 'vom agenten' });
    const row = h.runtime.db.get("SELECT actor FROM edits WHERE owner = 'familie' ORDER BY at DESC LIMIT 1");
    expect(row?.['actor']).toBe('familien-agent');
  });

  it('are refused while the space is disabled, and work again after', async () => {
    const secret = await spaceKey();
    await h.as('admin', { method: 'PATCH', url: '/api/v1/admin/spaces/familie', payload: { disabled: true } });
    const refused = await h.tool(secret, 'get_note', { path: 'Budget.md' });
    const unknown = await h.tool('ndb_0000', 'get_note', { path: 'Budget.md' });
    expect({ status: refused.status, raw: refused.raw }).toEqual({ status: unknown.status, raw: unknown.raw });
    expect(refused.status).toBe(401);

    await h.as('admin', { method: 'PATCH', url: '/api/v1/admin/spaces/familie', payload: { disabled: false } });
    expect((await h.tool(secret, 'get_note', { path: 'Budget.md' })).status).toBe(200);
  });
});

describe('agent keys of a disabled person', () => {
  it('are refused exactly like an unknown key, and work again once the account is enabled', async () => {
    await h.runtime.app.createNote('julian', 'Privat.md', '# Privat\n', 'julian');
    const created = await h.as('admin', {
      method: 'POST',
      url: '/api/v1/admin/keys',
      payload: { owner: 'julian', name: 'julians-agent' },
    });
    expect(created.status).toBe(201);
    const secret: string = created.body.secret;
    expect((await h.tool(secret, 'get_note', { path: 'Privat.md' })).status).toBe(200);

    const setDisabled = async (disabled: boolean): Promise<void> => {
      const reply = await h.as('admin', {
        method: 'POST',
        url: '/api/v1/admin/users/julian/disabled',
        payload: { disabled },
      });
      expect(reply.status).toBe(200);
    };

    await setDisabled(true);
    const refused = await h.tool(secret, 'get_note', { path: 'Privat.md' });
    const unknown = await h.tool('ndb_0000', 'get_note', { path: 'Privat.md' });
    expect({ status: refused.status, raw: refused.raw }).toEqual({ status: unknown.status, raw: unknown.raw });
    expect(refused.status).toBe(401);
    expect(h.runtime.keys.resolve(secret)).toBeNull();

    await setDisabled(false);
    expect((await h.tool(secret, 'get_note', { path: 'Privat.md' })).status).toBe(200);
  });
});

describe('one namespace, whatever the letter case', () => {
  it('refuses a space or a person named like another account in a different case, from every door', async () => {
    await h.runtime.app.createNote('julian', 'Privat/Tagebuch.md', '# Tagebuch\n', 'julian');

    // The API, for a space and for a person.
    const space = await h.as('admin', { method: 'POST', url: '/api/v1/admin/spaces', payload: { id: 'Julian', displayName: 'J' } });
    const exact = await h.as('admin', { method: 'POST', url: '/api/v1/admin/spaces', payload: { id: 'julian', displayName: 'J' } });
    expect({ status: space.status, raw: space.raw }).toEqual({ status: exact.status, raw: exact.raw });
    expect(space.status).toBe(409);
    const person = await h.as('admin', { method: 'POST', url: '/api/v1/admin/users', payload: { id: 'RAMONA', password: 'ein gutes passwort' } });
    expect(person.status).toBe(409);

    // The service the command line creates people through, and the space command.
    await expect(h.runtime.users.create('Admin', 'ein gutes passwort')).rejects.toThrow('already exists');
    await expect(runSpaceCommand(h.runtime, ['create', 'JULIAN'], () => undefined)).rejects.toThrow('already exists');

    // And a person may not take a space's name in another case either.
    await createSpace('familie', 'Familie');
    await expect(h.runtime.users.create('Familie', 'ein gutes passwort')).rejects.toThrow('already exists');

    expect(h.runtime.users.list().map((user) => user.id).sort()).toEqual(['admin', 'familie', 'julian', 'ramona']);
    // Nothing reached julian's vault under another spelling.
    const read = await h.as('ramona', { url: '/api/v1/notes/Privat/Tagebuch.md?owner=Julian' });
    expect(read.status).toBe(404);
  });

  it('holds when two spellings of one name are created at the same moment', async () => {
    // The check used to sit before the password hash, and hashing takes long
    // enough for a second creation to run from beginning to end inside it —
    // both looked, both found the name free, both wrote.
    const pair = await Promise.allSettled([
      h.runtime.users.create('Kim', 'ein gutes passwort'),
      h.runtime.users.create('kim', 'ein gutes passwort'),
    ]);
    expect(pair.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);

    // A person and a space, over HTTP, which is where the pair was found: on
    // APFS the two would share one vault directory.
    const [person, space] = await Promise.all([
      h.as('admin', {
        method: 'POST',
        url: '/api/v1/admin/users',
        payload: { id: 'Lea', password: 'ein gutes passwort' },
      }),
      h.as('admin', {
        method: 'POST',
        url: '/api/v1/admin/spaces',
        payload: { id: 'lea', displayName: 'L' },
      }),
    ]);
    expect([person.status, space.status].sort()).toEqual([201, 409]);

    const ids = h.runtime.users.list().map((user) => user.id.toLowerCase());
    expect(ids).toEqual([...new Set(ids)]);
    expect(ids.filter((id) => id === 'kim' || id === 'lea').sort()).toEqual(['kim', 'lea']);
  });

  it('resolves no id to an account of another case: login, shares and keys are exact', async () => {
    const login = await h.login('JULIAN', 'sein gutes passwort');
    const wrong = await h.login('julian', 'falsches passwort');
    expect({ status: login.status, raw: login.raw }).toEqual({ status: wrong.status, raw: wrong.raw });

    const grant = await h.as('julian', { method: 'POST', url: '/api/v1/shares', payload: { grantee: 'RAMONA', kind: 'vault', path: '', canWrite: false } });
    expect(grant.status).toBeGreaterThanOrEqual(400);
    const key = await h.as('admin', { method: 'POST', url: '/api/v1/admin/keys', payload: { owner: 'Julian', name: 'k' } });
    expect(key.status).toBe(404);
  });
});

describe('the files of a space', () => {
  it('are listed to a member as far as the membership reaches, the same whatever lies beside it', async () => {
    await createSpace();
    await h.runtime.app.createNote('familie', 'Ferien/Packliste.md', '# Packliste\n', 'admin');
    await h.runtime.app.writeFile('familie', 'Ferien/karte.png', Buffer.from('png'), 'admin');
    expect((await addMember('familie', { grantee: 'julian', kind: 'folder', path: 'Ferien', canWrite: false })).status).toBe(201);

    const list = async (): Promise<Reply> => {
      const reply = await h.as('julian', { url: '/api/v1/files?owner=familie' });
      return { ...reply, raw: reply.raw.replace(/"mtimeMs":[0-9.]+/g, '"mtimeMs":0') };
    };
    const first = await list();
    expect(first.status).toBe(200);
    expect(first.body.files.map((file: { path: string }) => file.path)).toEqual(['Ferien/karte.png', 'Ferien/Packliste.md']);
    expect(first.body.files.every((file: { owner: string }) => file.owner === 'familie')).toBe(true);

    await h.runtime.app.createNote('familie', 'Budget.md', '# Budget\n', 'admin');
    await h.runtime.app.writeFile('familie', 'Ferien2/geheim.pdf', Buffer.from('pdf'), 'admin');
    await h.runtime.app.createFolder('familie', 'Leer');
    expect((await list()).raw).toBe(first.raw);

    // Not a member: as if the space were not there.
    const stranger = await h.as('ramona', { url: '/api/v1/files?owner=familie' });
    const nobody = await h.as('ramona', { url: '/api/v1/files?owner=niemand' });
    expect({ status: stranger.status, raw: stranger.raw }).toEqual({ status: nobody.status, raw: nobody.raw });
  });

  it('are not listed while the space is disabled', async () => {
    await createSpace();
    await addMember('familie', { grantee: 'julian', kind: 'vault', path: '', canWrite: false });
    await h.as('admin', { method: 'PATCH', url: '/api/v1/admin/spaces/familie', payload: { disabled: true } });
    expect((await h.as('julian', { url: '/api/v1/files?owner=familie' })).status).toBe(404);
  });
});
