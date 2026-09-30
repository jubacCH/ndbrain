/**
 * The warning the conflict copy was always missing.
 *
 * Last-writer-wins with a conflict copy was the decision, and the copy has been
 * built for a while: a save that displaces a version nobody here had seen
 * writes that version out beside the note. What was never built is the half
 * that lets somebody *avoid* needing it — you found out afterwards, from a file
 * called `… (Konflikt …)` sitting next to your note.
 *
 * So while a note is open the tab asks the server, on the pulse's own cadence,
 * which version of that note is on disk, and compares it against the version
 * the editor was filled from. What must stay true:
 *
 *  - the warning appears when somebody else's write moved the file on
 *  - it does **not** appear after this tab's own save, which also moves the
 *    file on — a warning that blinks after every autosave is one nobody reads
 *  - it goes when the conflict is over: this tab saved, or took their version
 *  - unsaved text survives all of it, including taking their version, which
 *    asks first because that is the one action here that throws work away
 *  - the poll stops when no note is open and while the tab is in the background
 *
 * Time is the test's, not the machine's: the poll is a timer and so is the
 * debounce, and on real timers a busy machine could stretch one past the other.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NoteRow, Share, User } from '../src/api';
import { App } from '../src/App';
import { copy } from '../src/copy';

vi.mock('../src/Brain', () => ({
  Brain: () => <canvas className="brain" data-testid="brain" />,
}));
// `data-content` is what the editor was built from, which is the only way to
// see that taking their version really replaced the document.
vi.mock('../src/Editor', () => ({
  Editor: (props: { path: string; initialContent: string; onChange: (content: string) => void }) => (
    <div data-testid="editor" data-content={props.initialContent}>
      {props.path}
      <button type="button" onClick={() => props.onChange('my paragraph')}>
        type
      </button>
    </div>
  ),
}));
vi.mock('../src/Context', () => ({ ContextPanel: () => <div /> }));

const server = vi.hoisted(() => ({
  signedIn: null as User | null,
  notes: [] as NoteRow[],
  received: [] as Share[],
  /** What the vault holds, by path. */
  content: new Map<string, string>(),
  /**
   * Every note's version, by path — an opaque string, as on the wire.
   *
   * Set directly by a test to stand for somebody else's write, and moved on by
   * every write this tab makes.
   */
  versions: new Map<string, string>(),
  writes: [] as Array<{ path: string; content: string; base: string | undefined }>,
  /** How many times the version of a note was asked for, by path. */
  versionCalls: new Map<string, number>(),
  /** Whether the version endpoint fails, as it does for a note that went away. */
  versionFails: false,
  /** How long the version endpoint takes, for the answer that arrives too late. */
  versionDelayMs: 0,
}));

