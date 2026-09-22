/**
 * Daily notes in the app.
 *
 * What is pinned here:
 *
 *  - "today" is the device's local date, including just after midnight and
 *    around both daylight saving changes — not the UTC date
 *  - every way in (the sidebar button, the shortcut, the palette) opens today's
 *    note, creating it through the create-if-absent write and nothing else, and
 *    always in the caller's own vault, whatever note is open
 *  - asking twice at once sends one request, and a day that exists is opened
 *    without writing at all
 *  - the calendar marks the right days, opens them, asks before creating one,
 *    and can be driven from the keyboard
 *  - the home card previews what was written under "Notizen" and pages by day
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NoteRow, Overview, User } from '../src/api';
import { App } from '../src/App';
import { copy } from '../src/copy';
import {
  journalDays,
  localDate,
  monthGrid,
  notesPreview,
  shiftMonth,
  dailyNoteTemplate,
  NOTES_SECTION,
} from '../src/daily';
import { HomeView } from '../src/Home';
import { JournalView } from '../src/Journal';
import { matchCommands } from '../src/Palette';

const previousTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Europe/Zurich';
});
afterAll(() => {
  process.env.TZ = previousTz;
});

vi.mock('../src/Brain', () => ({ Brain: () => <canvas data-testid="brain" /> }));
vi.mock('../src/Editor', () => ({
  Editor: (props: { owner: string; path: string; initialContent: string }) => (
    <div data-testid="editor" data-owner={props.owner} data-path={props.path}>
      {props.initialContent}
    </div>
  ),
}));
// The context panel's one action here: following a link that points nowhere yet.
vi.mock('../src/Context', () => ({
  ContextPanel: (props: { onCreate: (target: string) => void }) => (
    <button type="button" onClick={() => props.onCreate('50_Journal/2026/09/2026-09-18')}>
      follow tomorrow
    </button>
  ),
}));

const server = vi.hoisted(() => ({
  signedIn: null as User | null,
  notes: [] as NoteRow[],
  contents: new Map<string, string>(),
  ensureCalls: [] as Array<{ owner: string; path: string; content: string }>,
  /** Plain writes, which a followed link must not fall back to either. */
  putCalls: [] as Array<{ owner: string; path: string }>,
  /** What the capture field on the start page sent. */
  appendCalls: [] as Array<{
    owner: string;
    path: string;
    content: string;
    section?: string;
    ifAbsent?: string;
  }>,
  /** Set to make the next append fail, as a server that is not reachable does. */
  appendFails: false,
  /** Held open until released, so a test can press twice while the first is in flight. */
  gate: null as Promise<void> | null,
}));

vi.mock('../src/api', async (original) => {
  const real = await original<typeof import('../src/api')>();
  const key = (owner: string, path: string): string => `${owner} ${path}`;
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
    graph: async () => ({ nodes: [], edges: [] }),
    quickFind: async () => ({ notes: server.notes }),
    getNote: async (owner: string, path: string) => {
      const content = server.contents.get(key(owner, path));
      if (content === undefined) throw new real.ApiError(404, 'not_found', 'gone');
      return {
        owner,
        canWrite: owner === server.signedIn?.id,
        note: { path, title: path.split('/').pop()!.replace(/\.md$/, ''), content, size: content.length, mtimeMs: 1 },
      };
    },
    putNote: async (owner: string, path: string) => {
      server.putCalls.push({ owner, path });
      return { note: { path, title: '', content: '', size: 0, mtimeMs: 2 }, created: true };
    },
    overview: async () => ({
      counts: { notes: 0, orphans: 0, untagged: 0, deadLinks: 0, stale: 0, conflicts: 0, attention: 0, tagsInUse: false },
      recent: [],
      tasks: [],
      tags: [],
      activity: [],
    }),
    activityDays: async () => ({ days: [] }),
    append: async (
      owner: string,
      path: string,
      content: string,
      options: { section?: string; ifAbsent?: string } = {},
    ) => {
      server.appendCalls.push({ owner, path, content, ...options });
      if (server.appendFails) throw new real.ApiError(503, 'unavailable', 'nope');
      const existing = server.contents.get(key(owner, path));
      const created = existing === undefined;
      const before = existing ?? options.ifAbsent ?? '';
      const text = `${before}\n${content}`;
      server.contents.set(key(owner, path), text);
      if (created) {
        server.notes = [...server.notes, { owner, path, title: path.split('/').pop()!.replace(/\.md$/, ''), size: 1, mtimeMs: 1 }];
      }
      return {
        created,
        note: { path, title: path.split('/').pop()!.replace(/\.md$/, ''), content: text, size: text.length, mtimeMs: 2 },
      };
    },
    ensureNote: async (owner: string, path: string, content: string) => {
      server.ensureCalls.push({ owner, path, content });
      if (server.gate !== null) await server.gate;
      const existing = server.contents.get(key(owner, path));
      const created = existing === undefined;
      if (created) {
        server.contents.set(key(owner, path), content);
        server.notes = [...server.notes, { owner, path, title: path.split('/').pop()!.replace(/\.md$/, ''), size: 1, mtimeMs: 1 }];
      }
      const text = server.contents.get(key(owner, path))!;
      return {
        created,
        note: { path, title: path.split('/').pop()!.replace(/\.md$/, ''), content: text, size: text.length, mtimeMs: 1 },
      };
    },
  };
  const api = new Proxy(fake, { get: (target, name: string) => target[name] ?? (() => new Promise(() => {})) });
  return { ...real, api };
});

