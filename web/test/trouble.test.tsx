/**
 * What the application says when the answer never comes.
 *
 * The failure these pin down is not a crash — it is the quiet one. A tree
 * request that fails leaves `treeQuery.data?.notes ?? []`, which is an empty
 * array, which is indistinguishable from a vault with nothing in it. So the
 * sidebar offered "Start your first note" to somebody whose ten thousand notes
 * were sitting safely on a server that had simply not answered, and the header
 * counted them as zero. For a tool somebody trusts their memory to, that is the
 * worst thing it can say.
 *
 * Four states have to stay apart, and every test here is about one boundary
 * between them:
 *
 *  - **empty** — the answer came and there is nothing in it
 *  - **loading** — the answer has not come yet
 *  - **failed** — the answer will not come, and the server said why
 *  - **offline** — the answer cannot even be asked for
 *
 * The retry policy is tested here too, because it decides which of those a
 * person ends up looking at: a 404 retried three times is three times the wait
 * before the same truth, and a 401 retried is a session that is over being
 * asked about again.
 *
 * **On timers.** Everywhere else in this suite a wait is made deterministic
 * with `vi.useFakeTimers`, and that is the right instinct — a suite that sleeps
 * is slow on an idle machine and flaky on a busy one. It cannot be used here.
 * With a query in its error state, `act()` under vitest's fake clock never
 * settles: it waits for React work that needs one more tick, and the tick can
 * only come from inside the `act` that is already waiting. Reproduced against
 * the shell as it stood before any of this was written, so it is a property of
 * the harness rather than of the code under test.
 *
 * What replaces it costs nothing in determinism: the backoff is taken out of
 * the picture rather than waited through. `show()` builds the real client — the
 * real `shouldRetry`, so the policy under test is the policy that ships — and
 * only shortens the pause between attempts, which `retryDelayMs` is measured
 * against on its own below. Nothing here waits on a wall clock for anything but
 * a promise that is already resolving.
 */

import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { act, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, ContractError, type NoteRow, type User } from '../src/api';
import { App } from '../src/App';
import { copy } from '../src/copy';
import { RETRY_LIMIT, createQueryClient, retryDelayMs, shouldRetry } from '../src/queries';

/*
 * Shorter than the suite's default, and deliberately: nothing here should take
 * even a second. Left at five, a genuine failure races the test runner's own
 * timeout — and the runner wins, which reports "this took too long" instead of
 * "the message was never there" and hides the actual defect.
 */
configure({ asyncUtilTimeout: 2000 });

/** The paragraph that only ever exists in the editor, for the session tests. */
const TYPED = 'a paragraph that is not on the server';

vi.mock('../src/Brain', () => ({
  Brain: () => <canvas className="brain" data-testid="brain" />,
}));
vi.mock('../src/Editor', () => ({
  Editor: (props: { path: string; onChange: (content: string) => void }) => (
    <div data-testid="editor">
      {props.path}
      <button type="button" onClick={() => props.onChange('a paragraph that is not on the server')}>
        type
      </button>
    </div>
  ),
}));
vi.mock('../src/Context', () => ({ ContextPanel: () => <div /> }));

const server = vi.hoisted(() => ({
  signedIn: null as User | null,
  notes: [] as NoteRow[],
  /** Endpoints that fail, and with what. */
  fails: new Map<string, () => Error>(),
  /** How many times each endpoint was actually called. */
  calls: new Map<string, number>(),
  /** The shell's own listener for "the session is gone", as `api` reports it. */
  reportUnauthenticated: null as (() => void) | null,
}));