vi.mock('../src/api', async (original) => {
  const real = await original<typeof import('../src/api')>();
  const writable = (owner: string, path: string): boolean =>
    owner === server.signedIn?.id ||
    server.received.some((s) => s.owner === owner && s.canWrite && path.startsWith(s.prefix));
  const fake: Record<string, (...args: never[]) => Promise<unknown>> = {
    me: async () => ({ user: server.signedIn }),
    tree: async () => ({ notes: server.notes, dirs: [] }),
    tidy: async () => ({
      orphans: [],
      untagged: [],
      deadLinks: [],
      stale: [],
      conflicts: [],
      missing: [],
      truncated: false,
      totals: { orphans: 0, untagged: 0, deadLinks: 0, stale: 0, conflicts: 0, missing: 0 },
    }),
    shares: async () => ({ granted: [], received: server.received }),
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
        canWrite: writable(owner, path),
        note: {
          path,
          title: row.title,
          content: server.content.get(path) ?? '',
          size: 0,
          mtimeMs: 0,
          hash: server.versions.get(path) ?? '0',
        },
      };
    },
    noteVersion: async (_owner: string, path: string) => {
      server.versionCalls.set(path, (server.versionCalls.get(path) ?? 0) + 1);
      const answer = server.versions.get(path) ?? '0';
      if (server.versionDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, server.versionDelayMs));
      }
      if (server.versionFails) throw new real.ApiError(404, 'not_found', 'gone');
      return { hash: answer };
    },
    putNote: async (_owner: string, path: string, content: string, base?: string) => {
      server.writes.push({ path, content, base });
      const displaced = base !== undefined && base !== server.versions.get(path);
      const version = `v${server.writes.length}`;
      server.versions.set(path, version);
      server.content.set(path, content);
      return {
        note: { path, title: '', content, size: content.length, mtimeMs: 0, hash: version },
        created: false,
        ...(displaced ? { conflictCopy: `${path.replace(/\.md$/, '')} (Konflikt 2026-09-30 10.00).md` } : {}),
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
const SHARED = 'Team/Gemeinsam.md';
const READ_ONLY = 'Lesen/Nur lesen.md';

let user: ReturnType<typeof userEvent.setup>;
let confirm: ReturnType<typeof vi.fn>;

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Puts the tab in the background, or brings it back, as the browser does. */
async function hidden(is: boolean): Promise<void> {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (is ? 'hidden' : 'visible'),
  });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
  user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  confirm = vi.fn(() => true);
  vi.stubGlobal('confirm', confirm);
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
  server.notes = [row('julian', PLAN), row('julian', LOOSE), row('anna', SHARED), row('anna', READ_ONLY)];
  server.received = [
    { id: 's1', owner: 'anna', prefix: 'Team/', grantee: 'julian', canWrite: true, createdAt: 0, kind: 'folder' as const },
    { id: 's2', owner: 'anna', prefix: 'Lesen/', grantee: 'julian', canWrite: false, createdAt: 0, kind: 'folder' as const },
  ];
  server.content = new Map([
    [PLAN, 'as it was on disk'],
    [LOOSE, 'loose as it was'],
    [SHARED, 'what Anna wrote'],
    [READ_ONLY, 'Annas eigene Notiz'],
  ]);
  server.versions = new Map([
    [PLAN, 'v-plan'],
    [LOOSE, 'v-loose'],
    [SHARED, 'v-shared'],
    [READ_ONLY, 'v-readonly'],
  ]);
  server.writes = [];
  server.versionCalls = new Map();
  server.versionFails = false;
  server.versionDelayMs = 0;
});

