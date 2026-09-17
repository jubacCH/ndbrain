/**
 * The home view and the health head of Tidy up.
 *
 * What is pinned here: nothing the old overview showed is gone, a click leads
 * where the number says, "today" shows only what the server counted, the trace
 * appears only when it has something to show, and an empty finding is said
 * plainly rather than celebrated.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, type ActivityDay, type NoteRow, type Overview, type Tidy } from '../src/api';
import { copy } from '../src/copy';
import { HomeView, Trace, localDayBounds } from '../src/Home';
import { TidyView } from '../src/Views';

const NOW = new Date(2026, 8, 17, 15, 0).getTime();
const HOUR = 60 * 60 * 1000;

function note(path: string, title: string, owner = 'julian', mtimeMs = NOW - 2 * HOUR): NoteRow {
  return { owner, path, title, size: 10, mtimeMs };
}

function overview(overrides: Partial<Overview> = {}, counts: Partial<Overview['counts']> = {}): Overview {
  return {
    counts: {
      notes: 118,
      orphans: 5,
      untagged: 10,
      deadLinks: 29,
      stale: 3,
      conflicts: 1,
      attention: 22,
      tagsInUse: true,
      ...counts,
    },
    recent: [note('10_Projects/ndBrain.md', 'ndBrain'), note('Inbox.md', 'Inbox')],
    tasks: [{ owner: 'julian', path: '10_Projects/ndBrain.md', line: 4, done: false, text: 'Ship home' }],
    tags: [{ tag: 'homelab', count: 29 }],
    activity: [
      { owner: 'julian', path: 'Inbox.md', title: 'Inbox', actor: 'julian', action: 'update', at: NOW - HOUR, edits: 3, deleted: false },
    ],
    ...overrides,
  };
}

function day(i: number, fields: Partial<ActivityDay> = {}): ActivityDay {
  const bounds = localDayBounds(NOW);
  return {
    start: bounds[i]!,
    end: bounds[i + 1]!,
    created: 0,
    edited: 0,
    deleted: 0,
    renamed: 0,
    touched: 0,
    agentReads: 0,
    agentWrites: 0,
    ...fields,
  };
}

function fourteen(today: Partial<ActivityDay> = {}, earlier: Partial<ActivityDay> = {}): ActivityDay[] {
  return Array.from({ length: 14 }, (_, i) => (i === 13 ? day(i, today) : day(i, earlier)));
}

function renderHome(props: Partial<Parameters<typeof HomeView>[0]> = {}, days: ActivityDay[] = fourteen()) {
  const spy = vi.spyOn(api, 'activityDays').mockResolvedValue({ days });
  const handlers = { onOpen: vi.fn(), onTasks: vi.fn(), onTidy: vi.fn(), onNetwork: vi.fn(), onOpenDay: vi.fn() };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <HomeView
        overview={overview()}
        self="julian"
        ownNotes={118}
        recents={[note('20_Areas/Homelab/Proxmox.md', 'Proxmox')]}
        hidePrefixes
        now={NOW}
        journalDays={new Set<string>()}
        {...handlers}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...handlers, spy };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('local day bounds', () => {
  it('are fifteen local midnights for fourteen days, ending tomorrow', () => {
    const bounds = localDayBounds(NOW);
    expect(bounds).toHaveLength(15);
    expect(bounds[13]).toBe(new Date(2026, 8, 17).getTime());
    expect(bounds[14]).toBe(new Date(2026, 8, 18).getTime());
    expect(bounds[0]).toBe(new Date(2026, 8, 4).getTime());
    for (const b of bounds) expect(new Date(b).getHours()).toBe(0);
  });

  it('asks the server with exactly those bounds', async () => {
    const { spy } = renderHome();
    await waitFor(() => expect(spy).toHaveBeenCalledWith(localDayBounds(NOW)));
  });
});

describe('continue', () => {
  it('lists recently opened and recently edited notes with folder and time, and opens them', async () => {
    const { onOpen } = renderHome();
    const section = screen.getByRole('region', { name: copy.home.continue });

    const opened = within(section).getByRole('button', { name: /Proxmox, in Areas › Homelab/ });
    expect(opened).toHaveTextContent('2 hours ago');
    await userEvent.click(opened);
    expect(onOpen).toHaveBeenCalledWith('julian', '20_Areas/Homelab/Proxmox.md');

    expect(within(section).getByRole('button', { name: /ndBrain, in Projects/ })).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: new RegExp(`Inbox, in ${copy.home.topLevel}`) })).toBeInTheDocument();
  });

  it('marks a note from a shared vault with its owner', () => {
    renderHome({ overview: overview({ recent: [note('Geteilt.md', 'Geteilt', 'ramona')] }) });
    const row = screen.getByRole('button', { name: /Geteilt, in/ });
    expect(within(row).getByText('ramona')).toBeInTheDocument();
  });
});

describe('your brain today', () => {
  it('shows what the server counted for today', async () => {
    renderHome({}, fourteen({ created: 2, edited: 5, touched: 7, agentReads: 12, agentWrites: 1 }));
    const section = screen.getByRole('region', { name: copy.home.today });
    await waitFor(() => expect(within(section).getByText(copy.home.newNotes(2))).toBeInTheDocument());
    const value = (label: string) => within(section).getByText(label).nextElementSibling?.textContent;
    expect(value(copy.home.newNotes(2))).toBe('2');
    expect(value(copy.home.editedNotes(5))).toBe('5');
    expect(value(copy.home.agentReads(12))).toBe('12');
    expect(value(copy.home.agentWrites(1))).toBe('1');
  });

  it('says a quiet day plainly, and draws no trace for fourteen empty days', async () => {
    renderHome({}, fourteen());
    await waitFor(() => expect(screen.getByText(copy.home.quietToday)).toBeInTheDocument());
    expect(screen.queryByRole('img', { name: /Notes changed per day/ })).toBeNull();
  });

  it('draws the trace as soon as one day has something in it', async () => {
    renderHome({}, fourteen({}, { touched: 3 }));
    await waitFor(() =>
      expect(screen.getByRole('img', { name: copy.home.traceLabel(39, 14) })).toBeInTheDocument(),
    );
  });

  it('shows no counts at all when the server did not answer — never zeros it made up', async () => {
    vi.spyOn(api, 'activityDays').mockRejectedValue(new Error('offline'));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <HomeView overview={overview()} self="julian" ownNotes={118} recents={[]} hidePrefixes now={NOW}
          onOpen={vi.fn()} onTasks={vi.fn()} onTidy={vi.fn()} onNetwork={vi.fn()}
          journalDays={new Set<string>()} onOpenDay={vi.fn()} />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(copy.home.quietToday)).toBeNull();
    expect(screen.queryByText(copy.home.newNotes(0))).toBeNull();
    // What the overview already had is still there.
    expect(screen.getByText(copy.home.sinceYesterday)).toBeInTheDocument();
  });

  it('keeps the since-yesterday list of the old overview', async () => {
    const { onOpen } = renderHome();
    const section = screen.getByRole('region', { name: copy.home.today });
    const row = within(section).getByRole('button', { name: /Inbox/ });
    expect(row).toHaveTextContent('3×');
    await userEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith('julian', 'Inbox.md');
  });
});

describe('the rest of the old overview', () => {
  it('keeps open tasks, with a way to all of them', async () => {
    const { onTasks, onOpen } = renderHome();
    const section = screen.getByRole('region', { name: copy.home.tasks });
    await userEvent.click(within(section).getByRole('button', { name: /Ship home/ }));
    expect(onOpen).toHaveBeenCalledWith('julian', '10_Projects/ndBrain.md');
    await userEvent.click(within(section).getByRole('button', { name: copy.overview.seeAllTasks }));
    expect(onTasks).toHaveBeenCalled();
  });

  it('keeps the tags', () => {
    renderHome();
    expect(screen.getByText('#homelab')).toBeInTheDocument();
  });

  it('offers the whole network as a button, not a running canvas', async () => {
    const { onNetwork } = renderHome();
    expect(document.querySelector('canvas')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: new RegExp(copy.home.openNetwork) }));
    expect(onNetwork).toHaveBeenCalled();
  });
});

describe('the health card', () => {
  it('shows the score and every finding, each opening its own list', async () => {
    const { onTidy } = renderHome();
    const card = screen.getByRole('region', { name: copy.health.title });
    expect(within(card).getByRole('img', { name: copy.health.scoreLabel(89) })).toBeInTheDocument();

    await userEvent.click(within(card).getByRole('button', { name: copy.health.showFinding(29, copy.health.broken(29)) }));
    expect(onTidy).toHaveBeenLastCalledWith('broken');
    await userEvent.click(within(card).getByRole('button', { name: copy.health.untouched(3) }));
    expect(onTidy).toHaveBeenLastCalledWith('stale');
    await userEvent.click(within(card).getByRole('button', { name: copy.health.open }));
    expect(onTidy).toHaveBeenLastCalledWith();
    expect(within(card).getByText(copy.health.attention(22))).toBeInTheDocument();
  });

  it('shows a finding with nothing in it as done, quietly, and not as a link', () => {
    renderHome({ overview: overview({}, { conflicts: 0 }) });
    const card = screen.getByRole('region', { name: copy.health.title });
    const done = within(card).getByRole('button', { name: `${copy.health.conflicts(0)}: ${copy.health.none}` });
    expect(done).toBeDisabled();
    expect(done).toHaveAttribute('data-empty', 'true');
  });

  it('divides by the own vault only, not by what is shared in', () => {
    // 118 visible, but only 59 are the caller's: the same findings weigh twice as much.
    renderHome({ ownNotes: 59 });
    const card = screen.getByRole('region', { name: copy.health.title });
    expect(within(card).getByRole('img', { name: copy.health.scoreLabel(79) })).toBeInTheDocument();
  });
});

describe('the trace on its own', () => {
  it('renders nothing for no activity', () => {
    const { container } = render(<Trace days={fourteen()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

/* ---- Tidy up ------------------------------------------------------------- */