const JULIAN: User = { id: 'julian', displayName: 'Julian', role: 'user' };

function row(owner: string, path: string): NoteRow {
  return { owner, path, title: path.split('/').pop()!.replace(/\.md$/, ''), size: 1, mtimeMs: 1 };
}

beforeEach(() => {
  window.localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  server.signedIn = JULIAN;
  server.notes = [];
  server.contents = new Map();
  server.ensureCalls = [];
  server.putCalls = [];
  server.appendCalls = [];
  server.appendFails = false;
  server.gate = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

/** Fakes only the clock, so React Query and the test library keep real timers. */
function at(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

describe('the local day', () => {
  it('runs in the time zone the tests assume', () => {
    expect(new Date('2026-09-17T22:30:00Z').getHours()).toBe(0);
  });

  it.each([
    // Half past midnight in Zurich, still the day before in UTC.
    ['2026-09-17T22:30:00Z', '2026-09-18'],
    ['2026-09-17T21:59:00Z', '2026-09-17'],
    // The night winter time ends: 00:30 CET on the 29th of March.
    ['2026-03-28T23:30:00Z', '2026-03-29'],
    // After the clocks went forward: 03:30 CEST, still the 29th.
    ['2026-03-29T01:30:00Z', '2026-03-29'],
    // The night summer time ends: 00:30 CEST on the 25th of October…
    ['2026-10-24T22:30:00Z', '2026-10-25'],
    // …and 00:30 CET on the 26th, an hour later in UTC than a day before.
    ['2026-10-25T23:30:00Z', '2026-10-26'],
  ])('at %s it is %s', (instant, expected) => {
    at(instant);
    const today = localDate(new Date());
    expect(`${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`).toBe(expected);
  });
});

describe('the pieces', () => {
  it('counts only days in the caller own journal', () => {
    const days = journalDays(
      [
        row('julian', '50_Journal/2026/09/2026-09-16.md'),
        row('anna', '50_Journal/2026/09/2026-09-17.md'),
        // A space, even one the caller may write in, keeps no days for them.
        row('familie', '50_Journal/2026/09/2026-09-20.md'),
        row('julian', '50_Journal/2026/10/2026-09-18.md'),
        row('julian', 'Inbox/2026-09-19.md'),
      ],
      'julian',
    );
    expect([...days]).toEqual(['2026-09-16']);
  });

  it('lays a month out in whole weeks, Monday first', () => {
    const weeks = monthGrid(2026, 9);
    expect(weeks).toHaveLength(5);
    expect(weeks[0]![0]!.date).toEqual({ year: 2026, month: 8, day: 31 });
    expect(weeks[0]![1]!.date).toEqual({ year: 2026, month: 9, day: 1 });
    expect(weeks.flat().filter((cell) => cell.inMonth)).toHaveLength(30);
    // February 2027 starts on a Monday and fills exactly four weeks.
    expect(monthGrid(2027, 2)).toHaveLength(4);
    expect(shiftMonth({ year: 2026, month: 1, day: 31 }, -2)).toEqual({ year: 2025, month: 11, day: 30 });
  });

  it('previews what was written under Notizen, as plain text', () => {
    const template = dailyNoteTemplate({ year: 2026, month: 9, day: 17 });
    expect(notesPreview(template)).toEqual([]);
    const written = template.replace(
      '## Notizen\n',
      '## Notizen\n\n- Mit **Anna** über [[20_Areas/Proxmox|den Cluster]] geredet\n- `pct` Upgrade\n\nDritte Zeile\nVierte Zeile\n',
    );
    expect(notesPreview(written)).toEqual(['Mit Anna über den Cluster geredet', 'pct Upgrade', 'Dritte Zeile']);
  });

  it('finds the command by its words', () => {
    const today = { key: 'today', label: "Open today's note", keywords: 'today daily journal heute', run: vi.fn() };
    expect(matchCommands([today], '')).toEqual([today]);
    expect(matchCommands([today], 'heute')).toEqual([today]);
    expect(matchCommands([today], 'daily note')).toEqual([today]);
    expect(matchCommands([today], 'proxmox')).toEqual([]);
  });
});

describe('opening today from the shell', () => {
  async function renderApp(): Promise<void> {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
    await screen.findByRole('button', { name: copy.nav.todayHint });
  }

  const todayButton = (): HTMLElement => screen.getByRole('button', { name: copy.nav.todayHint });

  it('creates the local day from the template and opens it, after midnight too', async () => {
    at('2026-09-17T22:30:00Z');
    await renderApp();

    await userEvent.click(todayButton());

    const editor = await screen.findByTestId('editor');
    expect(editor).toHaveAttribute('data-path', '50_Journal/2026/09/2026-09-18.md');
    expect(editor).toHaveAttribute('data-owner', 'julian');
    expect(server.ensureCalls).toEqual([
      {
        owner: 'julian',
        path: '50_Journal/2026/09/2026-09-18.md',
        content: dailyNoteTemplate({ year: 2026, month: 9, day: 18 }),
      },
    ]);
    expect(editor.textContent).toContain('# Freitag, 18. September 2026');
    await waitFor(() => expect(todayButton()).toHaveAttribute('aria-current', 'true'));
  });

  it('sends one request for two quick presses, and none for a day that exists', async () => {
    at('2026-09-17T10:00:00Z');
    let release!: () => void;
    server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await renderApp();

    fireEvent.click(todayButton());
    fireEvent.click(todayButton());
    fireEvent.keyDown(window, { key: 'D', code: 'KeyD', metaKey: true, shiftKey: true });
    await act(async () => {
      release();
    });
    await screen.findByTestId('editor');
    expect(server.ensureCalls).toHaveLength(1);

    // The tree now knows the day: the next press only opens it.
    await waitFor(() => expect(server.notes).toHaveLength(1));
    server.gate = null;
    await userEvent.click(screen.getByRole('button', { name: copy.nav.overview }));
    await userEvent.click(todayButton());
    await waitFor(() =>
      expect(screen.getByTestId('editor')).toHaveAttribute('data-path', '50_Journal/2026/09/2026-09-17.md'),
    );
    expect(server.ensureCalls).toHaveLength(1);
  });

  it('opens what another tab already wrote rather than the template', async () => {
    at('2026-09-17T10:00:00Z');
    await renderApp();
    // Written elsewhere after this tab loaded its tree.
    server.contents.set('julian 50_Journal/2026/09/2026-09-17.md', 'Schon angefangen.\n');

    await userEvent.click(todayButton());

    const editor = await screen.findByTestId('editor');
    expect(editor.textContent).toBe('Schon angefangen.\n');
  });

  it('reopens a day with what is on disk now, not what it said when first opened', async () => {
    at('2026-09-17T10:00:00Z');
    await renderApp();

    await userEvent.click(todayButton());
    expect((await screen.findByTestId('editor')).textContent).toContain('## Notizen');

    // Written since — in this tab before leaving, or by anybody else.
    server.contents.set('julian 50_Journal/2026/09/2026-09-17.md', 'Seither geschrieben.\n');
    await userEvent.click(screen.getByRole('button', { name: copy.nav.overview }));
    await waitFor(() => expect(screen.queryByTestId('editor')).toBeNull());
    await userEvent.click(todayButton());

    await waitFor(() => expect(screen.getByTestId('editor').textContent).toBe('Seither geschrieben.\n'));
  });

  it('answers the shortcut with either modifier', async () => {
    at('2026-09-17T10:00:00Z');
    await renderApp();

    // Without the shift it is somebody else's key: the browser's bookmark, the
    // editor's next occurrence.
    fireEvent.keyDown(window, { key: 'd', code: 'KeyD', metaKey: true });
    fireEvent.keyDown(window, { key: 'd', code: 'KeyD', ctrlKey: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(server.ensureCalls).toHaveLength(0);

    fireEvent.keyDown(window, { key: 'd', code: 'KeyD', ctrlKey: true, shiftKey: true });
    await screen.findByTestId('editor');
    expect(server.ensureCalls.map((call) => call.path)).toEqual(['50_Journal/2026/09/2026-09-17.md']);
  });

  it('is a command in the palette', async () => {
    at('2026-09-17T10:00:00Z');
    await renderApp();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const dialog = await screen.findByRole('dialog', { name: copy.palette.label });
    await userEvent.type(within(dialog).getByRole('textbox'), 'today');
    await userEvent.keyboard('{Enter}');

    expect(await screen.findByTestId('editor')).toHaveAttribute('data-path', '50_Journal/2026/09/2026-09-17.md');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('never starts a day in a vault shared with the caller', async () => {
    at('2026-09-17T10:00:00Z');
    server.notes = [row('anna', 'Shared/Plan.md'), row('anna', '50_Journal/2026/09/2026-09-17.md')];
    server.contents.set('anna Shared/Plan.md', 'Annas Plan');
    server.contents.set('anna 50_Journal/2026/09/2026-09-17.md', 'Annas Tag');
    await renderApp();

    // Standing in Anna's note, and with Anna's day in view, today is still Julian's.
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await userEvent.click(await screen.findByRole('button', { name: /Plan/ }));
    await waitFor(() => expect(screen.getByTestId('editor')).toHaveAttribute('data-owner', 'anna'));

    await userEvent.click(todayButton());
    await waitFor(() => expect(screen.getByTestId('editor')).toHaveAttribute('data-owner', 'julian'));
    expect(server.ensureCalls.map((call) => call.owner)).toEqual(['julian']);
  });

  it('follows a day link from a daily note of your own into your journal', async () => {
    at('2026-09-17T10:00:00Z');
    server.notes = [row('julian', '50_Journal/2026/09/2026-09-17.md')];
    server.contents.set('julian 50_Journal/2026/09/2026-09-17.md', 'Mein Tag');
    await renderApp();
    await userEvent.click(todayButton());
    await waitFor(() => expect(screen.getByTestId('editor')).toHaveAttribute('data-owner', 'julian'));

    await userEvent.click(screen.getByRole('button', { name: 'follow tomorrow' }));
    await waitFor(() => expect(screen.getByTestId('editor')).toHaveAttribute('data-path', '50_Journal/2026/09/2026-09-18.md'));
    expect(server.ensureCalls.map((call) => `${call.owner} ${call.path}`)).toEqual(['julian 50_Journal/2026/09/2026-09-18.md']);
    expect(server.putCalls).toEqual([]);
  });

  it('follows a day link in somebody else’s daily note nowhere: nothing is created, in either vault', async () => {
    at('2026-09-17T10:00:00Z');
    server.notes = [row('anna', '50_Journal/2026/09/2026-09-17.md')];
    server.contents.set('anna 50_Journal/2026/09/2026-09-17.md', 'Annas Tag');
    await renderApp();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await userEvent.click(await screen.findByRole('button', { name: /2026-09-17/ }));
    await waitFor(() => expect(screen.getByTestId('editor')).toHaveAttribute('data-owner', 'anna'));

    await userEvent.click(screen.getByRole('button', { name: 'follow tomorrow' }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(server.ensureCalls).toEqual([]);
    expect(server.putCalls).toEqual([]);
    expect(screen.getByTestId('editor')).toHaveAttribute('data-owner', 'anna');
    expect(screen.getByTestId('editor')).toHaveAttribute('data-path', '50_Journal/2026/09/2026-09-17.md');
  });

  it('shows the journal view from the navigation', async () => {
    at('2026-09-17T10:00:00Z');
    server.notes = [row('julian', '50_Journal/2026/09/2026-09-15.md')];
    await renderApp();

    await userEvent.click(screen.getByRole('button', { name: copy.nav.journal }));

    const grid = await screen.findByRole('grid');
    expect(within(grid).getByRole('button', { name: /September 15, 2026, has a note/ })).toBeInTheDocument();
    expect(screen.getByText(copy.shell.sub.journal(1, 1))).toBeInTheDocument();
  });
});

describe('the journal calendar', () => {
  const NOW = new Date(2026, 8, 17, 10).getTime();

  function renderCalendar(days: string[] = ['2026-09-03', '2026-09-16']) {
    const onOpenDay = vi.fn();
    render(<JournalView days={new Set(days)} now={NOW} onOpenDay={onOpenDay} />);
    return { onOpenDay, grid: screen.getByRole('grid') };
  }

  const day = (grid: HTMLElement, iso: string): HTMLElement =>
    grid.querySelector<HTMLElement>(`[data-date="${iso}"]`)!;

  it('marks the days with a note and rings today', () => {
    const { grid } = renderCalendar();
    expect(screen.getByRole('heading', { name: 'September 2026' })).toBeInTheDocument();
    expect(day(grid, '2026-09-03')).toHaveAttribute('data-has', 'true');
    expect(day(grid, '2026-09-04')).toHaveAttribute('data-has', 'false');
    expect(day(grid, '2026-09-17')).toHaveAttribute('aria-current', 'date');
    expect(day(grid, '2026-09-17')).toHaveAccessibleName('Thursday, September 17, 2026, today, no note yet');
    expect(screen.getByText(copy.journal.count(2))).toBeInTheDocument();
  });

  it('opens a day with a note straight away', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const { grid, onOpenDay } = renderCalendar();
    await userEvent.click(day(grid, '2026-09-16'));
    expect(onOpenDay).toHaveBeenCalledWith({ year: 2026, month: 9, day: 16 });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks before starting a day that has none', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    const { grid, onOpenDay } = renderCalendar();

    await userEvent.click(day(grid, '2026-09-20'));
    expect(confirm).toHaveBeenCalledWith(copy.journal.askCreate('Sunday, September 20, 2026'));
    expect(onOpenDay).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await userEvent.click(day(grid, '2026-09-20'));
    expect(onOpenDay).toHaveBeenCalledWith({ year: 2026, month: 9, day: 20 });
  });

  it('moves by day, week and month from the keyboard, turning the page at the edge', async () => {
    vi.stubGlobal('confirm', () => true);
    const { grid, onOpenDay } = renderCalendar();

    // Past the month buttons ("Today" is disabled in the current month), into the grid.
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    expect(day(grid, '2026-09-17')).toHaveFocus();
    // Only one cell is in the tab order.
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);

    await userEvent.keyboard('{ArrowRight}');
    expect(day(grid, '2026-09-18')).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(day(grid, '2026-09-11')).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(day(grid, '2026-09-07')).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(day(grid, '2026-09-13')).toHaveFocus();

    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    // 13 + 21 = 4 October: the page has turned.
    expect(screen.getByRole('heading', { name: 'October 2026' })).toBeInTheDocument();
    expect(day(screen.getByRole('grid'), '2026-10-04')).toHaveFocus();

    await userEvent.keyboard('{PageUp}');
    expect(screen.getByRole('heading', { name: 'September 2026' })).toBeInTheDocument();
    expect(day(screen.getByRole('grid'), '2026-09-04')).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(onOpenDay).toHaveBeenCalledWith({ year: 2026, month: 9, day: 4 });
  });

  it('pages by month with the buttons and comes back to today', async () => {
    renderCalendar();
    await userEvent.click(screen.getByRole('button', { name: copy.journal.nextMonth }));
    expect(screen.getByRole('heading', { name: 'October 2026' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: copy.journal.previousMonth }));
    await userEvent.click(screen.getByRole('button', { name: copy.journal.previousMonth }));
    expect(screen.getByRole('heading', { name: 'August 2026' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: copy.journal.thisMonth }));
    expect(screen.getByRole('heading', { name: 'September 2026' })).toBeInTheDocument();
  });
});

describe('the home card', () => {
  const NOW = new Date(2026, 8, 17, 10).getTime();
  const overview: Overview = {
    counts: { notes: 1, orphans: 0, untagged: 0, deadLinks: 0, stale: 0, conflicts: 0, attention: 0, tagsInUse: false },
    recent: [],
    tasks: [],
    tags: [],
    activity: [],
  };

  function renderHome(days: string[]) {
    const onOpenDay = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <HomeView
          overview={overview}
          self="julian"
          ownNotes={1}
          recents={[]}
          hidePrefixes
          now={NOW}
          onOpen={vi.fn()}
          onTasks={vi.fn()}
          onTidy={vi.fn()}
          onNetwork={vi.fn()}
          journalDays={new Set(days)}
          onOpenDay={onOpenDay}
          onCapture={vi.fn(async () => {})}
        />
      </QueryClientProvider>,
    );
    return { onOpenDay, card: screen.getByRole('region', { name: copy.journal.card }) };
  }

  it('previews today and opens it', async () => {
    server.contents.set(
      'julian 50_Journal/2026/09/2026-09-17.md',
      dailyNoteTemplate({ year: 2026, month: 9, day: 17 }).replace('## Notizen\n', '## Notizen\nErste Zeile\n'),
    );
    const { card, onOpenDay } = renderHome(['2026-09-17']);

    expect(await within(card).findByText('Erste Zeile')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: /Thursday, September 17, 2026/ }));
    expect(onOpenDay).toHaveBeenCalledWith({ year: 2026, month: 9, day: 17 });
  });

  it('offers to start today when there is no note, and pages to yesterday', async () => {
    server.contents.set(
      'julian 50_Journal/2026/09/2026-09-16.md',
      dailyNoteTemplate({ year: 2026, month: 9, day: 16 }),
    );
    const { card, onOpenDay } = renderHome(['2026-09-16']);

    await userEvent.click(within(card).getByRole('button', { name: copy.journal.start }));
    expect(onOpenDay).toHaveBeenCalledWith({ year: 2026, month: 9, day: 17 });

    await userEvent.click(within(card).getByRole('button', { name: copy.journal.previousDay }));
    expect(await within(card).findByText(copy.journal.emptyNotes)).toBeInTheDocument();
    expect(within(card).getByText('Wednesday, September 16, 2026')).toBeInTheDocument();

    await userEvent.click(within(card).getByRole('button', { name: copy.journal.nextDay }));
    await userEvent.click(within(card).getByRole('button', { name: copy.journal.nextDay }));
    await userEvent.click(within(card).getByRole('button', { name: copy.journal.startDay('Friday, September 18, 2026') }));
    expect(onOpenDay).toHaveBeenLastCalledWith({ year: 2026, month: 9, day: 18 });

    await userEvent.click(within(card).getByRole('button', { name: copy.journal.backToToday }));
    expect(within(card).getByRole('button', { name: copy.journal.start })).toBeInTheDocument();
  });
});

/**
 * The one field on the start page.
 *
 * The point of it is that a thought costs nothing to write down: no dialog, no
 * path, no view change. What is pinned here is the whole of that promise —
 * where the text goes, that it goes without being read back first, that the
 * field empties only when the server has it, and that a failure leaves the
 * words on screen rather than in a lost request.
 */
describe('capturing a thought on the start page', () => {
  async function renderApp(): Promise<void> {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
    await screen.findByRole('button', { name: copy.nav.todayHint });
    await userEvent.click(screen.getByRole('button', { name: copy.nav.overview }));
  }

  const field = (): HTMLTextAreaElement =>
    screen.getByLabelText(copy.capture.label) as HTMLTextAreaElement;

  it("appends to today's note, under Notizen, without reading it first", async () => {
    at('2026-09-17T10:00:00Z');
    await renderApp();

    await userEvent.type(await screen.findByLabelText(copy.capture.label), 'Ein Gedanke.');
    await userEvent.click(screen.getByRole('button', { name: copy.capture.save }));

    await waitFor(() => expect(server.appendCalls).toHaveLength(1));
    expect(server.appendCalls[0]).toEqual({
      owner: 'julian',
      path: '50_Journal/2026/09/2026-09-17.md',
      content: 'Ein Gedanke.',
      section: NOTES_SECTION,
      ifAbsent: dailyNoteTemplate({ year: 2026, month: 9, day: 17 }),
    });
    // Nothing was written whole and nothing was opened: the note stays closed.
    expect(server.putCalls).toEqual([]);
    expect(server.ensureCalls).toEqual([]);
    expect(screen.queryByTestId('editor')).toBeNull();
  });

  it('empties the field and says the thought arrived', async () => {
    at('2026-09-17T10:00:00Z');
    await renderApp();

    await userEvent.type(await screen.findByLabelText(copy.capture.label), 'Ein Gedanke.');
    await userEvent.click(screen.getByRole('button', { name: copy.capture.save }));

    await waitFor(() => expect(field()).toHaveValue(''));
    expect(await screen.findByText(copy.capture.saved)).toBeInTheDocument();
  });

  /**
   * The rule this project measures every input by. A capture field that
   * swallows the words on a failed request is worse than no field at all.
   */
  it('keeps the text when the write fails', async () => {
    at('2026-09-17T10:00:00Z');
    server.appendFails = true;
    await renderApp();

    await userEvent.type(await screen.findByLabelText(copy.capture.label), 'Zu wertvoll zum Verlieren.');
    await userEvent.click(screen.getByRole('button', { name: copy.capture.save }));

    expect(await screen.findByText(copy.capture.failed)).toBeInTheDocument();
    expect(field()).toHaveValue('Zu wertvoll zum Verlieren.');

    // And it can simply be sent again once the server is back.
    server.appendFails = false;
    await userEvent.click(screen.getByRole('button', { name: copy.capture.save }));
    await waitFor(() => expect(field()).toHaveValue(''));
    expect(server.appendCalls.map((call) => call.content)).toEqual([
      'Zu wertvoll zum Verlieren.',
      'Zu wertvoll zum Verlieren.',
    ]);
  });

  it('takes a thought of several lines, and sends it on the modifier, not on Enter alone', async () => {
    at('2026-09-17T10:00:00Z');
    await renderApp();

    const box = await screen.findByLabelText(copy.capture.label);
    await userEvent.type(box, 'Erste Zeile{Enter}Zweite Zeile');
    expect(server.appendCalls).toEqual([]);
    expect(field()).toHaveValue('Erste Zeile\nZweite Zeile');

    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() => expect(server.appendCalls).toHaveLength(1));
    expect(server.appendCalls[0]!.content).toBe('Erste Zeile\nZweite Zeile');
  });

  it('sends nothing for a field holding only spaces', async () => {
    at('2026-09-17T10:00:00Z');
    await renderApp();

    await userEvent.type(await screen.findByLabelText(copy.capture.label), '   ');
    await userEvent.click(screen.getByRole('button', { name: copy.capture.save }));

    await new Promise((r) => setTimeout(r, 20));
    expect(server.appendCalls).toEqual([]);
  });

  /**
   * The cards around this one label themselves with a paragraph, and the page
   * already says "Overview" twice. The new field does not add to that: its card
   * is a heading and its box has a label of its own.
   */
  it('names itself with a heading and labels its box', async () => {
    at('2026-09-17T10:00:00Z');
    await renderApp();

    const card = await screen.findByRole('region', { name: copy.capture.title });
    expect(within(card).getByRole('heading', { name: copy.capture.title })).toBeInTheDocument();
    expect(within(card).getByLabelText(copy.capture.label)).toBe(field());
  });
});