vi.mock('../src/api', async (original) => {
  const real = await original<typeof import('../src/api')>();
  server.reportUnauthenticated = real.reportUnauthenticated;

  /** Counts the call, then fails it or answers it. */
  const answer = async <T,>(name: string, value: T): Promise<T> => {
    server.calls.set(name, (server.calls.get(name) ?? 0) + 1);
    const fail = server.fails.get(name);
    if (fail !== undefined) throw fail();
    return value;
  };

  const fake: Record<string, (...args: never[]) => Promise<unknown>> = {
    me: async () => ({ user: server.signedIn }),
    login: async () => ({ user: server.signedIn }),
    tree: async () => answer('tree', { notes: server.notes, dirs: [] }),
    tidy: async () =>
      answer('tidy', {
        orphans: [],
        untagged: [],
        deadLinks: [],
        stale: [],
        conflicts: [],
        missing: [],
        truncated: false,
        totals: { orphans: 0, untagged: 0, deadLinks: 0, stale: 0, conflicts: 0, missing: 0 },
      }),
    topics: async () => answer('topics', { proposals: [] }),
    deleted: async () => answer('deleted', { notes: [] }),
    shares: async () => answer('shares', { granted: [], received: [] }),
    tags: async () => answer('tags', { tags: [] }),
    pulse: async () => ({ events: [], now: 1 }),
    propKeys: async () => ({ props: [] }),
    history: async () => ({ available: false, versions: [] }),
    graph: async () => answer('graph', { nodes: [], edges: [] }),
    files: async () => answer('files', { files: [], dirs: [], truncated: false }),
    quickFind: async () => ({ notes: server.notes }),
    getNote: async (owner: string, path: string) =>
      answer('getNote', {
        owner,
        canWrite: true,
        note: { path, title: path.replace(/\.md$/, ''), content: '', size: 0, mtimeMs: 0 },
      }),
    links: async () => answer('links', { backlinks: [], outgoing: [] }),
  };
  const api = new Proxy(fake, { get: (target, key: string) => target[key] ?? (() => new Promise(() => {})) });
  return { ...real, api };
});

function note(path: string): NoteRow {
  return { owner: 'julian', path, title: path.replace(/\.md$/, ''), size: 1, mtimeMs: 0 };
}

let user: ReturnType<typeof userEvent.setup>;

/**
 * The shell over the real query client, with the backoff taken out.
 *
 * `createQueryClient` is the one the application ships, so `retry` here is the
 * real `shouldRetry` and the counts below are the counts a person would cause.
 * Only the pause between attempts is shortened, and that pause has a test of
 * its own.
 */
function show(): QueryClient {
  const client = createQueryClient();
  const defaults = client.getDefaultOptions();
  client.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retryDelay: 1 } });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  user = userEvent.setup();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  window.localStorage.clear();
  server.signedIn = { id: 'julian', displayName: 'Julian', role: 'user' } as User;
  server.notes = [note('Willkommen.md')];
  server.fails = new Map();
  server.calls = new Map();
  window.__ndbrainPending = null;
  onlineManager.setOnline(true);
});

afterEach(() => {
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.__ndbrainPending = null;
});

describe('a failed tree request', () => {
  it('does not offer the first-run empty state over a vault it could not read', async () => {
    server.fails.set('tree', () => new ApiError(500, 'internal', 'the disk is on fire'));
    show();

    // The one sentence this whole exercise exists to prevent: somebody with a
    // full vault being told to start their first note.
    await screen.findByRole('alert');
    expect(screen.queryByText(copy.tree.noNotes)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.tree.noNotesWhy)).not.toBeInTheDocument();
    // Scoped to the tree: the sidebar's own "New note" button is a different
    // control with the same name, and it belongs there whatever has failed.
    expect(
      within(screen.getByRole('tree')).queryByRole('button', { name: copy.tree.noNotesAction }),
    ).not.toBeInTheDocument();
  });

  it('says the notes could not be read, and why', async () => {
    server.fails.set('tree', () => new ApiError(500, 'internal', 'the disk is on fire'));
    show();

    const said = await screen.findByRole('alert');
    expect(said).toHaveTextContent(copy.trouble.failed(copy.trouble.notes));
    expect(said).toHaveTextContent(copy.errors.serverQuiet);
  });

  it('counts nothing in the header rather than counting zero', async () => {
    server.fails.set('tree', () => new ApiError(500, 'internal', 'no'));
    show();

    await screen.findByRole('alert');
    // `0 notes · 0 folders` is a claim about the vault. It is not true here.
    expect(screen.queryByText(copy.shell.sub.overview(0, 0))).not.toBeInTheDocument();
    expect(screen.getByText(copy.shell.sub.failed)).toBeInTheDocument();
  });

  it('offers a way to ask again, and asks again when it is taken', async () => {
    server.fails.set('tree', () => new ApiError(500, 'internal', 'no'));
    show();

    await screen.findByRole('alert');
    const before = server.calls.get('tree') ?? 0;

    server.fails.delete('tree');
    await user.click(screen.getByRole('button', { name: copy.trouble.retry }));

    await waitFor(() => expect(server.calls.get('tree')!).toBeGreaterThan(before));
    expect(await screen.findByText('Willkommen')).toBeInTheDocument();
  });

  it('still shows the first-run state when the vault really is empty', async () => {
    server.notes = [];
    show();

    expect(await screen.findByText(copy.tree.noNotes)).toBeInTheDocument();
    expect(screen.queryByText(copy.errors.serverQuiet)).not.toBeInTheDocument();
  });
});

