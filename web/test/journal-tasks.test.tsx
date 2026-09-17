/**
 * Tasks live in the journal, beside the calendar.
 *
 * What is pinned here is the move, not the task list itself (that has its own
 * test in `tasks.test.tsx`):
 *
 *  - the journal shows the calendar and the open tasks together, and a task
 *    ticked there reaches the server as the exact task it was
 *  - there is no Tasks entry left in the navigation
 *  - every old way to the task list (the home card, a remembered start view)
 *    arrives in the journal instead of nowhere
 *  - the task list is only asked for while the journal is on screen
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NoteRow, TaskRow, User } from '../src/api';
import { App } from '../src/App';
import { copy } from '../src/copy';
import { DEFAULT_PREFS, loadPrefs } from '../src/prefs';

vi.mock('../src/Brain', () => ({ Brain: () => <canvas data-testid="brain" /> }));
vi.mock('../src/Editor', () => ({ Editor: () => <div data-testid="editor" /> }));
vi.mock('../src/Context', () => ({ ContextPanel: () => <div /> }));

const server = vi.hoisted(() => ({
  signedIn: null as User | null,
  notes: [] as NoteRow[],
  tasks: [] as TaskRow[],
  taskCalls: 0,
  toggles: [] as Array<{ owner: string; task: TaskRow; done: boolean }>,
}));

vi.mock('../src/api', async (original) => {
  const real = await original<typeof import('../src/api')>();
  const fake: Record<string, (...args: never[]) => Promise<unknown>> = {
    me: async () => ({ user: server.signedIn }),
    tree: async () => ({ notes: server.notes, dirs: [] }),
    shares: async () => ({ granted: [], received: [] }),
    tags: async () => ({ tags: [] }),
    pulse: async () => ({ events: [], now: 1 }),
    propKeys: async () => ({ props: [] }),
    quickFind: async () => ({ notes: [] }),
    overview: async () => ({
      counts: { notes: 1, orphans: 0, untagged: 0, deadLinks: 0, stale: 0, conflicts: 0, attention: 0, tagsInUse: false },
      recent: [],
      tasks: server.tasks,
      tags: [],
      activity: [],
    }),
    tasks: async () => {
      server.taskCalls += 1;
      return { tasks: server.tasks, total: server.tasks.filter((t) => !t.done).length, truncated: false };
    },
    toggleTask: async (owner: string, task: TaskRow, done: boolean) => {
      server.toggles.push({ owner, task, done });
      server.tasks = server.tasks.map((t) => (t.path === task.path && t.line === task.line ? { ...t, done } : t));
      return { ok: true };
    },
  };
  const api = new Proxy(fake, { get: (target, name: string) => target[name] ?? (() => new Promise(() => {})) });
  return { ...real, api };
});

const JULIAN: User = { id: 'julian', displayName: 'Julian', role: 'user' };

function mount(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
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
  server.notes = [{ owner: 'julian', path: 'Homelab/Proxmox.md', title: 'Proxmox', size: 1, mtimeMs: 1 }];
  server.tasks = [{ owner: 'julian', path: 'Homelab/Proxmox.md', line: 6, done: false, text: 'RAM prüfen' }];
  server.taskCalls = 0;
  server.toggles = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

async function toJournal(): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: copy.nav.journal }));
  await screen.findByRole('grid');
}

describe('the journal', () => {
  it('shows the calendar and the open tasks side by side', async () => {
    mount();
    await toJournal();
    const tasks = await screen.findByRole('region', { name: copy.tasks.title });
    expect(within(tasks).getByText('RAM prüfen')).toBeInTheDocument();
    // Calendar first, tasks after it: the order a narrow screen stacks them in.
    const layout = tasks.parentElement!;
    expect(layout).toHaveClass('journal-layout');
    expect(layout.firstElementChild).toContainElement(screen.getByRole('grid'));
  });

  it('ticks a task off in place, as the exact task it was', async () => {
    mount();
    await toJournal();
    await userEvent.click(await screen.findByRole('checkbox', { name: copy.tasks.check('RAM prüfen') }));
    await waitFor(() => expect(server.toggles).toHaveLength(1));
    expect(server.toggles[0]).toEqual({
      owner: 'julian',
      task: { owner: 'julian', path: 'Homelab/Proxmox.md', line: 6, done: false, text: 'RAM prüfen' },
      done: true,
    });
  });

  it('asks for the tasks only once the journal is open', async () => {
    mount();
    await screen.findByRole('button', { name: copy.nav.journal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.taskCalls).toBe(0);
    await toJournal();
    await waitFor(() => expect(server.taskCalls).toBeGreaterThan(0));
  });
});

describe('the ways that led to the task list', () => {
  it('are gone from the navigation', async () => {
    mount();
    const views = await screen.findByRole('group', { name: copy.nav.view });
    expect(within(views).getByRole('button', { name: copy.nav.journal })).toBeInTheDocument();
    expect(within(views).queryByRole('button', { name: copy.nav.tasks })).toBeNull();
  });

  it('lead from the home card into the journal', async () => {
    mount();
    await userEvent.click(await screen.findByRole('button', { name: copy.overview.seeAllTasks }));
    expect(await screen.findByRole('grid')).toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: copy.tasks.check('RAM prüfen') })).toBeInTheDocument();
  });

  it('turn a remembered start on the task list into a start in the journal', async () => {
    window.localStorage.setItem('ndbrain.prefs', JSON.stringify({ ...DEFAULT_PREFS, startView: 'tasks' }));
    expect(loadPrefs().startView).toBe('journal');
    mount();
    expect(await screen.findByRole('grid')).toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: copy.tasks.check('RAM prüfen') })).toBeInTheDocument();
  });

  it('still refuse a start view that never existed', () => {
    window.localStorage.setItem('ndbrain.prefs', JSON.stringify({ ...DEFAULT_PREFS, startView: 'calendar' }));
    expect(loadPrefs().startView).toBe(DEFAULT_PREFS.startView);
  });
});