afterEach(async () => {
  await hidden(false);
  window.localStorage.clear();
  window.__ndbrainPending = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mount(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

async function typeInEditor(): Promise<void> {
  await user.click(within(screen.getByTestId('editor')).getByRole('button', { name: 'type' }));
}

/** Somebody else writes the file — a different version behind the same path. */
function somebodyElseWrote(path: string, text: string): void {
  server.content.set(path, text);
  server.versions.set(path, `theirs-${text.length}`);
}

const warned = (): HTMLElement | null => screen.queryByText(copy.staleNote.said);

/** One poll tick, however long the interval is. */
const POLL = 2000;

describe('somebody else changed the open note', () => {
  it('says so before the next save, naming what saving will do', async () => {
    mount();
    await openFromPalette('Plan');
    expect(warned()).toBeNull();

    somebodyElseWrote(PLAN, 'Anna hat weitergeschrieben');
    await advance(POLL);

    await waitFor(() => expect(warned()).not.toBeNull());
    expect(screen.getByText(copy.staleNote.whenSaving)).toBeInTheDocument();
  });

  it('says it about a note in somebody else’s vault, which is what it is for', async () => {
    mount();
    await openFromPalette('Gemeinsam');

    somebodyElseWrote(SHARED, 'Anna schreibt gerade selbst');
    await advance(POLL);

    await waitFor(() => expect(warned()).not.toBeNull());
  });

  it('does not get between a keystroke and its write', async () => {
    mount();
    await openFromPalette('Plan');
    somebodyElseWrote(PLAN, 'Anna hat weitergeschrieben');
    await advance(POLL);
    await waitFor(() => expect(warned()).not.toBeNull());

    // Typed under the warning: the text goes into the buffer and the slot the
    // crash box reads, exactly as it would without one.
    await typeInEditor();
    expect(window.__ndbrainPending).toEqual({ path: PLAN, content: 'my paragraph' });
    expect(warned()).not.toBeNull();

    // And the debounce fires as it always would, so the paragraph lands —
    // naming the version this screen was filled from, which is what makes the
    // server keep theirs.
    await advance(600);
    await waitFor(() => expect(server.writes.map((w) => w.content)).toEqual(['my paragraph']));
    expect(server.writes[0]?.base).toBe('v-plan');
    expect(server.content.get(PLAN)).toBe('my paragraph');
  });

  it('keeps quiet while the tab is in the background, and asks again on return', async () => {
    mount();
    await openFromPalette('Plan');
    await waitFor(() => expect(server.versionCalls.get(PLAN) ?? 0).toBeGreaterThan(0));

    await hidden(true);
    const asked = server.versionCalls.get(PLAN) ?? 0;
    somebodyElseWrote(PLAN, 'Anna hat weitergeschrieben');
    await advance(POLL * 5);
    expect(server.versionCalls.get(PLAN) ?? 0).toBe(asked);
    expect(warned()).toBeNull();

    await hidden(false);
    await waitFor(() => expect(warned()).not.toBeNull());
  });

  it('stops asking once the note is closed', async () => {
    mount();
    await openFromPalette('Plan');
    await waitFor(() => expect(server.versionCalls.get(PLAN) ?? 0).toBeGreaterThan(0));

    await user.click(await screen.findByRole('button', { name: copy.nav.overview }));
    await waitFor(() => expect(screen.queryByTestId('editor')).toBeNull());
    const asked = server.versionCalls.get(PLAN) ?? 0;

    await advance(POLL * 5);
    expect(server.versionCalls.get(PLAN) ?? 0).toBe(asked);
  });

  it('does not follow you to the next note while that note’s version is still being asked', async () => {
    mount();
    await openFromPalette('Plan');
    somebodyElseWrote(PLAN, 'Anna hat weitergeschrieben');
    await advance(POLL);
    await waitFor(() => expect(warned()).not.toBeNull());

    // The next note's version takes a while to come back, so nothing clears the
    // warning for us: opening a note has to do it, or the bar sits over a note
    // it was never about for as long as the answer takes.
    server.versionDelayMs = 3000;
    await switchTo('Loose', LOOSE);

    expect(server.versionCalls.get(LOOSE) ?? 0).toBeGreaterThan(0);
    expect(warned()).toBeNull();
  });

  it('never warns about the note that was left, when its answer arrives late', async () => {
    // Slower than the switch, so the answer for the first note lands while the
    // second is on screen. Two things keep it off: the effect for the note that
    // was left is torn down, and `sawVersion` ignores a report about a note
    // that is not the one open. Either alone would do; both are cheap.
    server.versionDelayMs = 3000;
    mount();
    await openFromPalette('Plan');
    somebodyElseWrote(PLAN, 'Anna hat weitergeschrieben');

    await switchTo('Loose', LOOSE);
    await advance(POLL * 3);

    expect(warned()).toBeNull();
  });

  it('never asks about a note it may only read', async () => {
    // The server would refuse anyway — the version is for whoever could
    // overwrite the file, and a read-only reader polling a hash is watching the
    // owner type. Not asking is where that is decided a second time, and it is
    // also the only way the poll stays one request per two seconds for the one
    // person it can help.
    mount();
    await openFromPalette('Nur lesen');
    somebodyElseWrote(READ_ONLY, 'Anna schreibt in ihrer eigenen Notiz');

    await advance(POLL * 3);

    expect(server.versionCalls.get(READ_ONLY)).toBeUndefined();
    expect(warned()).toBeNull();
  });

  it('says nothing when the version cannot be had at all', async () => {
    server.versionFails = true;
    mount();
    await openFromPalette('Plan');
    await advance(POLL * 3);
    expect(warned()).toBeNull();
  });
});

describe('this tab’s own save', () => {
  it('raises no warning, however many times the note is written', async () => {
    mount();
    await openFromPalette('Plan');

    for (let i = 0; i < 3; i += 1) {
      await typeInEditor();
      await advance(600);
      await advance(POLL);
    }

    expect(server.writes.length).toBe(3);
    expect(warned()).toBeNull();
  });

  it('ends a warning that was already on screen, since the file is now this tab’s', async () => {
    mount();
    await openFromPalette('Plan');
    somebodyElseWrote(PLAN, 'Anna hat weitergeschrieben');
    await advance(POLL);
    await waitFor(() => expect(warned()).not.toBeNull());

    await typeInEditor();
    await advance(600);

    // Gone as soon as the write answers, not at the next poll: the conflict
    // copy is being reported in the same breath, and a bar still warning about
    // a save that has just happened reads as a second, unresolved problem.
    //
    // Asserted without `waitFor` on purpose. Under fake timers `waitFor`
    // advances the clock while it waits, which would run the poll and clear the
    // warning for the wrong reason — see `advance`. The next tick is at 4000 ms
    // and this is 2600.
    expect(warned()).toBeNull();
    expect(server.writes[0]?.base).toBe('v-plan');
  });
});

describe('taking their version instead', () => {
  it('replaces the document with what is on the server, with nothing to lose', async () => {
    mount();
    await openFromPalette('Plan');
    somebodyElseWrote(PLAN, 'Anna hat weitergeschrieben');
    await advance(POLL);
    await waitFor(() => expect(warned()).not.toBeNull());

    await user.click(screen.getByRole('button', { name: copy.staleNote.load }));

    await waitFor(() =>
      expect(screen.getByTestId('editor')).toHaveAttribute('data-content', 'Anna hat weitergeschrieben'),
    );
    await waitFor(() => expect(warned()).toBeNull());
    // Nothing was typed, so nothing was asked and nothing was written.
    expect(confirm).not.toHaveBeenCalled();
    expect(server.writes).toEqual([]);
  });

  it('asks first when there is text that has not been written, and keeps it on a no', async () => {
    confirm.mockReturnValue(false);
    mount();
    await openFromPalette('Plan');
    somebodyElseWrote(PLAN, 'Anna hat weitergeschrieben');
    await advance(POLL);
    await waitFor(() => expect(warned()).not.toBeNull());
    await typeInEditor();

    await user.click(screen.getByRole('button', { name: copy.staleNote.load }));
    expect(confirm).toHaveBeenCalledWith(copy.staleNote.loseTyped);

    // Still the text that was typed, still on its way to the server.
    expect(screen.getByTestId('editor')).toHaveAttribute('data-content', 'as it was on disk');
    expect(warned()).not.toBeNull();
    await advance(600);
    await waitFor(() => expect(server.writes.map((w) => w.content)).toEqual(['my paragraph']));
  });

  it('drops the typed text on a yes rather than writing it after the reload', async () => {
    mount();
    await openFromPalette('Plan');
    somebodyElseWrote(PLAN, 'Anna hat weitergeschrieben');
    await advance(POLL);
    await waitFor(() => expect(warned()).not.toBeNull());
    await typeInEditor();

    await user.click(screen.getByRole('button', { name: copy.staleNote.load }));
    expect(confirm).toHaveBeenCalledWith(copy.staleNote.loseTyped);

    await waitFor(() =>
      expect(screen.getByTestId('editor')).toHaveAttribute('data-content', 'Anna hat weitergeschrieben'),
    );
    // The debounce would have fired long ago; nothing must go out after it.
    await advance(POLL * 2);
    expect(server.writes).toEqual([]);
    expect(window.__ndbrainPending).toBeNull();
    await waitFor(() => expect(warned()).toBeNull());
  });
});