describe('tidy up', () => {
  it('says what went wrong instead of leaving the pane blank', async () => {
    server.fails.set('tidy', () => new ApiError(503, 'unavailable', 'no'));
    show();

    await screen.findByText('Willkommen');
    await user.click(screen.getByRole('button', { name: copy.nav.tidy }));

    const said = await screen.findByRole('alert');
    expect(said).toHaveTextContent(copy.trouble.failed(copy.trouble.findings));
  });

  it('does not leave the header on “Loading…” for ever', async () => {
    server.fails.set('tidy', () => new ApiError(503, 'unavailable', 'no'));
    show();

    await screen.findByText('Willkommen');
    await user.click(screen.getByRole('button', { name: copy.nav.tidy }));

    await screen.findByRole('alert');
    expect(screen.queryByText(copy.shell.sub.loading)).not.toBeInTheDocument();
    expect(screen.getByText(copy.shell.sub.failed)).toBeInTheDocument();
  });
});

describe('the network', () => {
  it('says the graph could not be read rather than drawing an empty one', async () => {
    server.fails.set('graph', () => new ApiError(500, 'internal', 'no'));
    show();

    await screen.findByText('Willkommen');
    await user.click(screen.getByRole('button', { name: copy.nav.network }));

    const said = await screen.findByRole('alert');
    expect(said).toHaveTextContent(copy.trouble.failed(copy.trouble.network));
    // "0 notes · 0 connections" would be a statement about the vault.
    expect(screen.queryByText(new RegExp(copy.shell.sub.loose(0)))).not.toBeInTheDocument();
    expect(screen.getByText(copy.shell.sub.failed)).toBeInTheDocument();
  });
});

describe('offline', () => {
  it('says offline rather than loading for ever', async () => {
    show();
    await screen.findByText('Willkommen');

    act(() => onlineManager.setOnline(false));
    // The task list beside the calendar is only asked for once the journal is
    // open, so going there offline is a request that is never sent at all.
    await user.click(screen.getByRole('button', { name: copy.nav.journal }));

    // Paused, not failed. Without this the pane sat on "Loading…" for as long
    // as the outage lasted, while the calendar drew happily from the cache.
    const said = await screen.findByRole('alert');
    expect(said).toHaveTextContent(copy.trouble.offline(copy.trouble.tasks));
    expect(screen.queryByText(copy.shell.sub.loading)).not.toBeInTheDocument();
    // And it does not blame a server that was never asked.
    expect(said).not.toHaveTextContent(copy.errors.serverQuiet);
  });

  it('says so once for the whole window, not only where a view is empty', async () => {
    show();
    await screen.findByText('Willkommen');

    act(() => onlineManager.setOnline(false));
    expect(await screen.findByText(copy.trouble.offlineBanner)).toBeInTheDocument();

    act(() => onlineManager.setOnline(true));
    await waitFor(() =>
      expect(screen.queryByText(copy.trouble.offlineBanner)).not.toBeInTheDocument(),
    );
  });
});

