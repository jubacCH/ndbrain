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
import { journalDays, localDate, monthGrid, notesPreview, shiftMonth, dailyNoteTemplate } from '../src/daily';
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
vi.mock('../src/Context', () => ({ ContextPanel: () => <div /> }));

const server = vi.hoisted(() => ({
  signedIn: null as User | null,
  notes: [] as NoteRow[],
  contents: new Map<string, string>(),
  ensureCalls: [] as Array<{ owner: string; path: string; content: string }>,
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

  it('answers the shortcut with either modifier', async () => {
    at('2026-09-17T10:00:00Z');
    await renderApp();

    fireEvent.keyDown(window, { key: 'd', code: 'KeyD', ctrlKey: true, shiftKey: true });
    await screen.findByTestId('editor');
    expect(server.ensureCalls.map((call) => call.path)).toEqual(['50_Journal/2026/09/2026-09-17.md']);

    // Without the shift it is somebody else's key.
    fireEvent.keyDown(window, { key: 'd', code: 'KeyD', metaKey: true });
    expect(server.ensureCalls).toHaveLength(1);
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