function tidy(): Tidy {
  const row = (path: string, title: string) => ({ owner: 'julian', path, title, size: 1, mtimeMs: NOW - 400 * 24 * HOUR });
  return {
    orphans: [row('Lose.md', 'Lose')],
    untagged: [row('Ohne.md', 'Ohne')],
    deadLinks: [{ owner: 'julian', source: 'Quelle.md', targetRaw: 'Nirgends', targetPath: null, heading: null, alias: null, offset: 3 }],
    stale: [row('Alt.md', 'Alt')],
    conflicts: [],
    truncated: false,
    totals: { orphans: 1, untagged: 1, deadLinks: 1, stale: 1, conflicts: 0 },
  };
}

function renderTidy(props: Partial<Parameters<typeof TidyView>[0]> = {}, withHealth = true) {
  const handlers = { onToggle: vi.fn(), onToggleAll: vi.fn(), onOpen: vi.fn(), onBulk: vi.fn() };
  render(
    <TidyView
      data={tidy()}
      selected={new Set<string>()}
      busy={false}
      tags={[]}
      dirs={[]}
      {...(withHealth ? { health: { notes: 10, tagsInUse: true } } : {})}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

const bodyRows = () => screen.getAllByRole('row').slice(1);

describe('the health head of Tidy up', () => {
  it('shows the same score the home view would, with the arithmetic', () => {
    renderTidy();
    // 1 orphan, 1 broken, 1 untagged of 10 notes: 3 + 3 + 2 = 8 points.
    expect(screen.getByRole('img', { name: copy.health.scoreLabel(92) })).toBeInTheDocument();
    expect(screen.getByText(copy.health.how)).toBeInTheDocument();
  });

  it('narrows the table to one finding on click, and back', async () => {
    const { onToggleAll } = renderTidy();
    expect(bodyRows()).toHaveLength(4);

    await userEvent.click(screen.getByRole('button', { name: copy.health.showFinding(1, copy.health.broken(1)) }));
    expect(bodyRows()).toHaveLength(1);
    expect(bodyRows()[0]).toHaveTextContent('Nirgends');

    // Select-all reaches only what is shown.
    await userEvent.click(screen.getByRole('checkbox', { name: copy.tidy.selectAll }));
    expect(onToggleAll).toHaveBeenCalledWith(['Quelle.md']);

    await userEvent.click(screen.getByRole('button', { name: copy.health.showAll }));
    expect(bodyRows()).toHaveLength(4);
  });

  it('opens already narrowed when the home view asked for a finding', () => {
    renderTidy({ initialFocus: 'stale' });
    expect(bodyRows()).toHaveLength(1);
    expect(bodyRows()[0]).toHaveTextContent('Alt');
  });

  it('shows no head without the note count, as before', () => {
    renderTidy({}, false);
    expect(screen.queryByText(copy.health.title)).toBeNull();
  });
});
