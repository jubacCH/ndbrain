import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { SESSION_COOKIE, buildServer } from '../src/http/server.js';
import { LoginThrottle } from '../src/http/throttle.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

let dataDir: string;
let runtime: Runtime;
let server: FastifyInstance;

/** Session cookies, so a request can be made as either person. */
const cookies: Record<string, string> = {};

async function login(user: string, password: string): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { user, password },
  });
  const jar = response.cookies.find((c) => c.name === SESSION_COOKIE);
  return `${jar?.name}=${jar?.value}`;
}

async function as(
  user: string,
  options: { method?: string; url: string; payload?: unknown },
): Promise<{ status: number; body: any }> {
  // Assembled rather than spread: under `exactOptionalPropertyTypes` a spread of
  // `{}` widens `payload` to include `undefined`, which does not match
  // `InjectOptions` — and a GET must not be given an empty body just to satisfy
  // the type, since that is not the request the route would really receive.
  const injection: InjectOptions = {
    method: (options.method ?? 'GET') as NonNullable<InjectOptions['method']>,
    url: options.url,
    headers: { cookie: cookies[user] ?? '' },
  };
  if (options.payload !== undefined) {
    injection.payload = options.payload as NonNullable<InjectOptions['payload']>;
  }

  const response = await server.inject(injection);
  return {
    status: response.statusCode,
    body: response.body === '' ? null : response.json(),
  };
}

/** Julian shares one folder with Ramona. */
async function share(prefix: string, canWrite: boolean): Promise<string> {
  const { body } = await as('julian', {
    method: 'POST',
    url: '/api/v1/shares',
    payload: { grantee: 'ramona', prefix, canWrite },
  });
  return body.share.id;
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-shares-'));
  const config = { ...loadConfig(), dataDir, cookieSecure: false };
  runtime = await createRuntime(config);

  await runtime.users.create('julian', 'ein gutes passwort');
  await runtime.users.create('ramona', 'ihr gutes passwort');

  await runtime.app.createNote(
    'julian',
    'Projekt/Plan.md',
    '---\ntags: [projekt]\n---\n# Plan\n\nZwei Nodes, Qdevice auf [[Technik]].\n\n- [ ] Termin fixieren\n',
  );
  await runtime.app.createNote('julian', 'Projekt/Technik.md', '# Technik\n\nDetails zum Projekt.\n');
  await runtime.app.createNote('julian', 'Privat/Tagebuch.md', '# Tagebuch\n\nstreng geheim\n');
  await runtime.app.createNote('julian', 'Verweis.md', 'Siehe [[Plan]] — privat notiert.\n');
  await runtime.app.createNote('ramona', 'Eigenes.md', '# Eigenes\n\nRamonas Notiz.\n');

  server = await buildServer({
    app: runtime.app,
    users: runtime.users,
    sessions: runtime.sessions,
    keys: runtime.keys,
    shares: runtime.shares,
    settings: runtime.settings,
    history: runtime.history,
    config,
    throttle: new LoginThrottle({ limit: 1000 }),
  });

  cookies['julian'] = await login('julian', 'ein gutes passwort');
  cookies['ramona'] = await login('ramona', 'ihr gutes passwort');
});

