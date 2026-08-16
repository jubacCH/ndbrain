/**
 * The client half of the contract.
 *
 * The server's half is covered in `server/test/contract.test.ts`. This is the
 * side that used to be a cast: `return parsed as T`, which TypeScript erases, so
 * a server that changed a field left everything compiling and the interface died
 * later inside a render with an error naming a component that had nothing to do
 * with the cause.
 *
 * What matters here is not that a good response parses. It is that a *bad* one
 * fails at the door, loudly, naming the endpoint — and that an error response
 * still gets through, because an error is the one answer that must never be
 * blocked by shape checking.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, ContractError, api, encodePath, refKey } from '../src/api';

const original = globalThis.fetch;

/** Replies with the given body and status to whatever is asked for. */
function answerWith(body: unknown, status = 200, contentType = 'application/json'): void {
  globalThis.fetch = vi.fn(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': contentType },
    }),
  ) as typeof fetch;
}

beforeEach(() => {
  // The validator logs the offending payload; tests should not print it.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
});

describe('response validation', () => {
  it('accepts an answer of the right shape', async () => {
    answerWith({ user: { id: 'julian', displayName: 'julian', role: 'admin' } });

    await expect(api.me()).resolves.toEqual({
      user: { id: 'julian', displayName: 'julian', role: 'admin' },
    });
  });

  it('refuses an answer with a field of the wrong type', async () => {
    answerWith({ user: { id: 'julian', displayName: 'julian', role: 'wizard' } });

    await expect(api.me()).rejects.toBeInstanceOf(ContractError);
  });

  it('refuses an answer with a field missing', async () => {
    // Exactly the drift this layer exists for: the server drops `mtimeMs` and
    // the old code sailed on until something rendered a date from undefined.
    answerWith({ notes: [{ owner: 'julian', path: 'a.md', title: 'a', size: 1 }], dirs: [] });

    await expect(api.tree()).rejects.toBeInstanceOf(ContractError);
  });

  it('names the endpoint and the field in the failure', async () => {
    answerWith({ notes: 'not an array', dirs: [] });

    await expect(api.tree()).rejects.toMatchObject({
      endpoint: '/api/v1/tree',
      detail: expect.stringContaining('notes'),
    });
  });

  it('ignores a field it does not know, so an older tab survives a newer server', async () => {
    // Response schemas are deliberately not strict. A server that has learned a
    // new field must not break a browser tab nobody has reloaded yet.
    answerWith({
      user: { id: 'julian', displayName: 'julian', role: 'user', avatarUrl: '/neu.png' },
      serverVersion: '9.9.9',
    });

    await expect(api.me()).resolves.toMatchObject({ user: { id: 'julian' } });
  });

  it('lets a server error through untouched', async () => {
    answerWith({ code: 'case_collision', message: 'a note already exists differing only in case' }, 409);

    const failure = await api.tree().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 409, code: 'case_collision' });
  });

  it('treats a non-JSON answer as a broken contract, not as data', async () => {
    // What a proxy in front of this server returns when it has an opinion.
    answerWith('<html><body>502 Bad Gateway</body></html>', 200, 'text/html');

    await expect(api.tree()).rejects.toBeInstanceOf(ContractError);
  });

  it('reports an error even when the body is not JSON either', async () => {
    answerWith('<html>504</html>', 504, 'text/html');

    await expect(api.tree()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('path encoding', () => {
  it('encodes each segment but keeps the separators', () => {
    // encodeURIComponent on the whole path turns every slash into %2F, which the
    // router hands back as one long segment instead of a nested path.
    expect(encodePath('20_Areas/21_Homelab/Proxmox Cluster.md')).toBe(
      '20_Areas/21_Homelab/Proxmox%20Cluster.md',
    );
  });

  it('encodes characters that would otherwise change the URL', () => {
    expect(encodePath('Notes/a?b#c.md')).toBe('Notes/a%3Fb%23c.md');
  });

  it('survives a name that is already percent-looking', () => {
    expect(encodePath('100%25 fertig.md')).toBe('100%2525%20fertig.md');
  });
});

describe('note identity', () => {
  it('cannot be spelled two ways for two different notes', () => {
    // A collision here means the wrong note highlighted — or deleted.
    expect(refKey('julian', 'a/b.md')).not.toBe(refKey('julian/a', 'b.md'));
  });

  it('is stable for the same note', () => {
    expect(refKey('julian', 'a.md')).toBe(refKey('julian', 'a.md'));
  });
});
