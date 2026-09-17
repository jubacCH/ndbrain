/**
 * The phase 8 contract, as this page reads and writes it.
 *
 * Share kinds, the space endpoints and the owner list on the tree. Where the
 * written contract left a shape open (a bare list or a wrapped one, `path` or
 * `prefix` on a member), both readings are pinned here, so the choice the
 * server strand makes cannot break the page silently.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContractError, api } from '../src/api';

const original = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit | undefined }> = [];

function answerWith(body: unknown, status = 200): void {
  calls = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function sent(): unknown {
  return JSON.parse(String(calls[0]?.init?.body));
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
});

const SHARE = { id: 's1', owner: 'julian', prefix: 'Projekt/Plan.md', grantee: 'anna', canWrite: false, createdAt: 1 };

describe('shares', () => {
  it('carry their kind', async () => {
    answerWith({ granted: [{ ...SHARE, kind: 'note' }], received: [] });
    const { granted } = await api.shares();
    expect(granted[0]?.kind).toBe('note');
  });

  it('are refused without a kind, rather than guessed to be a folder', async () => {
    // A note share read as a folder would widen what the page thinks it covers.
    answerWith({ granted: [SHARE], received: [] });
    await expect(api.shares()).rejects.toBeInstanceOf(ContractError);
  });

  it('are granted with kind and path', async () => {
    answerWith({ share: { ...SHARE, kind: 'note' } });
    await api.grantShare('anna', 'note', 'Projekt/Plan.md', true);
    expect(calls[0]?.url).toBe('/api/v1/shares');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(sent()).toEqual({ grantee: 'anna', kind: 'note', path: 'Projekt/Plan.md', canWrite: true });
  });
});

describe('the tree', () => {
  it('names the owners it spans, with their kind', async () => {
    answerWith({
      notes: [],
      dirs: [],
      owners: [{ id: 'familie', kind: 'space', displayName: 'Familie' }],
    });
    await expect(api.tree()).resolves.toMatchObject({ owners: [{ id: 'familie', kind: 'space' }] });
  });

  it('still reads without an owner list', async () => {
    answerWith({ notes: [], dirs: [] });
    await expect(api.tree()).resolves.toEqual({ notes: [], dirs: [] });
  });
});

describe('admin spaces', () => {
  const SPACE = { id: 'familie', displayName: 'Familie', disabled: false, noteCount: 3, members: 2 };

  it('reads the list as the contract writes it, a bare array', async () => {
    answerWith([SPACE]);
    await expect(api.adminSpaces()).resolves.toEqual([SPACE]);
    expect(calls[0]?.url).toBe('/api/v1/admin/spaces');
  });

  it('reads the list wrapped, as the rest of the API answers', async () => {
    answerWith({ spaces: [SPACE] });
    await expect(api.adminSpaces()).resolves.toEqual([SPACE]);
  });

  it('refuses a space without its counts', async () => {
    answerWith([{ id: 'familie', displayName: 'Familie', disabled: false }]);
    await expect(api.adminSpaces()).rejects.toBeInstanceOf(ContractError);
  });

  it('creates with id and display name, and patches only what changes', async () => {
    answerWith({ ok: true }, 201);
    await api.createSpace('familie', 'Familie');
    expect(sent()).toEqual({ id: 'familie', displayName: 'Familie' });

    answerWith({ ok: true });
    await api.updateSpace('familie', { disabled: true });
    expect(calls[0]?.url).toBe('/api/v1/admin/spaces/familie');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(sent()).toEqual({ disabled: true });
  });

  it('reads members with `path`, as shares of the space', async () => {
    answerWith([{ id: 'm1', grantee: 'anna', kind: 'note', path: 'Projekt/Plan.md', canWrite: true }]);
    await expect(api.spaceMembers('familie')).resolves.toEqual([
      { id: 'm1', owner: 'familie', grantee: 'anna', kind: 'note', prefix: 'Projekt/Plan.md', canWrite: true, createdAt: 0 },
    ]);
    expect(calls[0]?.url).toBe('/api/v1/admin/spaces/familie/members');
  });

  it('reads members wrapped and with `prefix` as well', async () => {
    answerWith({ members: [{ id: 'm1', grantee: 'anna', kind: 'folder', prefix: 'Projekt/', canWrite: false, createdAt: 5 }] });
    await expect(api.spaceMembers('familie')).resolves.toMatchObject([{ prefix: 'Projekt/', kind: 'folder', createdAt: 5 }]);
  });

  it('refuses a member that names no region', async () => {
    answerWith([{ id: 'm1', grantee: 'anna', kind: 'folder', canWrite: false }]);
    await expect(api.spaceMembers('familie')).rejects.toBeInstanceOf(ContractError);
  });

  it('adds and removes members at the space’s own address', async () => {
    answerWith({ ok: true }, 201);
    await api.addSpaceMember('familie', 'anna', 'folder', 'Projekt', false);
    expect(calls[0]?.url).toBe('/api/v1/admin/spaces/familie/members');
    expect(sent()).toEqual({ grantee: 'anna', kind: 'folder', path: 'Projekt', canWrite: false });

    answerWith(null, 204);
    await api.removeSpaceMember('familie', 'm1');
    expect(calls[0]?.url).toBe('/api/v1/admin/spaces/familie/members/m1');
    expect(calls[0]?.init?.method).toBe('DELETE');
  });
});
