/**
 * The save path, from a keystroke to the file and back.
 *
 * The promise this application makes is that the note file is the truth and
 * that typed text does not go missing. Everything here is a way that promise
 * can be broken without anybody noticing:
 *
 *  - a write that lands on the server but not in the cache the editor is built
 *    from, so the next reader of that entry serves text older than the file
 *  - a write that fails and takes the only copy of the paragraph with it,
 *    because the buffer was emptied before the request went out
 *  - a failure that is quietly relabelled "Saved" by the next note opened
 *  - a session that ended mid-write, where the text must at least survive in
 *    the slot the crash box reads
 *  - a tab being closed, where the request has to be allowed to outlive the
 *    document and the person has to be warned when it cannot
 *
 * Time is the test's, not the machine's: the fake server answers after set
 * delays and the debounce is a timer, so on real timers a busy machine could
 * stretch one past the other and turn correct behaviour into a failure.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NoteRow, OpenNote, User } from '../src/api';
import { App } from '../src/App';
import { copy } from '../src/copy';
import { keys } from '../src/queries';

vi.mock('../src/Brain', () => ({
  Brain: () => <canvas className="brain" data-testid="brain" />,
}));
// Shows the text it was built from, which is the whole point of the first
// test: a stale cache entry is visible here and nowhere else.
vi.mock('../src/Editor', () => ({
  Editor: (props: { path: string; initialContent: string; onChange: (content: string) => void }) => (
    <div data-testid="editor" data-content={props.initialContent}>
      {props.path}
      <button type="button" onClick={() => props.onChange('first draft')}>
        type
      </button>
      <button type="button" onClick={() => props.onChange('second draft')}>
        type again
      </button>
    </div>
  ),
}));
vi.mock('../src/Context', () => ({ ContextPanel: () => <div /> }));

const server = vi.hoisted(() => ({
  signedIn: null as User | null,
  notes: [] as NoteRow[],
  /** What the vault holds, by path. */
  content: new Map<string, string>(),
  /** Every note's version, moved on by each write. */
  versions: new Map<string, number>(),
  /** Each write that reached the server, in order. */
  writes: [] as Array<{ path: string; content: string; base: number | undefined }>,
  /** How the next write fails, or null to let it through. */
  putFails: null as { status: number; code: string } | null,
  putDelayMs: 0,
}));

vi.mock('../src/api', async (original) => {
  const real = await original<typeof import('../src/api')>();
  const fake: Record<string, (...args: never[]) => Promise<unknown>> = {
    me: async () => ({ user: server.signedIn }),
    tree: async () => ({ notes: server.notes, dirs: [] }),
    tidy: async () => ({
      orphans: [],
      untagged: [],
      deadLinks: [],
      stale: [],
      conflicts: [],
      truncated: false,
      totals: { orphans: 0, untagged: 0, deadLinks: 0, stale: 0, conflicts: 0 },
    }),
    shares: async () => ({ granted: [], received: [] }),
    tags: async () => ({ tags: [] }),
    pulse: async () => ({ events: [], now: 1 }),
    propKeys: async () => ({ props: [] }),
    history: async () => ({ available: false, versions: [] }),
    graph: async () => ({ nodes: [], edges: [] }),
    links: async () => ({ backlinks: [], outgoing: [] }),
    quickFind: async () => ({ notes: server.notes }),
    getNote: async (owner: string, path: string) => {
      const row = server.notes.find((n) => n.owner === owner && n.path === path);
      if (row === undefined) throw new real.ApiError(404, 'not_found', 'gone');
      return {
        owner,
        canWrite: true,
        note: {
          path,
          title: row.title,
          content: server.content.get(path) ?? '',
          size: 0,
          mtimeMs: server.versions.get(path) ?? 0,
        },
      };
    },
    putNote: async (_owner: string, path: string, content: string, base?: number) => {
      server.writes.push({ path, content, base });
      if (server.putDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, server.putDelayMs));
      const failure = server.putFails;
      if (failure !== null) {
        // What the real client does on an expired session, said once and
        // centrally — the shell ends the session from this signal.
        if (failure.status === 401 && failure.code === 'unauthenticated') real.reportUnauthenticated();
        throw new real.ApiError(failure.status, failure.code, 'no');
      }
      const version = (server.versions.get(path) ?? 0) + 1000;
      server.versions.set(path, version);
      server.content.set(path, content);
      return {
        note: { path, title: '', content, size: content.length, mtimeMs: version },
        created: false,
      };
    },
  };
  const api = new Proxy(fake, { get: (target, key: string) => target[key] ?? (() => new Promise(() => {})) });
  return { ...real, api };
});

function row(owner: string, path: string): NoteRow {
  return { owner, path, title: path.split('/').pop()!.replace(/\.md$/, ''), size: 1, mtimeMs: 0 };
}

const PLAN = 'Projects/Plan.md';
const LOOSE = 'Loose.md';

let user: ReturnType<typeof userEvent.setup>;
let client: QueryClient;

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
  user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  window.localStorage.clear();
  window.__ndbrainPending = null;
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  server.signedIn = { id: 'julian', displayName: 'Julian', role: 'user' };
  server.notes = [row('julian', PLAN), row('julian', LOOSE)];
  server.content = new Map([
    [PLAN, 'as it was on disk'],
    [LOOSE, 'loose as it was'],
  ]);
  server.versions = new Map([
    [PLAN, 111],
    [LOOSE, 222],
  ]);
  server.writes = [];
  server.putFails = null;
  server.putDelayMs = 0;
});