afterEach(async () => {
  await server.close();
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const NOTE = '/api/v1/notes/Projekt/Plan.md?owner=julian';

describe('the permission matrix', () => {
  /**
   * The six operations, each as the caller would issue it. The expectation per
   * grant level is asserted below rather than in each case, so a new operation
   * cannot be added without deciding what it does at all three levels.
   */
  const OPERATIONS = {
    read: () => as('ramona', { url: NOTE }),
    write: () =>
      as('ramona', { method: 'PUT', url: NOTE, payload: { content: 'überschrieben\n' } }),
    rename: () =>
      as('ramona', {
        method: 'POST',
        url: '/api/v1/rename',
        payload: { owner: 'julian', from: 'Projekt/Plan.md', to: 'Projekt/Planung.md' },
      }),
    delete: () => as('ramona', { method: 'DELETE', url: NOTE }),
    search: () => as('ramona', { url: '/api/v1/search?q=Qdevice' }),
    backlinks: () => as('ramona', { url: '/api/v1/backlinks/Projekt/Plan.md?owner=julian' }),
  };

  describe('without a grant', () => {
    it.each(['read', 'write', 'rename', 'delete'] as const)(
      'answers %s exactly as for a note that does not exist',
      async (operation) => {
        const { status, body } = await OPERATIONS[operation]();
        expect(status).toBe(404);
        expect(JSON.stringify(body)).not.toContain('Qdevice');
      },
    );

    it('does not surface the note in search', async () => {
      const { body } = await OPERATIONS.search();
      expect(body.hits).toEqual([]);
    });

    it('does not surface the note in the tree, quick switcher or tags', async () => {
      expect(JSON.stringify((await as('ramona', { url: '/api/v1/tree' })).body)).not.toContain(
        'Projekt',
      );
      expect((await as('ramona', { url: '/api/v1/quickfind?q=Plan' })).body.notes).toEqual([]);
      expect(
        (await as('ramona', { url: '/api/v1/tags' })).body.tags.map((t: any) => t.tag),
      ).not.toContain('projekt');
    });
  });

  describe('with read access', () => {
    beforeEach(async () => {
      await share('Projekt', false);
    });

    it('reads the note and says it may not be written', async () => {
      const { status, body } = await OPERATIONS.read();
      expect(status).toBe(200);
      expect(body.note.content).toContain('Qdevice');
      expect(body.owner).toBe('julian');
      expect(body.canWrite).toBe(false);
    });

    it.each(['write', 'rename', 'delete'] as const)('still refuses %s', async (operation) => {
      const { status } = await OPERATIONS[operation]();
      expect(status).toBe(404);
    });

    it('leaves the note untouched after a refused write', async () => {
      await OPERATIONS.write();
      const note = await runtime.notes.getNote('julian', 'Projekt/Plan.md');
      expect(note.content).toContain('Qdevice');
    });

    it('finds the note in search, labelled with its owner', async () => {
      const { body } = await OPERATIONS.search();
      expect(body.hits).toHaveLength(1);
      expect(body.hits[0].owner).toBe('julian');
      expect(body.hits[0].path).toBe('Projekt/Plan.md');
    });

    it('shows the shared folder in the tree without the rest of the vault', async () => {
      const { body } = await as('ramona', { url: '/api/v1/tree' });
      const paths = body.notes.map((n: any) => `${n.owner}:${n.path}`);

      expect(paths).toContain('julian:Projekt/Plan.md');
      expect(paths).toContain('ramona:Eigenes.md');
      expect(paths).not.toContain('julian:Privat/Tagebuch.md');
      expect(body.dirs.map((d: any) => `${d.owner}:${d.path}`)).not.toContain('julian:Privat');
    });

    it('counts shared notes in the overview and lists their open tasks', async () => {
      const { body } = await as('ramona', { url: '/api/v1/overview' });
      expect(body.counts.notes).toBe(3); // her own note plus the two shared ones
      expect(body.tasks.map((t: any) => t.text)).toContain('Termin fixieren');
    });

    /**
     * The findings are the one part of the overview that does not span shares.
     *
     * Caught in the browser: the guest's headline read "2 brauchen
     * Aufmerksamkeit" while the tidy view beside it — own vault only, by design
     * — was empty. A count nobody can act on is worse than no count, because it
     * sends somebody looking for a list that is not there.
     */
    it('counts only your own notes as findings, matching the tidy view', async () => {
      const overview = (await as('ramona', { url: '/api/v1/overview' })).body;
      const tidy = (await as('ramona', { url: '/api/v1/tidy' })).body;

      expect(overview.counts.untagged).toBe(tidy.untagged.length);
      expect(overview.counts.orphans).toBe(tidy.orphans.length);
      expect(overview.counts.deadLinks).toBe(tidy.deadLinks.length);
      expect(overview.counts.stale).toBe(tidy.stale.length);

      // Julian's shared Projekt/Plan.md has an unresolved [[Technik]]-style gap
      // and an untagged sibling; none of that is Ramona's to clean up.
      const attention =
        overview.counts.orphans +
        overview.counts.untagged +
        overview.counts.deadLinks +
        overview.counts.stale;
      const own = tidy.orphans.length + tidy.untagged.length + tidy.deadLinks.length + tidy.stale.length;
      expect(attention).toBe(own);
    });
  });

  describe('with write access', () => {
    beforeEach(async () => {
      await share('Projekt', true);
    });

    it('writes, and the change lands in the owner\'s vault', async () => {
      const { status } = await OPERATIONS.write();
      expect(status).toBe(200);

      const note = await runtime.notes.getNote('julian', 'Projekt/Plan.md');
      expect(note.content).toBe('überschrieben\n');
    });

    it('records who actually made the change, not whose vault it is', async () => {
      await OPERATIONS.write();
      const activity = runtime.app.queries.activity('julian', 0);
      expect(activity.find((row) => row.path === 'Projekt/Plan.md')?.actor).toBe('ramona');
    });

    it('renames inside the shared folder', async () => {
      const { status } = await OPERATIONS.rename();
      expect(status).toBe(200);
      expect(runtime.app.queries.getNote('julian', 'julian', 'Projekt/Planung.md')).toBeDefined();
    });

    it('deletes inside the shared folder', async () => {
      const { status } = await OPERATIONS.delete();
      expect(status).toBe(204);
    });
  });
});

describe('the edge of a share', () => {
  beforeEach(async () => {
    await share('Projekt', true);
  });

  it('does not treat a folder that merely starts the same as shared', async () => {
    await runtime.app.createNote('julian', 'Projekt-Privat/Geheim.md', 'nicht geteilt\n');

    const { status } = await as('ramona', {
      url: '/api/v1/notes/Projekt-Privat/Geheim.md?owner=julian',
    });
    expect(status).toBe(404);
  });

  it('refuses to move a note out of the shared folder', async () => {
    const { status } = await as('ramona', {
      method: 'POST',
      url: '/api/v1/rename',
      payload: { owner: 'julian', from: 'Projekt/Plan.md', to: 'Plan.md' },
    });

    expect(status).toBe(404);
    expect(runtime.app.queries.getNote('julian', 'julian', 'Projekt/Plan.md')).toBeDefined();
  });

  it('refuses to move a note out of the shared folder in bulk either', async () => {
    const { body } = await as('ramona', {
      method: 'POST',
      url: '/api/v1/bulk',
      payload: { owner: 'julian', action: 'move', paths: ['Projekt/Plan.md'], dir: 'Anderswo' },
    });

    expect(body.ok ?? []).toEqual([]);
    expect(runtime.app.queries.getNote('julian', 'julian', 'Projekt/Plan.md')).toBeDefined();
  });

  it('reports an out-of-scope note in a bulk selection as missing, and does the rest', async () => {
    const { body } = await as('ramona', {
      method: 'POST',
      url: '/api/v1/bulk',
      payload: {
        owner: 'julian',
        action: 'tag',
        paths: ['Projekt/Plan.md', 'Privat/Tagebuch.md'],
        tag: 'sortiert',
      },
    });

    expect(body.ok).toEqual(['Projekt/Plan.md']);
    expect(body.failed).toEqual([{ path: 'Privat/Tagebuch.md', reason: 'note does not exist' }]);
    // The untouched note is genuinely untouched, not merely reported as failed.
    const untouched = await runtime.notes.getNote('julian', 'Privat/Tagebuch.md');
    expect(untouched.content).not.toContain('sortiert');
  });

  it('cannot create a note outside the shared folder', async () => {
    const { status } = await as('ramona', {
      method: 'PUT',
      url: '/api/v1/notes/Eingeschleust.md?owner=julian',
      payload: { content: 'x' },
    });

    expect(status).toBe(404);
    expect(runtime.app.queries.getNote('julian', 'julian', 'Eingeschleust.md')).toBeUndefined();
  });

  it('never lets a share be passed on', async () => {
    // Ramona grants "julian's Projekt" to a third account. What she can actually
    // grant is her own vault — the endpoint takes the owner from her session.
    await runtime.users.create('gast', 'noch ein passwort');
    await as('ramona', {
      method: 'POST',
      url: '/api/v1/shares',
      payload: { grantee: 'gast', prefix: 'Projekt', canWrite: true },
    });

    cookies['gast'] = await login('gast', 'noch ein passwort');
    const { status } = await as('gast', { url: NOTE });
    expect(status).toBe(404);
  });
});

describe('links stop at the sharing boundary', () => {
  it('does not reveal a private note that links to a shared one', async () => {
    await share('Projekt', false);

    // `Verweis.md` links to `Plan.md` but is not itself shared. Ramona may read
    // the target; naming the source would tell her a note she cannot see exists.
    const { body } = await as('ramona', {
      url: '/api/v1/backlinks/Projekt/Plan.md?owner=julian',
    });

    expect(body.backlinks.map((l: any) => l.source)).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('Verweis');
  });

  it('shows the owner their own backlinks in full', async () => {
    await share('Projekt', false);
    const { body } = await as('julian', { url: '/api/v1/backlinks/Projekt/Plan.md' });
    expect(body.backlinks.map((l: any) => l.source)).toContain('Verweis.md');
  });

  it('does not resolve a link across vaults', async () => {
    await share('Projekt', true);
    await as('ramona', {
      method: 'PUT',
      url: '/api/v1/notes/Projekt/Neu.md?owner=julian',
      payload: { content: 'Siehe [[Eigenes]].\n' },
    });

    // `Eigenes.md` is Ramona's own note. Written into Julian's vault, the link
    // has no target — vaults do not link to each other.
    const outgoing = runtime.app.queries.outgoingLinks('julian', 'julian', 'Projekt/Neu.md');
    expect(outgoing[0]?.targetPath).toBeNull();
  });

  /**
   * A link written inside a share may point out of it. The grantee is allowed
   * to read the note, so she sees the `[[…]]` text either way — what she must
   * not learn is where it lands, or that it lands anywhere at all.
   */
  describe('a link pointing out of the share', () => {
    /** `Projekt/Notiz.md` links out to `Privat/Tagebuch.md` and to nothing. */
    async function linkOutOfTheShare(): Promise<void> {
      await runtime.app.createNote(
        'julian',
        'Projekt/Notiz.md',
        'Siehe [[Tagebuch]] und [[Nirgendwo]].\n',
      );
      await share('Projekt', false);
    }

    it('does not hand the grantee a path out of the private half of the vault', async () => {
      await linkOutOfTheShare();

      const { body } = await as('ramona', {
        url: '/api/v1/backlinks/Projekt/Notiz.md?owner=julian',
      });

      const link = body.outgoing.find((l: any) => l.targetRaw === 'Tagebuch');
      expect(link?.targetPath).toBeNull();
      expect(JSON.stringify(body)).not.toContain('Privat');
    });

    it('makes "not yours" and "not there" the same answer', async () => {
      await linkOutOfTheShare();

      const { body } = await as('ramona', {
        url: '/api/v1/backlinks/Projekt/Notiz.md?owner=julian',
      });

      // Dropping the line instead would say it: the grantee reads the note, so
      // a `[[…]]` that appears in the text but not in this list could only mean
      // "exists, not yours" — an existence oracle over the whole foreign vault.
      const hidden = body.outgoing.find((l: any) => l.targetRaw === 'Tagebuch');
      const missing = body.outgoing.find((l: any) => l.targetRaw === 'Nirgendwo');
      expect({ ...hidden, targetRaw: null, offset: null }).toEqual({
        ...missing,
        targetRaw: null,
        offset: null,
      });
    });

    it('still shows a dead link inside the share as dead', async () => {
      await runtime.app.createNote('julian', 'Projekt/Notiz.md', 'Siehe [[Nirgendwo]].\n');
      await share('Projekt', false);

      const { body } = await as('ramona', {
        url: '/api/v1/backlinks/Projekt/Notiz.md?owner=julian',
      });

      expect(body.outgoing).toHaveLength(1);
      expect(body.outgoing[0].targetRaw).toBe('Nirgendwo');
      expect(body.outgoing[0].targetPath).toBeNull();
    });

    it('draws no graph edge out of the share, and counts no invisible neighbour', async () => {
      await linkOutOfTheShare();
      // A private note pointing *into* the share: the edge is invisible to her,
      // so the degree of the shared note must not count it either.
      await runtime.app.createNote('julian', 'Privat/Heimlich.md', 'Siehe [[Technik]].\n');

      const { body } = await as('ramona', { url: '/api/v1/graph' });

      // Asserted first, because `every` on an empty array is true: without this
      // the check below would stay green on a graph that drew no edge at all.
      expect(body.edges.length).toBeGreaterThan(0);
      expect(body.edges.every((e: any) => e.to.startsWith('Projekt/'))).toBe(true);
      expect(JSON.stringify(body)).not.toContain('Privat');

      const technik = body.nodes.find((n: any) => n.path === 'Projekt/Technik.md');
      // Linked from `Projekt/Plan.md` only, as far as she may know.
      expect(technik?.links).toBe(1);
    });

    it('leaves the owner his own vault whole', async () => {
      await linkOutOfTheShare();
      await runtime.app.createNote('julian', 'Privat/Heimlich.md', 'Siehe [[Technik]].\n');

      const { body } = await as('julian', { url: '/api/v1/backlinks/Projekt/Notiz.md' });
      const link = body.outgoing.find((l: any) => l.targetRaw === 'Tagebuch');
      expect(link?.targetPath).toBe('Privat/Tagebuch.md');

      const graph = (await as('julian', { url: '/api/v1/graph' })).body;
      expect(
        graph.edges.some(
          (e: any) => e.from === 'Projekt/Notiz.md' && e.to === 'Privat/Tagebuch.md',
        ),
      ).toBe(true);
      expect(graph.nodes.find((n: any) => n.path === 'Projekt/Technik.md')?.links).toBe(2);
    });
  });
});

/**
 * The same boundary, on a path that writes.
 *
 * A rename rewrites every `[[wikilink]]` that pointed at the note, across the
 * whole of the owner's vault — that part is correct and has to stay. What the
 * caller is told about it is a different question: the list of rewritten notes
 * is a set of paths derived from links, and handing it back unfiltered names
 * notes the caller was never given.
 */
describe('renaming inside a share', () => {
  /**
   * `Projekt/Technik.md` is linked to from both halves of the vault: from
   * `Projekt/Plan.md`, which Ramona may read, and from `Privat/Heimlich.md`,
   * which she may not.
   */
  async function linkedFromBothHalves(): Promise<void> {
    await runtime.app.createNote('julian', 'Privat/Heimlich.md', 'Siehe [[Technik]].\n');
    await share('Projekt', true);
  }

  async function renameTechnik(): Promise<{ status: number; body: any }> {
    return as('ramona', {
      method: 'POST',
      url: '/api/v1/rename',
      payload: { owner: 'julian', from: 'Projekt/Technik.md', to: 'Projekt/Technik-neu.md' },
    });
  }

  it('does not name the notes outside the share whose links it rewrote', async () => {
    await linkedFromBothHalves();

    const { status, body } = await renameTechnik();

    expect(status).toBe(200);
    expect(body.updatedLinks).toEqual(['Projekt/Plan.md']);
    expect(JSON.stringify(body)).not.toContain('Privat');
  });

  it('rewrites the hidden link all the same, so the owner keeps a working vault', async () => {
    await linkedFromBothHalves();
    await renameTechnik();

    const hidden = await runtime.notes.getNote('julian', 'Privat/Heimlich.md');
    expect(hidden.content).toContain('[[Technik-neu]]');
  });

  /**
   * The count is derived from the list, so it has to be filtered with it.
   * "Links updated in 2 notes" where the caller can only see one of them says
   * the second exists — the same leak as the node degree in the graph, in a
   * response nobody was looking at.
   */
  it('counts only what it names', async () => {
    await linkedFromBothHalves();

    const { body } = await renameTechnik();
    expect(body.updatedLinks).toHaveLength(1);
  });

  it('makes the private half no different from an empty one', async () => {
    await linkedFromBothHalves();

    // The same rename in a vault that never had the private notes at all. If
    // the two answers differ in any byte, the difference is the leak.
    const withPrivate = (await renameTechnik()).body;

    await runtime.app.deleteNote('julian', 'Privat/Heimlich.md');
    await runtime.app.deleteNote('julian', 'Privat/Tagebuch.md');
    await runtime.app.deleteNote('julian', 'Verweis.md');

    const without = (
      await as('ramona', {
        method: 'POST',
        url: '/api/v1/rename',
        payload: { owner: 'julian', from: 'Projekt/Technik-neu.md', to: 'Projekt/Technik.md' },
      })
    ).body;

    expect(without.updatedLinks).toEqual(withPrivate.updatedLinks);
  });

  it('leaves the owner the whole list, because all of it is his', async () => {
    await linkedFromBothHalves();

    const { body } = await as('julian', {
      method: 'POST',
      url: '/api/v1/rename',
      payload: { from: 'Projekt/Technik.md', to: 'Projekt/Technik-neu.md' },
    });

    expect(body.updatedLinks.sort()).toEqual(['Privat/Heimlich.md', 'Projekt/Plan.md']);
  });

  /**
   * A folder rename is the caller's own vault by construction — the route takes
   * the owner from the session and never from the request. Asserted rather than
   * assumed, because the note rename above looked the same way until it did not.
   */
  it('refuses a folder rename in somebody else\'s vault outright', async () => {
    await linkedFromBothHalves();

    const { status, body } = await as('ramona', {
      method: 'POST',
      url: '/api/v1/folders/rename',
      payload: { owner: 'julian', from: 'Projekt', to: 'Projekt-neu' },
    });

    // `movedNotes` and `updatedLinks` would carry the same class, so the route
    // never lets a request name a vault: the owner comes from the session, and
    // the body schema is strict, so the attempt is rejected before it is read.
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_body');
    expect(JSON.stringify(body)).not.toContain('Privat');
    expect(runtime.app.queries.getNote('julian', 'julian', 'Projekt/Plan.md')).toBeDefined();
  });
});

/**
 * Two worlds, one answer.
 *
 * The read paths resolve links with a `WHERE` rather than a projection, on the
 * argument that "outside the share" and "does not exist" are already the same
 * thing in a graph that omits unresolved links. That argument is only worth
 * anything if it is enforced: a test that checks the private paths are absent
 * would still pass on an empty answer, and would not notice a later rewrite
 * that made the two cases distinguishable again.
 *
 * So the vault is asked the same question twice — once holding the private
 * notes, once without them — and the two answers have to be identical.
 */
describe('the private half is indistinguishable from an empty one', () => {
  /** Everything Ramona can ask that is derived from links. */
  async function linkViews(): Promise<string> {
    const graph = (await as('ramona', { url: '/api/v1/graph' })).body;
    const notiz = (
      await as('ramona', { url: '/api/v1/backlinks/Projekt/Notiz.md?owner=julian' })
    ).body;
    const technik = (
      await as('ramona', { url: '/api/v1/backlinks/Projekt/Technik.md?owner=julian' })
    ).body;

    return JSON.stringify({ graph, notiz, technik });
  }

  it('answers the graph and the backlinks identically either way', async () => {
    // `Projekt/Notiz.md` links out of the share and into the void;
    // `Privat/Heimlich.md` links back into the share from outside it.
    await runtime.app.createNote(
      'julian',
      'Projekt/Notiz.md',
      'Siehe [[Tagebuch]] und [[Nirgendwo]].\n',
    );
    await runtime.app.createNote('julian', 'Privat/Heimlich.md', 'Siehe [[Technik]].\n');
    await share('Projekt', false);

    const withPrivate = await linkViews();

    // Identity is only worth asserting about an answer that has something in
    // it: two empty graphs are equal as well, and would pass this silently.
    const graph = (await as('ramona', { url: '/api/v1/graph' })).body;
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.nodes.length).toBeGreaterThan(0);

    await runtime.app.deleteNote('julian', 'Privat/Heimlich.md');
    await runtime.app.deleteNote('julian', 'Privat/Tagebuch.md');
    await runtime.app.deleteNote('julian', 'Verweis.md');

    expect(await linkViews()).toBe(withPrivate);
  });
});

/**
 * A search hit carries no score.
 *
 * bm25 is computed from FTS5 statistics that span the whole table, so the rank
 * of a hit in a shared folder moves when a note somewhere in the private half
 * is written or deleted — measured, on this vault, as -0.0000016 becoming
 * -0.000001375. No path, nothing but a number, and far too noisy to read a
 * vault out of; but it is a quantity on one side of the tenant boundary that
 * changes with what happens on the other, which is the definition of a side
 * channel. The list is ordered on the server and no client ever read the value.
 */
describe('the search result says nothing about the rest of the vault', () => {
  it('returns no relevance score', async () => {
    await share('Projekt', false);

    const { body } = await as('ramona', { url: '/api/v1/search?q=Qdevice' });

    expect(body.hits).toHaveLength(1);
    expect(body.hits[0]).not.toHaveProperty('rank');
  });

  it('still orders the hits itself', async () => {
    const { body } = await as('julian', { url: '/api/v1/search?q=Technik' });

    // Ordering is the whole reason the score is computed; it just stays inside
    // the server now. The note called Technik comes before the one that merely
    // links to it.
    expect(body.hits.map((h: any) => h.path)).toEqual(['Projekt/Technik.md', 'Projekt/Plan.md']);
  });
});

/**
 * `orphans()` carries the same class as the graph degree, dormantly.
 *
 * "Nothing links to this note" is a statement about links, so it has to be
 * answered from the links the caller may see. Every caller today hands it a
 * bare owner, which makes the question own-vault only and the answer correct —
 * but the query is written against a view like every other one here, and the
 * next caller to pass one would get the leak for free.
 */
describe('what counts as orphaned stops at the sharing boundary', () => {
  /** `Projekt/Allein.md` is linked to from the private half and nowhere else. */
  async function orphanedAsFarAsSheKnows(): Promise<void> {
    await runtime.app.createNote('julian', 'Projekt/Allein.md', '# Allein\n');
    await runtime.app.createNote('julian', 'Privat/Heimlich.md', 'Siehe [[Allein]].\n');
    await share('Projekt', false);
  }

  it('calls a note orphaned when the only link to it is one the caller cannot see', async () => {
    await orphanedAsFarAsSheKnows();

    const paths = runtime.app.queries
      .orphans(runtime.shares.view('ramona'))
      .map((note) => note.path);

    expect(paths).toContain('Projekt/Allein.md');
  });

  it('gives the same answer as a vault that never had the private note', async () => {
    await orphanedAsFarAsSheKnows();
    const withPrivate = runtime.app.queries.orphans(runtime.shares.view('ramona'));

    await runtime.app.deleteNote('julian', 'Privat/Heimlich.md');

    expect(runtime.app.queries.orphans(runtime.shares.view('ramona'))).toEqual(withPrivate);
  });

  it('leaves the owner his own answer, which counts the private link', async () => {
    await orphanedAsFarAsSheKnows();

    const paths = runtime.app.queries.orphans('julian').map((note) => note.path);
    expect(paths).not.toContain('Projekt/Allein.md');
  });
});

/**
 * A bulk move is a rename, and it renames for somebody else.
 *
 * `POST /api/v1/bulk` takes an `owner` from the body, so the caller and the
 * vault are routinely different people — which makes it the one caller of
 * `renameNote` that must hand over the *caller's* view. It was passing none at
 * all, and the harm was hidden only because `BulkResult` does not carry the
 * list of rewritten notes.
 */
describe('a bulk move renames on the caller\'s behalf', () => {
  beforeEach(async () => {
    await share('Projekt', true);
    await runtime.app.createNote('julian', 'Projekt/Unter/Technik2.md', '# Technik2\n');
    await runtime.app.createNote('julian', 'Projekt/Plan2.md', 'Siehe [[Technik2]].\n');
    await runtime.app.createNote('julian', 'Privat/Heimlich.md', 'Siehe [[Technik2]].\n');
  });

  async function move(): Promise<{ status: number; body: any }> {
    return as('ramona', {
      method: 'POST',
      url: '/api/v1/bulk',
      payload: {
        owner: 'julian',
        action: 'move',
        paths: ['Projekt/Unter/Technik2.md'],
        dir: 'Projekt',
      },
    });
  }

  it('moves the note and says nothing about the private half', async () => {
    const { status, body } = await move();

    expect(status).toBe(200);
    expect(body.ok).toEqual(['Projekt/Technik2.md']);
    expect(JSON.stringify(body)).not.toContain('Privat');
  });

  it('rewrites the hidden link all the same', async () => {
    await move();

    const hidden = await runtime.notes.getNote('julian', 'Privat/Heimlich.md');
    expect(hidden.content).toContain('[[Technik2]]');
    expect((await runtime.notes.getNote('julian', 'Projekt/Plan2.md')).content).toContain(
      '[[Technik2]]',
    );
  });

  /**
   * The audit entry names the person, not the vault.
   *
   * Worth its own case because of how the view reached this call. `Viewable` is
   * `string | View` and `actor` is a string, so a view handed over positionally
   * next to the actor can be bound to the wrong parameter and still compile —
   * which happened once while this was being written, and cost the attribution
   * silently. Here that failure is loud.
   */
  it('still records who made the move', async () => {
    await move();

    const activity = runtime.app.queries.activity('julian', 0);
    expect(activity.find((row) => row.path === 'Projekt/Technik2.md')?.actor).toBe('ramona');
  });
});

describe('withdrawing a share', () => {
  it('ends access immediately, with no cached decision', async () => {
    const id = await share('Projekt', true);
    expect((await as('ramona', { url: NOTE })).status).toBe(200);

    await as('julian', { method: 'DELETE', url: `/api/v1/shares/${id}` });

    expect((await as('ramona', { url: NOTE })).status).toBe(404);
    expect((await as('ramona', { url: '/api/v1/search?q=Qdevice' })).body.hits).toEqual([]);
  });

  it('lets the grantee decline it too', async () => {
    const id = await share('Projekt', false);
    const { status } = await as('ramona', { method: 'DELETE', url: `/api/v1/shares/${id}` });

    expect(status).toBe(204);
    expect((await as('ramona', { url: NOTE })).status).toBe(404);
  });

  it('is invisible to anybody else', async () => {
    await runtime.users.create('gast', 'noch ein passwort');
    cookies['gast'] = await login('gast', 'noch ein passwort');

    const id = await share('Projekt', false);
    const { status } = await as('gast', { method: 'DELETE', url: `/api/v1/shares/${id}` });

    expect(status).toBe(404);
    expect((await as('ramona', { url: NOTE })).status).toBe(200);
  });

  it('re-granting changes the right instead of stacking a second grant', async () => {
    const first = await share('Projekt', false);
    const second = await share('Projekt', true);

    expect(second).toBe(first);
    expect(runtime.shares.toGrantee('ramona')).toHaveLength(1);
    expect((await OPERATIONS_write()).status).toBe(200);
  });

  async function OPERATIONS_write(): Promise<{ status: number }> {
    return as('ramona', { method: 'PUT', url: NOTE, payload: { content: 'neu\n' } });
  }
});

describe('managing shares', () => {
  it('lists both directions', async () => {
    await share('Projekt', true);

    const mine = await as('julian', { url: '/api/v1/shares' });
    expect(mine.body.granted).toHaveLength(1);
    expect(mine.body.received).toEqual([]);

    const hers = await as('ramona', { url: '/api/v1/shares' });
    expect(hers.body.granted).toEqual([]);
    expect(hers.body.received[0].owner).toBe('julian');
  });

  it('normalises the prefix to a folder boundary', async () => {
    await share('/Projekt/', false);
    expect(runtime.shares.toGrantee('ramona')[0]?.prefix).toBe('Projekt/');
  });

  it('treats an empty prefix as the whole vault', async () => {
    await share('', false);
    expect((await as('ramona', { url: '/api/v1/notes/Privat/Tagebuch.md?owner=julian' })).status)
      .toBe(200);
  });

  it('refuses to share with somebody who does not exist', async () => {
    const { status, body } = await as('julian', {
      method: 'POST',
      url: '/api/v1/shares',
      payload: { grantee: 'niemand', prefix: 'Projekt' },
    });
    expect(status).toBe(404);
    expect(body.code).toBe('no_such_user');
  });

  it('refuses to share a vault with its own owner', async () => {
    const { status, body } = await as('julian', {
      method: 'POST',
      url: '/api/v1/shares',
      payload: { grantee: 'julian', prefix: 'Projekt' },
    });
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_share');
  });

  it('needs a session', async () => {
    expect((await server.inject({ url: '/api/v1/shares' })).statusCode).toBe(401);
  });
});

describe('conflicting writes to a shared note', () => {
  beforeEach(async () => {
    await share('Projekt', true);
  });

  /** Reads the note the way a client would, to get the mtime it should send back. */
  async function open(user: string): Promise<number> {
    const { body } = await as(user, { url: NOTE });
    return body.note.mtimeMs;
  }

  it('keeps the displaced version instead of dropping it', async () => {
    const base = await open('ramona');

    // Julian writes while Ramona has the note open…
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.app.updateNote('julian', 'Projekt/Plan.md', 'Julians Fassung\n', 'julian');

    // …and Ramona saves on top of it.
    const { status, body } = await as('ramona', {
      method: 'PUT',
      url: NOTE,
      payload: { content: 'Ramonas Fassung\n', baseMtimeMs: base },
    });

    expect(status).toBe(200);
    expect(body.conflictCopy).toMatch(/^Projekt\/Plan \(Konflikt .+\)\.md$/);

    // Last writer wins, and the version that lost is still on disk.
    expect((await runtime.notes.getNote('julian', 'Projekt/Plan.md')).content).toBe(
      'Ramonas Fassung\n',
    );
    expect((await runtime.notes.getNote('julian', body.conflictCopy)).content).toBe(
      'Julians Fassung\n',
    );
  });

  it('makes the conflict copy findable rather than leaving it lying in the folder', async () => {
    const base = await open('ramona');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.app.updateNote('julian', 'Projekt/Plan.md', 'Julians eigenwillige Fassung\n');

    await as('ramona', {
      method: 'PUT',
      url: NOTE,
      payload: { content: 'Ramonas Fassung\n', baseMtimeMs: base },
    });

    const { body } = await as('ramona', { url: '/api/v1/search?q=eigenwillige' });
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0].path).toMatch(/Konflikt/);
  });

  it('does not make a copy when nobody else wrote in the meantime', async () => {
    const base = await open('ramona');
    const { body } = await as('ramona', {
      method: 'PUT',
      url: NOTE,
      payload: { content: 'nur ich\n', baseMtimeMs: base },
    });

    expect(body.conflictCopy).toBeUndefined();
  });

  it('does not make a copy when both wrote the same text', async () => {
    const base = await open('ramona');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.app.updateNote('julian', 'Projekt/Plan.md', 'dasselbe\n');

    const { body } = await as('ramona', {
      method: 'PUT',
      url: NOTE,
      payload: { content: 'dasselbe\n', baseMtimeMs: base },
    });

    expect(body.conflictCopy).toBeUndefined();
  });

  it('leaves a client that sends no base version with the old behaviour', async () => {
    await runtime.app.updateNote('julian', 'Projekt/Plan.md', 'Julians Fassung\n');

    const { body } = await as('ramona', {
      method: 'PUT',
      url: NOTE,
      payload: { content: 'Ramonas Fassung\n' },
    });

    expect(body.conflictCopy).toBeUndefined();
  });
});