describe('a session that ended', () => {
  it('says why the login screen is there', async () => {
    show();
    await screen.findByText('Willkommen');

    act(() => server.reportUnauthenticated!());

    expect(await screen.findByText(copy.login.expired)).toBeInTheDocument();
  });

  it('hands back the text that never reached the server', async () => {
    show();
    await user.click(await screen.findByText('Willkommen'));
    await user.click(await screen.findByRole('button', { name: 'type' }));

    act(() => server.reportUnauthenticated!());

    await screen.findByText(copy.login.expired);
    // The editor went with the shell; this text exists nowhere else on screen.
    expect(screen.getByLabelText(copy.login.unsavedLabel)).toHaveValue(TYPED);
  });

  it('says nothing about a session on a first visit', async () => {
    server.signedIn = null;
    window.__ndbrainPending = { path: 'Somebody else.md', content: 'left over' };
    show();

    expect(await screen.findByLabelText(copy.login.name)).toBeInTheDocument();
    expect(screen.queryByText(copy.login.expired)).not.toBeInTheDocument();
    // Nor does it hand a stray buffer to whoever opens the page next.
    expect(screen.queryByLabelText(copy.login.unsavedLabel)).not.toBeInTheDocument();
  });
});

describe('the retry policy', () => {
  it('does not retry an answer the server meant', () => {
    // A 404 is the truth about a note. A 403 is the truth about a right. A 401
    // is the end of the session, and asking again is asking a question that is
    // over. A 409 is a conflict a second identical request cannot resolve. A
    // 429 is the server asking for less traffic.
    for (const status of [400, 401, 403, 404, 409, 410, 422, 429]) {
      expect(shouldRetry(0, new ApiError(status, 'x', 'no')), String(status)).toBe(false);
    }
  });

  it('retries a server that fell over, and a request that never arrived', () => {
    expect(shouldRetry(0, new ApiError(500, 'internal', 'no'))).toBe(true);
    expect(shouldRetry(0, new ApiError(502, 'bad_gateway', 'no'))).toBe(true);
    // A timeout is "the request did not finish", not "the answer is no".
    expect(shouldRetry(0, new ApiError(408, 'timeout', 'no'))).toBe(true);
    // What `fetch` throws when there was no answer at all.
    expect(shouldRetry(0, new TypeError('Failed to fetch'))).toBe(true);
  });

  it('does not retry an answer this build cannot read', () => {
    // A stale tab against a newer server gets the same wrong shape every time.
    expect(shouldRetry(0, new ContractError('/api/v1/tree', 'notes: expected array'))).toBe(false);
  });

  it('gives up rather than hammering', () => {
    expect(shouldRetry(RETRY_LIMIT - 1, new ApiError(500, 'internal', 'no'))).toBe(true);
    expect(shouldRetry(RETRY_LIMIT, new ApiError(500, 'internal', 'no'))).toBe(false);
  });

  it('waits longer before each further attempt', () => {
    expect(retryDelayMs(0)).toBeGreaterThan(0);
    expect(retryDelayMs(1)).toBeGreaterThan(retryDelayMs(0));
  });

  it('asks a fallen-over server again, through the client the app actually uses', async () => {
    server.fails.set('tree', () => new ApiError(500, 'internal', 'no'));
    show();

    await screen.findByRole('alert');
    // Once, then twice more — the limit, not three times over.
    expect(server.calls.get('tree')).toBe(RETRY_LIMIT + 1);
  });

  it('asks for something gone exactly once', async () => {
    // The same request as the test above, refused rather than broken. Same
    // screen, a third of the traffic, and the truth arrives sooner.
    server.fails.set('tree', () => new ApiError(404, 'not_found', 'gone'));
    show();

    await screen.findByRole('alert');
    // A retry would have to arrive within this window to be counted.
    await expect(
      waitFor(() => expect(server.calls.get('tree')).toBe(2), { timeout: 300 }),
    ).rejects.toThrow();
    expect(server.calls.get('tree')).toBe(1);
  });
});