afterEach(() => {
  window.localStorage.clear();
  window.__ndbrainPending = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mount(): void {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

async function openFromPalette(title: string): Promise<void> {
  await screen.findByRole('button', { name: copy.shell.account });
  await user.keyboard('{Control>}k{/Control}');
  const dialog = await screen.findByRole('dialog', { name: copy.palette.label });
  await user.click(await within(dialog).findByRole('button', { name: new RegExp(title) }));
  await screen.findByTestId('editor');
}

/** Opens a note by title and waits until the editor shows that one. */
async function switchTo(title: string, path: string): Promise<void> {
  await user.keyboard('{Control>}k{/Control}');
  const dialog = await screen.findByRole('dialog', { name: copy.palette.label });
  await user.click(await within(dialog).findByRole('button', { name: new RegExp(title) }));
  await waitFor(() => expect(screen.getByTestId('editor')).toHaveTextContent(path), { timeout: 3000 });
}

async function typeInEditor(label: 'type' | 'type again' = 'type'): Promise<void> {
  await user.click(within(screen.getByTestId('editor')).getByRole('button', { name: label }));
}

/** What the editor would be rebuilt from right now. */
function cached(path: string): string | undefined {
  return client.getQueryData<OpenNote>(keys.note('julian', path))?.note.content;
}

describe('a save that succeeded', () => {
  it('leaves the note’s cache entry holding what was written, not what was opened', async () => {
    mount();
    await openFromPalette('Plan');
    expect(screen.getByTestId('editor')).toHaveAttribute('data-content', 'as it was on disk');

    await typeInEditor();
    await advance(600);
    await waitFor(() => expect(server.writes).toHaveLength(1));
    expect(server.content.get(PLAN)).toBe('first draft');

    // The cache is what an editor is built from. Left at the version the note
    // was opened at, it hands back text older than the file — and the next
    // keystroke saves that older text over the newer one.
    await waitFor(() => expect(cached(PLAN)).toBe('first draft'));
  });
});

describe('a save that failed', () => {
  it('keeps the text and writes it again once the server answers', async () => {
    server.putFails = { status: 500, code: 'internal' };
    mount();
    await openFromPalette('Plan');
    await typeInEditor();
    await advance(600);

    await waitFor(() => expect(server.writes).toHaveLength(1));
    expect(await screen.findByText(copy.save.failed)).toBeInTheDocument();

    // The buffer was emptied before the request went out, so without a retry
    // the paragraph exists nowhere but the editor.
    server.putFails = null;
    await advance(4000);
    await waitFor(() => expect(server.writes.length).toBeGreaterThan(1), { timeout: 4000 });
    expect(server.content.get(PLAN)).toBe('first draft');
    expect(await screen.findByText(copy.save.saved)).toBeInTheDocument();
  });

  it('is still written when the tab is hidden afterwards', async () => {
    server.putFails = { status: 500, code: 'internal' };
    mount();
    await openFromPalette('Plan');
    await typeInEditor();
    await advance(600);
    await waitFor(() => expect(server.writes).toHaveLength(1));

    server.putFails = null;
    document.dispatchEvent(new Event('visibilitychange'));
    await advance(10);
    await waitFor(() => expect(server.content.get(PLAN)).toBe('first draft'), { timeout: 3000 });
  });

  it('is not relabelled “Saved” by opening another note', async () => {
    server.putFails = { status: 500, code: 'internal' };
    mount();
    await openFromPalette('Plan');
    await typeInEditor();
    await advance(600);
    await waitFor(() => expect(server.writes).toHaveLength(1));

    await switchTo('Loose', LOOSE);
    // The save is still failing, so the warning has to stay. Replacing it with
    // "Saved" is how somebody closes the tab on a paragraph that is nowhere.
    expect(screen.getByText(copy.save.failed)).toBeInTheDocument();
    expect(screen.queryByText(copy.save.saved)).toBeNull();
  });

  it('leaves the text where the crash box finds it when the session has ended', async () => {
    server.putFails = { status: 401, code: 'unauthenticated' };
    mount();
    await openFromPalette('Plan');
    await typeInEditor();
    await advance(600);

    await waitFor(() => expect(server.writes).toHaveLength(1));
    // The session is gone: the shell unmounts and the editor goes with it.
    await waitFor(() => expect(screen.queryByTestId('editor')).toBeNull(), { timeout: 3000 });
    expect(window.__ndbrainPending).toEqual({ path: PLAN, content: 'first draft' });

    // And nothing keeps knocking on a door that has been shut.
    const attempts = server.writes.length;
    await advance(10_000);
    expect(server.writes).toHaveLength(attempts);
  });
});

describe('a tab being closed', () => {
  it('asks before leaving while text is unsaved, and stops asking once it is written', async () => {
    mount();
    await openFromPalette('Plan');
    await typeInEditor();

    const asked = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(asked);
    expect(asked.defaultPrevented).toBe(true);

    await advance(600);
    await waitFor(() => expect(server.content.get(PLAN)).toBe('first draft'));

    const quiet = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(quiet);
    expect(quiet.defaultPrevented).toBe(false);
  });

  it('asks while a save is still failing, even with nothing typed since', async () => {
    server.putFails = { status: 500, code: 'internal' };
    mount();
    await openFromPalette('Plan');
    await typeInEditor();
    await advance(600);
    await waitFor(() => expect(server.writes).toHaveLength(1));

    const asked = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(asked);
    expect(asked.defaultPrevented).toBe(true);
  });
});
