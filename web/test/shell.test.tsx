/**
 * The frame around every view: sidebar, header, network switcher.
 *
 * What these pin down is what a restyle is most likely to lose without anybody
 * noticing on a screenshot:
 *
 *  - folded, every sidebar control still has a name — the label leaves the
 *    screen, not the accessibility tree
 *  - the open note stays in the recents and is marked, rather than vanishing
 *  - the folded state and the network view are remembered, and a stored value
 *    from somewhere else cannot put the app in a state it does not have
 *  - the header's search is a door to the one palette, not a second search
 *  - the switcher and the account menu work from the keyboard
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GraphData, NoteRow, User } from '../src/api';
import { App } from '../src/App';
import { copy } from '../src/copy';
import { MenuButton } from '../src/Menu';
import { NetworkFrame } from '../src/NetworkFrame';
import { DEFAULT_PREFS, loadPrefs, savePrefs } from '../src/prefs';
import { Sidebar, type SidebarProps } from '../src/Sidebar';
import { Topbar } from '../src/Topbar';
import { pushRecent, saveOpenFolders } from '../src/accountStorage';
import { savePositions } from '../src/brain/positions';

// The canvas has nothing to draw in jsdom; the frame is what is under test.
// Like the real one, it saves its arrangement as it unmounts.
vi.mock('../src/Brain', async () => {
  const { useEffect } = await import('react');
  const { savePositions } = await import('../src/brain/positions');
  return {
    Brain: (props: { remember?: { account: string; store: string } }) => {
      useEffect(() => {
        const where = props.remember;
        return () => {
          if (where !== undefined) savePositions(where, new Map([['julian Private/Secret plan.md', { x: 1, y: 2 }]]));
        };
      }, []);
      return <canvas className="brain" data-testid="brain" />;
    },
  };
});

// The whole shell, over a server that is a handful of functions. The editor and
// the context panel have their own tests and nothing to show here.
vi.mock('../src/Editor', () => ({ Editor: () => <div data-testid="editor" /> }));

// The view a shell starts in, forced for one test: a state no stored preference
// can produce, for checking what the shell does when it is in it anyway.
const forcedStart = vi.hoisted(() => ({ view: null as string | null }));
vi.mock('../src/prefs', async (original) => {
  const real = await original<typeof import('../src/prefs')>();
  return {
    ...real,
    loadPrefs: () => {
      const prefs = real.loadPrefs();
      return forcedStart.view === null ? prefs : { ...prefs, startView: forcedStart.view as typeof prefs.startView };
    },
  };
});
vi.mock('../src/Context', () => ({ ContextPanel: () => <div /> }));

const server = vi.hoisted(() => ({
  signedIn: null as User | null,
  /** Every account's notes; `Shared/` is shared with everybody. */
  notes: [] as NoteRow[],
  failOpen: false,
  /** When set, the graph answers only once this settles. */
  graphGate: null as Promise<void> | null,
  /** Vaults the tree names, with their kind; spaces' notes are visible to everybody. */
  owners: [] as Array<{ id: string; kind: 'person' | 'space'; displayName: string }>,
  /** Whether `Shared/` notes of other people open writable. */
  sharedWritable: false,
  /** Every admin call the shell made, by name. */
  adminCalls: [] as string[],
  /** What the file browser lists, and what the shell did to it. */
  files: [] as Array<{ owner: string; path: string; size: number; mtimeMs: number; isNote: boolean }>,
  dirs: [] as string[],
  /** One entry per upload, in the order the shell made them. */
  uploads: [] as string[],
  deletes: [] as string[],
  /** Names whose upload fails, so a partial failure can be checked. */
  uploadFails: [] as string[],
  /** When set, an upload only finishes once this resolves — for ordering. */
  uploadGate: null as Promise<void> | null,
  /** Rows the tidy view lists as orphans, which are selectable. */
  orphans: [] as NoteRow[],
  /** Every bulk request the shell made. */
  bulks: [] as Array<{ action: string; paths: string[]; dir?: string; tag?: string }>,
  /** What `deletePreview` answers, so the confirmation text can be checked. */
  preview: null as
    | { restorable: number; unsaved: number; notYours: number; unknown: number; history: 'none' | 'empty' | 'ready' | 'broken' }
    | null,
}));

vi.mock('../src/api', async (original) => {
  const real = await original<typeof import('../src/api')>();
  // What `request` does with a 401: tell the listeners, then fail — and, like
  // `request`, only after the call has returned, never inside it.
  const unauthenticated = async (): Promise<never> => {
    await Promise.resolve();
    real.reportUnauthenticated();
    throw new real.ApiError(401, 'unauthenticated', 'sign in first');
  };
  const isSpace = (owner: string): boolean => server.owners.some((o) => o.id === owner && o.kind === 'space');
  const seen = (): NoteRow[] =>
    server.notes.filter(
      (n) =>
        server.signedIn !== null && (n.owner === server.signedIn.id || n.path.startsWith('Shared/') || isSpace(n.owner)),
    );
  const fake: Record<string, (...args: never[]) => Promise<unknown>> = {
    me: async () => {
      if (server.signedIn === null) await unauthenticated();
      return { user: server.signedIn };
    },
    login: async (name: string) => {
      server.signedIn = { id: name, displayName: name, role: 'user' };
      return { user: server.signedIn };
    },
    logout: async () => {
      server.signedIn = null;
      return { ok: true };
    },
    tree: async () => {
      if (server.signedIn === null) await unauthenticated();
      return server.owners.length === 0 ? { notes: seen(), dirs: [] } : { notes: seen(), dirs: [], owners: server.owners };
    },
    adminSpaces: async () => {
      server.adminCalls.push('adminSpaces');
      return [{ id: 'familie', displayName: 'Familie', disabled: false, noteCount: 1, members: 2 }];
    },
    adminUsers: async () => {
      server.adminCalls.push('adminUsers');
      return { users: [] };
    },
    adminKeys: async () => {
      server.adminCalls.push('adminKeys');
      return { keys: [] };
    },
    spaceMembers: async () => {
      server.adminCalls.push('spaceMembers');
      return [];
    },
    tidy: async () => ({
      orphans: server.orphans,
      untagged: [],
      deadLinks: [],
      stale: [],
      conflicts: [],
      missing: [],
      emptyFolders: [],
      truncated: false,
      totals: {
        orphans: server.orphans.length,
        untagged: 0,
        deadLinks: 0,
        stale: 0,
        conflicts: 0,
        missing: 0,
        emptyFolders: 0,
      },
    }),
    deletePreview: async () =>
      server.preview ?? { restorable: 0, unsaved: 0, notYours: 0, unknown: 0, history: 'none' as const },
    bulk: async (_owner: string, action: string, paths: string[], extra: { dir?: string; tag?: string } = {}) => {
      server.bulks.push({ action, paths, ...extra });
      // `ok` holds the final paths, which a move changes; the shell only counts
      // them, so echoing the input is enough here.
      return { ok: paths, failed: [] };
    },
    shares: async () => ({ granted: [], received: [] }),
    tags: async () => ({ tags: [] }),
    pulse: async () => ({ events: [], now: 1 }),
    propKeys: async () => ({ props: [] }),
    graph: async () => {
      if (server.graphGate !== null) await server.graphGate;
      return graphOf();
    },
  };
  function graphOf() {
    return {
      nodes: seen().map((n) => ({
        owner: n.owner,
        path: n.path,
        title: n.title,
        folder: n.path.split('/').slice(0, -1).join('/'),
        links: 0,
        tags: [],
        updatedAt: 0,
      })),
      edges: [],
    };
  }
  Object.assign(fake, {
    quickFind: async () => ({ notes: seen() }),
    files: async () => ({ files: server.files, dirs: server.dirs, truncated: false }),
    uploadFile: async (_owner: string, path: string) => {
      server.uploads.push(path);
      if (server.uploadGate !== null) await server.uploadGate;
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (server.uploadFails.includes(name)) throw new real.ApiError(413, 'too_large', 'too large');
      return { path, size: 1 };
    },
    deleteFile: async (owner: string, path: string) => {
      server.deletes.push(path);
      server.files = server.files.filter((f) => f.path !== path);
      server.notes = server.notes.filter((n) => !(n.owner === owner && n.path === path));
      return {};
    },
    getNote: async (owner: string, path: string) => {
      const row = seen().find((n) => n.owner === owner && n.path === path);
      if (server.failOpen || row === undefined) throw new real.ApiError(404, 'not_found', 'gone');
      return {
        owner,
        canWrite: owner === server.signedIn?.id || (server.sharedWritable && path.startsWith('Shared/')),
        note: { path, title: row.title, content: '', size: 0, mtimeMs: 0 },
      };
    },
  });
  // Anything a test does not care about simply never answers.
  const api = new Proxy(fake, { get: (target, key: string) => target[key] ?? (() => new Promise(() => {})) });
  return { ...real, api };
});

function note(path: string): NoteRow {
  return { owner: 'julian', path, title: path.replace(/\.md$/, ''), size: 1, mtimeMs: 0 };
}

function renderSidebar(props: Partial<SidebarProps> = {}) {
  const handlers = {
    onToggleCollapsed: vi.fn(),
    onShowView: vi.fn(),
    onClose: vi.fn(),
    onFilter: vi.fn(),
    onJump: vi.fn(),
    onOpen: vi.fn(),
    onHealth: vi.fn(),
    onNewNote: vi.fn(),
    onNewFolder: vi.fn(),
    onSettings: vi.fn(),
    onToday: vi.fn(),
  };
  render(
    <Sidebar
      onTodayNote={false}
      name="Julian"
      view="brain"
      collapsed={false}
      filter=""
      recents={[note('Backup to Azure.md'), note('Migora.md')]}
      current={{ owner: 'julian', path: 'Backup to Azure.md' }}
      tree={<div data-testid="tree" />}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
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
});

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
  server.graphGate = null;
  server.owners = [];
  server.sharedWritable = false;
  server.adminCalls = [];
  forcedStart.view = null;
});

describe('the sidebar', () => {
  it('shows who it belongs to and marks the active view', () => {
    renderSidebar();
    expect(screen.getByText('Julian')).toBeInTheDocument();
    expect(screen.getByText(copy.nav.tagline)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.nav.network })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: copy.nav.overview })).toHaveAttribute('aria-current', 'false');
  });

  it('keeps the open note in the recents, marked with a point', () => {
    renderSidebar();
    const open = screen.getByRole('button', { name: /Backup to Azure/ });
    expect(open).toHaveAttribute('aria-current', 'true');
    expect(within(open).getByRole('img', { name: copy.nav.openNow })).toBeInTheDocument();
    const other = screen.getByRole('button', { name: 'Migora' });
    expect(other).toHaveAttribute('aria-current', 'false');
    expect(within(other).queryByRole('img')).toBeNull();
  });

  it('hides the recents while filtering', () => {
    renderSidebar({ filter: 'mig' });
    expect(screen.queryByText(copy.nav.recent)).toBeNull();
  });

  /**
   * The footer carried three counts — orphaned, untagged, broken links — as a
   * shortcut into Tidy up. They are gone: the owner does not want a running
   * tally of what is wrong with their vault under their folders, and Tidy up is
   * an entry in the navigation above, so nothing became unreachable.
   */
  it('keeps no tally of findings under the tree', () => {
    renderSidebar();
    expect(screen.queryByText(/orphaned|untagged|broken/i)).toBeNull();
    expect(document.querySelector('.nav-health')).toBeNull();
  });

  it('opens settings from the gear, and offers new note and new folder', async () => {
    const handlers = renderSidebar();
    await userEvent.click(screen.getByRole('button', { name: copy.nav.settings }));
    await userEvent.click(screen.getByRole('button', { name: copy.nav.newNote }));
    await userEvent.click(screen.getByRole('button', { name: copy.nav.newFolder }));
    expect(handlers.onSettings).toHaveBeenCalled();
    expect(handlers.onNewNote).toHaveBeenCalled();
    expect(handlers.onNewFolder).toHaveBeenCalled();
  });

  it('the ⌘K hint in the filter opens the palette', async () => {
    const { onJump } = renderSidebar();
    await userEvent.click(screen.getByRole('button', { name: copy.shell.searchLabel }));
    expect(onJump).toHaveBeenCalled();
  });

  it('folded, keeps every entry reachable by name and drops the tree', async () => {
    const { onShowView, onToggleCollapsed } = renderSidebar({ collapsed: true });
    for (const label of [copy.nav.overview, copy.nav.journal, copy.nav.network, copy.nav.tidy, copy.nav.search]) {
      const button = screen.getByRole('button', { name: label });
      expect(button).toHaveAttribute('title', label);
    }
    expect(screen.queryByTestId('tree')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: copy.nav.tidy }));
    expect(onShowView).toHaveBeenCalledWith('tidy');

    await userEvent.click(screen.getByRole('button', { name: copy.nav.expand }));
    expect(onToggleCollapsed).toHaveBeenCalled();
  });
});

describe('the stored shell preferences', () => {
  it('start unfolded, on the graph', () => {
    expect(loadPrefs().sidebarCollapsed).toBe(false);
    expect(loadPrefs().networkView).toBe('graph');
  });

  it('survive a reload', () => {
    savePrefs({ ...DEFAULT_PREFS, sidebarCollapsed: true, networkView: 'map' });
    const back = loadPrefs();
    expect(back.sidebarCollapsed).toBe(true);
    expect(back.networkView).toBe('map');
  });

  it('refuse values the app has no state for', () => {
    window.localStorage.setItem('ndbrain.prefs', JSON.stringify({ sidebarCollapsed: 'yes', networkView: 'globe' }));
    expect(loadPrefs().sidebarCollapsed).toBe(false);
    expect(loadPrefs().networkView).toBe('graph');
  });
});

describe('the header', () => {
  function renderTopbar(dark = true) {
    const handlers = { onMenu: vi.fn(), onSearch: vi.fn(), onToggleTheme: vi.fn(), settings: vi.fn(), signOut: vi.fn() };
    render(
      <Topbar
        title="Whole network"
        subtitle="118 notes · 323 connections"
        dark={dark}
        accountName="Julian"
        accountItems={[
          { key: 'settings', label: copy.nav.settings, onSelect: handlers.settings },
          { key: 'signout', label: copy.nav.signOut, onSelect: handlers.signOut },
        ]}
        onMenu={handlers.onMenu}
        onSearch={handlers.onSearch}
        onToggleTheme={handlers.onToggleTheme}
      />,
    );
    return handlers;
  }

  it('titles the view with its numbers', () => {
    renderTopbar();
    expect(screen.getByRole('heading', { level: 1, name: 'Whole network' })).toBeInTheDocument();
    expect(screen.getByText('118 notes · 323 connections')).toBeInTheDocument();
  });

  it('search is a door to the palette, not a field of its own', async () => {
    const { onSearch } = renderTopbar();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: copy.shell.searchLabel }));
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('names the theme button after what it will do', async () => {
    const { onToggleTheme } = renderTopbar(true);
    await userEvent.click(screen.getByRole('button', { name: copy.shell.lightTheme }));
    expect(onToggleTheme).toHaveBeenCalled();
  });
});

describe('the account menu', () => {
  it('opens onto its first entry, walks with the arrows, and closes on Escape', async () => {
    const pick = vi.fn();
    render(
      <MenuButton
        label="Account"
        icon={<span />}
        items={[
          { key: 'a', label: 'Settings', onSelect: vi.fn() },
          { key: 'b', label: 'Sharing', onSelect: pick },
          { key: 'c', label: 'Sign out', onSelect: vi.fn() },
        ]}
      />,
    );
    const button = screen.getByRole('button', { name: 'Account' });
    expect(button).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();

    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Sharing' })).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(button).toHaveFocus();

    await userEvent.click(button);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sharing' }));
    expect(pick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on a click elsewhere', async () => {
    render(
      <div>
        <MenuButton label="Account" icon={<span />} items={[{ key: 'a', label: 'Settings', onSelect: vi.fn() }]} />
        <p>outside</p>
      </div>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByText('outside'));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('the network frame', () => {
  const graph: GraphData = {
    nodes: [{ owner: 'julian', path: 'a.md', title: 'a', folder: '', links: 0, tags: [], updatedAt: 0 }],
    edges: [],
  };

  function renderFrame(view: 'graph' | 'list' | 'map') {
    const onView = vi.fn();
    render(<NetworkFrame graph={graph} events={[]} account="julian" view={view} onView={onView} onOpen={vi.fn()} />);
    return onView;
  }

  it('draws the brain in the graph view, with the switcher beside the canvas', () => {
    renderFrame('graph');
    const canvas = screen.getByTestId('brain');
    const group = screen.getByRole('radiogroup', { name: copy.shell.network.switcher });
    // Siblings in one container: that is how the renderer finds the controls
    // it must keep region names clear of (`brain/blocked.ts`).
    expect(canvas.parentElement).toBe(group.parentElement!.parentElement);
    expect(screen.getByRole('radio', { name: copy.shell.network.graph })).toHaveAttribute('aria-checked', 'true');
  });

  it('says in the legend how a point becomes an open note', () => {
    renderFrame('graph');
    expect(document.querySelector('.brainfoot')).toHaveTextContent(copy.network.doubleClick);
  });

  it('shows list and map in place of the brain', () => {
    renderFrame('list');
    expect(screen.queryByTestId('brain')).toBeNull();
    expect(screen.getByRole('radio', { name: copy.shell.network.list })).toHaveAttribute('aria-checked', 'true');
  });

  it('switches by click and by arrow key', async () => {
    const onView = renderFrame('graph');
    await userEvent.click(screen.getByRole('radio', { name: copy.shell.network.map }));
    expect(onView).toHaveBeenLastCalledWith('map');

    screen.getByRole('radio', { name: copy.shell.network.graph }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onView).toHaveBeenLastCalledWith('list');
    await userEvent.keyboard('{ArrowLeft}');
    expect(onView).toHaveBeenLastCalledWith('map');
  });

  it('goes full screen and back', async () => {
    renderFrame('graph');
    await userEvent.click(screen.getByRole('button', { name: copy.shell.network.fullscreen }));
    expect(screen.getByRole('button', { name: copy.shell.network.exitFullscreen })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: copy.shell.network.fullscreen })).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('the shell, signed in', () => {
  function row(owner: string, path: string): NoteRow {
    return { owner, path, title: path.split('/').pop()!.replace(/\.md$/, ''), size: 1, mtimeMs: 0 };
  }

  let client: QueryClient | null = null;

  function mount(user: User | null): void {
    server.signedIn = user;
    server.failOpen = false;
    server.notes = [row('anna', 'Shared/Salary review.md'), row('anna', 'Anna only.md'), row('julian', 'Julian only.md')];
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
  }

  async function signOut(): Promise<void> {
    await userEvent.click(await screen.findByRole('button', { name: copy.shell.account }));
    await userEvent.click(screen.getByRole('menuitem', { name: copy.nav.signOut }));
  }

  async function signIn(name: string): Promise<void> {
    await userEvent.type(await screen.findByLabelText(copy.login.name), name);
    await userEvent.type(screen.getByLabelText(copy.login.password), 'secret');
    await userEvent.click(screen.getByRole('button', { name: copy.login.signIn }));
    await screen.findByRole('button', { name: copy.shell.account });
  }

  async function openFromPalette(title: string): Promise<void> {
    await screen.findByRole('button', { name: copy.shell.account });
    await userEvent.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: copy.palette.label });
    await userEvent.click(await within(dialog).findByRole('option', { name: new RegExp(title) }));
    await screen.findByTestId('editor');
  }

  function recentTitles(): string[] {
    const heading = screen.queryByText(copy.nav.recent);
    if (heading === null) return [];
    return within(heading.parentElement!)
      .queryAllByRole('button')
      .map((b) => b.textContent ?? '');
  }

  /**
   * Measured on the built shell: around twenty tab stops sit in the sidebar
   * before the first one inside the content. A skip link is the one control
   * that makes that survivable, and it has to be the very first stop —
   * anywhere later and it is behind the thing it skips.
   */
  it('offers a skip link as the first tab stop, and it moves the focus into the content', async () => {
    mount({ id: 'julian', displayName: 'Julian', role: 'user' });
    await screen.findByRole('button', { name: copy.shell.account });

    document.body.focus();
    await userEvent.tab();

    const skip = screen.getByRole('link', { name: copy.shell.skipToContent });
    expect(document.activeElement).toBe(skip);

    // The focus lands on the content landmark itself, not merely the document
    // position: a skip link that scrolls and leaves the focus in the sidebar is
    // the failure this is here to catch, and it looks identical on a screenshot.
    await userEvent.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });

  it("keeps one account's recents from the next account on the same browser", async () => {
    // What an earlier build left behind, shared by every account.
    window.localStorage.setItem('ndbrain.recents', JSON.stringify([{ owner: 'anna', path: 'Anna only.md' }]));
    window.localStorage.setItem('ndbrain.openFolders', JSON.stringify(['julian Private']));

    mount({ id: 'julian', displayName: 'Julian', role: 'user' });
    await openFromPalette('Salary review');
    await waitFor(() => expect(recentTitles().join()).toMatch(/Salary review/));
    expect(window.localStorage.getItem('ndbrain.recents')).toBeNull();
    expect(window.localStorage.getItem('ndbrain.openFolders')).toBeNull();
    // Brain arrangements, as the network view leaves them.
    window.localStorage.setItem('ndbrain.brain.v4/julian/network', JSON.stringify({ 'anna/Shared/Salary review.md': [1, 2] }));
    window.localStorage.setItem('ndbrain.brain.v4/anna/network', JSON.stringify({ 'anna/Anna only.md': [1, 2] }));

    await signOut();
    await signIn('anna');
    // Anna's vault holds the note Julian read, and she still must not learn that he did.
    await screen.findAllByText('Anna only');
    expect(recentTitles()).toEqual([]);

    // Nothing Julian read is left for anyone to find in the storage either.
    const stored = Object.keys(window.localStorage)
      .map((key) => `${key}=${window.localStorage.getItem(key)}`)
      .join('\n');
    expect(stored).not.toMatch(/Salary review/);
    expect(stored).not.toMatch(/julian/i);
    // Anna's own arrangement is hers and stays.
    expect(window.localStorage.getItem('ndbrain.brain.v4/anna/network')).not.toBeNull();
  });

  it('gives each account its own recents when both come back', async () => {
    mount({ id: 'julian', displayName: 'Julian', role: 'user' });
    await openFromPalette('Julian only');
    await signOut();
    await signIn('anna');
    await openFromPalette('Anna only');
    await waitFor(() => expect(recentTitles().join()).toMatch(/Anna only/));
    expect(recentTitles().join()).not.toMatch(/Julian only/);
  });

  it('keeps Files in the account menu, right under Settings, not among the views', async () => {
    mount({ id: 'julian', displayName: 'Julian', role: 'user' });
    await userEvent.click(await screen.findByRole('button', { name: copy.shell.account }));
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items.indexOf(copy.nav.files)).toBe(items.indexOf(copy.nav.settings) + 1);
    const views = screen.getByRole('group', { name: copy.nav.view });
    expect(within(views).queryByRole('button', { name: copy.nav.files })).toBeNull();

    await userEvent.click(screen.getByRole('menuitem', { name: copy.nav.files }));
    expect(await screen.findByRole('heading', { level: 1, name: copy.nav.files })).toBeInTheDocument();
  });

  it('offers no admin entry to an account that is not an administrator', async () => {
    mount({ id: 'julian', displayName: 'Julian', role: 'user' });
    await userEvent.click(await screen.findByRole('button', { name: copy.shell.account }));
    expect(screen.getByRole('menuitem', { name: copy.nav.signOut })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: copy.nav.admin })).toBeNull();
  });

  it('goes from home to the network without a loading line in between', async () => {
    mount({ id: 'julian', displayName: 'Julian', role: 'user' });
    await screen.findByRole('button', { name: copy.shell.account });
    const seen: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) seen.push(node.textContent ?? '');
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    await userEvent.click(screen.getByRole('button', { name: copy.nav.network }));
    await screen.findByTestId('brain');
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.disconnect();

    expect(seen.some((text) => text.includes(copy.overview.loadingGraph))).toBe(false);
  });

  it('says at once that the network is on its way while the graph is slow', async () => {
    let open: () => void = () => {};
    server.graphGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    mount({ id: 'julian', displayName: 'Julian', role: 'user' });
    const entry = await screen.findByRole('button', { name: copy.nav.network });

    await userEvent.click(entry);
    expect(entry).toHaveAttribute('aria-busy', 'true');
    expect(entry).toHaveAttribute('aria-current', 'false');
    expect(document.querySelector('.app')).toHaveAttribute('data-busy', 'true');
    expect(screen.queryByTestId('brain')).toBeNull();

    open();
    await screen.findByTestId('brain');
    expect(entry).not.toHaveAttribute('aria-busy');
    expect(entry).toHaveAttribute('aria-current', 'true');
    expect(document.querySelector('.app')).toHaveAttribute('data-busy', 'false');
    server.graphGate = null;
  });

  it('never draws or asks for the spaces administration for an account that is not an administrator', async () => {
    mount({ id: 'julian', displayName: 'Julian', role: 'user' });
    await userEvent.click(await screen.findByRole('button', { name: copy.shell.account }));
    // Should the entry ever be drawn by mistake, following it must still show nothing.
    const entry = screen.queryByRole('menuitem', { name: copy.nav.admin });
    await userEvent.click(entry ?? screen.getByRole('menuitem', { name: copy.nav.settings }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('region', { name: copy.spaces.title })).toBeNull();
    expect(screen.queryByLabelText(copy.spaces.accountName)).toBeNull();
    expect(server.adminCalls).toEqual([]);
  });

  it('draws nothing of the administration for an account that is not an administrator, even in its view', async () => {
    // However the shell came to be on the admin view — an account demoted while
    // the page was open, a state restored from somewhere — the role decides.
    forcedStart.view = 'admin';
    mount({ id: 'julian', displayName: 'Julian', role: 'user' });
    await screen.findByRole('button', { name: copy.shell.account });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByRole('heading', { name: copy.admin.accounts })).toBeNull();
    expect(screen.queryByRole('region', { name: copy.spaces.title })).toBeNull();
    expect(server.adminCalls).toEqual([]);
  });

  it('shows an administrator the spaces in the administration', async () => {
    mount({ id: 'julian', displayName: 'Julian', role: 'admin' });
    await userEvent.click(await screen.findByRole('button', { name: copy.shell.account }));
    await userEvent.click(screen.getByRole('menuitem', { name: copy.nav.admin }));
    const section = await screen.findByRole('region', { name: copy.spaces.title });
    expect(await within(section).findByText('Familie')).toBeInTheDocument();
    expect(server.adminCalls).toContain('adminSpaces');
  });

  it('offers “Share…” among the note actions of your own note, and opens the dialog', async () => {
    mount({ id: 'julian', displayName: 'Julian', role: 'user' });
    await openFromPalette('Julian only');
    await userEvent.click(screen.getByRole('button', { name: copy.note.actions }));
    expect(screen.getByRole('menuitem', { name: copy.note.delete })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: copy.shareNote.menu }));
    expect(await screen.findByRole('dialog', { name: copy.shareNote.title('Julian only') })).toBeInTheDocument();
  });

  it('offers no “Share…” on somebody else’s note, even one you may write', async () => {
    server.sharedWritable = true;
    mount({ id: 'julian', displayName: 'Julian', role: 'admin' });
    await openFromPalette('Salary review');
    await userEvent.click(screen.getByRole('button', { name: copy.note.actions }));
    expect(screen.getByRole('menuitem', { name: copy.note.delete })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: copy.shareNote.menu })).toBeNull();
    // Nor in the tree beside it.
    expect(screen.queryByRole('button', { name: copy.tree.shareNoteLabel('Salary review') })).toBeNull();
  });

  describe('with a space', () => {
    function withSpace(): void {
      server.owners = [
        { id: 'julian', kind: 'person', displayName: 'Julian' },
        { id: 'familie', kind: 'space', displayName: 'Familie' },
      ];
    }

    async function mountWithSpace(role: 'user' | 'admin'): Promise<void> {
      withSpace();
      mount({ id: 'julian', displayName: 'Julian', role });
      server.notes.push(row('familie', 'Ferien.md'));
      await client!.invalidateQueries();
    }

    it('says whose note is open by the space’s name, and that it is read only', async () => {
      await mountWithSpace('user');
      await openFromPalette('Ferien');
      expect(await screen.findByText(`Familie · ${copy.note.readOnly}`)).toBeInTheDocument();
      // A read-only space note has nothing to offer a member who is no administrator.
      expect(screen.queryByRole('button', { name: copy.note.actions })).toBeNull();
    });

    it('draws the space as its own root in the tree, under its display name', async () => {
      await mountWithSpace('user');
      const heading = await screen.findByRole('heading', { name: /^Familie/ });
      expect(heading.closest('section')).toHaveAttribute('data-kind', 'space');
    });

    it('lets an administrator share a note of the space, through its members', async () => {
      await mountWithSpace('admin');
      await openFromPalette('Ferien');
      await userEvent.click(screen.getByRole('button', { name: copy.note.actions }));
      expect(screen.queryByRole('menuitem', { name: copy.note.delete })).toBeNull();
      await userEvent.click(screen.getByRole('menuitem', { name: copy.shareNote.menu }));
      const dialog = await screen.findByRole('dialog', { name: copy.shareNote.title('Ferien') });
      expect(within(dialog).getByText(copy.shareNote.inSpace('Familie'), { exact: false })).toBeInTheDocument();
      await waitFor(() => expect(server.adminCalls).toContain('spaceMembers'));
    });
  });

  it('offers the admin entry to an administrator', async () => {
    mount({ id: 'julian', displayName: 'Julian', role: 'admin' });
    await userEvent.click(await screen.findByRole('button', { name: copy.shell.account }));
    expect(screen.getByRole('menuitem', { name: copy.nav.admin })).toBeInTheDocument();
  });

  async function fullScreenList(): Promise<HTMLElement> {
    window.localStorage.setItem('ndbrain.prefs', JSON.stringify({ networkView: 'list' }));
    mount({ id: 'julian', displayName: 'Julian', role: 'user' });
    await userEvent.click(await screen.findByRole('button', { name: copy.nav.network }));
    await userEvent.click(await screen.findByRole('button', { name: copy.shell.network.fullscreen }));
    const frame = document.querySelector<HTMLElement>('.netframe')!;
    expect(frame).toHaveAttribute('data-full', 'true');
    return frame;
  }

  it('⌘K leaves full screen before the palette opens, so the palette is seen', async () => {
    await fullScreenList();
    await userEvent.keyboard('{Meta>}k{/Meta}');
    expect(await screen.findByRole('dialog', { name: copy.palette.label })).toBeInTheDocument();
    expect(document.querySelector('.netframe')).toHaveAttribute('data-full', 'false');
  });

  it('draws a message raised in full screen inside the full-screen frame', async () => {
    const frame = await fullScreenList();
    server.failOpen = true;
    const cell = await within(frame).findByText('Julian only');
    await act(async () => {
      fireEvent.click(cell);
    });
    // The drawn one: the same words also sit in the live region that stays in
    // the main column, which is how they get announced at all.
    const message = await screen.findByText(copy.errors.noteGone, { selector: '.floaterror span' });
    expect(frame).toContainElement(message);
  });

  /** Everything in the storage, as one string to search. */
  function stored(): string {
    return Object.keys(window.localStorage)
      .map((key) => `${key}=${window.localStorage.getItem(key)}`)
      .join('\n');
  }

  async function onTheNetwork(): Promise<void> {
    mount({ id: 'julian', displayName: 'Julian', role: 'user' });
    await userEvent.click(await screen.findByRole('button', { name: copy.nav.network }));
    await screen.findByTestId('brain');
  }

  it('forgets the brain arrangement even though the brain saves it as it unmounts', async () => {
    await onTheNetwork();
    await signOut();
    await screen.findByLabelText(copy.login.name);
    expect(stored()).not.toMatch(/Secret plan/);
    expect(stored()).not.toMatch(/julian/i);
  });

  it('ends the session when the server says it is gone, and forgets the account', async () => {
    await onTheNetwork();
    await openFromPalette('Julian only');
    expect(stored()).toMatch(/Julian only/);

    // The session expires on the server; the next request finds out.
    server.signedIn = null;
    await act(async () => {
      await client?.invalidateQueries();
    });

    expect(await screen.findByLabelText(copy.login.name)).toBeInTheDocument();
    expect(screen.queryByText('Julian only')).toBeNull();
    expect(stored()).not.toMatch(/julian/i);
  });

  it('does not treat the login page asking who is signed in as a session ending', async () => {
    const prior = JSON.stringify([{ owner: 'x', path: 'y.md' }]);
    window.localStorage.setItem('ndbrain.recents.anna', prior);
    mount(null);
    expect(await screen.findByLabelText(copy.login.name)).toBeInTheDocument();
    // Nothing was forgotten, because nobody was signed in to forget.
    expect(window.localStorage.getItem('ndbrain.recents.anna')).toBe(prior);
  });

  it('follows a sign-out in another tab, and writes nothing for the old account afterwards', async () => {
    await onTheNetwork();
    await openFromPalette('Julian only');

    // Tab 2 signs out; this tab hears it through the storage event.
    server.signedIn = null;
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'ndbrain.session', newValue: String(Date.now()) }));
    });
    expect(await screen.findByLabelText(copy.login.name)).toBeInTheDocument();
    expect(stored()).not.toMatch(/julian/i);

    // Anything still holding the old account cannot write its entries back.
    pushRecent('julian', 'julian', 'Julian only.md');
    saveOpenFolders('julian', new Set(['julian Private']));
    savePositions({ account: 'julian', store: 'network' }, new Map([['a', { x: 1, y: 1 }]]));
    expect(stored()).not.toMatch(/julian/i);
  });

  it('switches to the account another tab signed in as', async () => {
    await onTheNetwork();
    await openFromPalette('Julian only');
    server.signedIn = { id: 'anna', displayName: 'anna', role: 'user' };
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'ndbrain.session', newValue: String(Date.now()) }));
    });
    await waitFor(() => expect(screen.getAllByText('anna').length).toBeGreaterThan(0));
    expect(recentTitles()).toEqual([]);
    expect(stored()).not.toMatch(/julian/i);
  });

  it('on the sign-in page, follows a sign-in in another tab', async () => {
    mount(null);
    await screen.findByLabelText(copy.login.name);
    server.signedIn = { id: 'anna', displayName: 'anna', role: 'user' };
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'ndbrain.session', newValue: String(Date.now()) }));
    });
    expect(await screen.findByRole('button', { name: copy.shell.account })).toBeInTheDocument();
    expect(screen.getAllByText('anna').length).toBeGreaterThan(0);
  });
});

/**
 * What the shell does to a file, as opposed to what the browser offers.
 *
 * `FilesView` has twenty tests and every one of them hands it a `vi.fn()`: they
 * check that a click reaches a callback, never what the callback then does. The
 * three handlers in `Shell` had no test at all — `api.uploadFile` and
 * `api.deleteFile` appeared nowhere in the suite — and they are where the
 * interesting decisions are: uploads run one at a time, a partial failure is
 * reported rather than swallowed, and a deleted file that happens to be the open
 * note has to take the editor with it.
 */
describe('the shell acting on files', () => {
  function fileRow(path: string, isNote = path.endsWith('.md')) {
    return { owner: 'julian', path, size: 10, mtimeMs: 0, isNote };
  }

  let client: QueryClient | null = null;

  async function openFiles(): Promise<void> {
    server.signedIn = { id: 'julian', displayName: 'Julian', role: 'user' };
    server.failOpen = false;
    server.notes = [note('Willkommen.md')];
    server.files = [fileRow('Willkommen.md'), fileRow('rack.png')];
    server.dirs = [];
    server.uploads = [];
    server.deletes = [];
    server.uploadFails = [];
    server.uploadGate = null;
    server.orphans = [];
    server.bulks = [];
    server.preview = null;
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
    await screen.findByRole('button', { name: copy.shell.account });
    await userEvent.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: copy.palette.label });
    await userEvent.click(await within(dialog).findByRole('option', { name: new RegExp(copy.nav.files) }));
  }

  afterEach(() => {
    client?.clear();
    client = null;
  });

  /** The hidden multi-file input behind “Import files…”. */
  function importInput(): HTMLInputElement {
    const input = document.querySelector<HTMLInputElement>('input[type="file"][multiple]');
    if (input === null) throw new Error('no import input on screen');
    return input;
  }

  it('lists what the vault holds', async () => {
    await openFiles();
    expect(await screen.findByText('rack.png')).toBeInTheDocument();
  });

  it('uploads one file at a time rather than firing them all at once', async () => {
    await openFiles();
    await screen.findByText('rack.png');

    let release = (): void => {};
    server.uploadGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await userEvent.upload(importInput(), [
      new File(['a'], 'eins.md', { type: 'text/markdown' }),
      new File(['b'], 'zwei.md', { type: 'text/markdown' }),
    ]);

    // The first is in flight and the second has not been sent. A vault import
    // can be hundreds of files, and firing them together buys nothing on a
    // single-user server while making one failure indistinguishable from the
    // rest.
    expect(server.uploads).toEqual(['eins.md']);

    release();
    await waitFor(() => expect(server.uploads).toEqual(['eins.md', 'zwei.md']));
  });

  it('reports a partial failure instead of finishing quietly', async () => {
    await openFiles();
    await screen.findByText('rack.png');
    server.uploadFails = ['zwei.md'];

    await userEvent.upload(importInput(), [
      new File(['a'], 'eins.md', { type: 'text/markdown' }),
      new File(['b'], 'zwei.md', { type: 'text/markdown' }),
    ]);

    // Both were attempted — one bad file does not end the import — and the one
    // that failed is named, because "could not import 1" of two hundred is not
    // something anybody can act on.
    await waitFor(() => expect(server.uploads).toEqual(['eins.md', 'zwei.md']));

    // Twice on purpose, and worth pinning: once where it can be read and once in
    // the live region, so somebody on a screen reader is told an import failed
    // rather than left with a list that silently lacks a file.
    const said = await screen.findAllByText(new RegExp(copy.errors.importFailed(1, 'zwei.md')));
    expect(said).toHaveLength(2);
    expect(said.some((node) => node.closest('[role="status"]') !== null)).toBe(true);
  });

  it('asks before deleting a file and does nothing when the answer is no', async () => {
    await openFiles();
    await screen.findByText('rack.png');
    const asked = vi.spyOn(window, 'confirm').mockReturnValue(false);

    const row = screen.getByText('rack.png').closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: copy.files.delete }));

    expect(asked).toHaveBeenCalledWith(copy.ask.deleteFile('rack.png'));
    expect(server.deletes).toEqual([]);
  });

  /**
   * Not tested here, and the reason is worth writing down.
   *
   * `removeFile` ends with "the open note may be the one just deleted" and calls
   * `setOpenRef(null)`. That effect cannot be observed from the file view at all:
   * the editor is not rendered there either way, and the sidebar's `aria-current`
   * hangs off `view === 'note' && open !== null`, so it is already absent.
   *
   * A first attempt at this test passed with the line removed — it was measuring
   * the navigation, not the handler. Rather than contrive an observation, the
   * promise is left to a test on the hook once this state moves out of `Shell`,
   * where the open reference is an input and an output rather than a detail.
   */
});

/**
 * The bulk bar, which acts on a selection the tidy view made.
 *
 * `api.bulk` appeared nowhere in the suite, so none of this was covered: not the
 * questions it asks before acting, not the preview that tells somebody what a
 * delete will break, and not that a cancelled question leaves the vault alone.
 * `Views.tsx` has its own tests and they stop at the callback, as the file
 * browser's did.
 */
describe('acting on a selection', () => {
  function row(path: string): NoteRow {
    return { owner: 'julian', path, title: path.replace(/\.md$/, ''), size: 1, mtimeMs: 0 };
  }

  let client: QueryClient | null = null;

  /** Signs in, opens Tidy up, and selects the one orphan listed. */
  async function selectOrphan(): Promise<void> {
    server.signedIn = { id: 'julian', displayName: 'Julian', role: 'user' };
    server.failOpen = false;
    server.notes = [row('Verwaist.md')];
    server.orphans = [row('Verwaist.md')];
    server.bulks = [];
    server.preview = null;
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
    await screen.findByRole('button', { name: copy.shell.account });
    // Straight through the sidebar: the palette only offers its commands once
    // something is typed, and this test is not about the palette.
    await userEvent.click(screen.getByRole('button', { name: copy.nav.tidy }));

    // The title shows up in the tree as well, so the row is found by being a
    // table row that carries a checkbox — which only the selectable findings do.
    const cells = await screen.findAllByText('Verwaist');
    const line = cells.map((node) => node.closest('tr')).find((tr) => tr?.querySelector('input[type="checkbox"]'));
    if (line === undefined || line === null) throw new Error('no selectable row for the orphan');
    await userEvent.click(within(line).getByRole('checkbox'));
  }

  afterEach(() => {
    client?.clear();
    client = null;
  });

  /**
   * The question is a dialog now, not a `window.prompt`.
   *
   * Which changes what can be checked and what had to be: a prompt could only
   * hand back a string, so the folder was typed from memory against a default
   * named `Archive` whether or not one existed, and a typo made a second folder
   * rather than being refused.
   */
  it('asks where to move the selection, and moves nothing when the question is closed', async () => {
    await selectOrphan();

    await userEvent.click(screen.getByRole('button', { name: new RegExp(copy.tidy.move) }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(copy.bulk.moveTitle(1))).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: copy.bulk.close }));
    expect(server.bulks).toEqual([]);
  });

  /**
   * A folder that does not exist yet is the move's own feature — it is made by
   * the move — so the destination stays a field with suggestions rather than
   * becoming a picker, which would have taken that away.
   */
  it('passes a destination that does not exist yet', async () => {
    await selectOrphan();
    await userEvent.click(screen.getByRole('button', { name: new RegExp(copy.tidy.move) }));
    const dialog = await screen.findByRole('dialog');

    await userEvent.type(within(dialog).getByLabelText(copy.bulk.folder), 'Archiv/2026');
    await userEvent.click(within(dialog).getByRole('button', { name: copy.bulk.move }));

    await waitFor(() =>
      expect(server.bulks).toEqual([{ action: 'move', paths: ['Verwaist.md'], dir: 'Archiv/2026' }]),
    );
  });

  it('moves to the top of the vault on an empty destination', async () => {
    await selectOrphan();
    await userEvent.click(screen.getByRole('button', { name: new RegExp(copy.tidy.move) }));
    const dialog = await screen.findByRole('dialog');

    await userEvent.click(within(dialog).getByRole('button', { name: copy.bulk.move }));

    await waitFor(() => expect(server.bulks).toEqual([{ action: 'move', paths: ['Verwaist.md'], dir: '' }]));
  });

  it('refuses a destination that steps upwards, before anything is sent', async () => {
    await selectOrphan();
    await userEvent.click(screen.getByRole('button', { name: new RegExp(copy.tidy.move) }));
    const dialog = await screen.findByRole('dialog');

    await userEvent.type(within(dialog).getByLabelText(copy.bulk.folder), '../anderswo');

    expect(within(dialog).getByRole('alert')).toHaveTextContent(copy.bulk.upward);
    expect(within(dialog).getByRole('button', { name: copy.bulk.move })).toBeDisabled();
    expect(server.bulks).toEqual([]);
  });

  it('refuses a tag nothing would ever find, and says why', async () => {
    await selectOrphan();
    await userEvent.click(screen.getByRole('button', { name: new RegExp(copy.tidy.tag) }));
    const dialog = await screen.findByRole('dialog');

    // Starts with a digit, so `markdown/parse.ts` would never read it back —
    // and the notes would be written all the same, which is what a prompt did.
    await userEvent.type(within(dialog).getByLabelText(copy.bulk.tag), '2026');
    expect(within(dialog).getByRole('alert')).toHaveTextContent(copy.bulk.tagShape);
    expect(within(dialog).getByRole('button', { name: copy.bulk.apply })).toBeDisabled();
    expect(server.bulks).toEqual([]);
  });

  it('treats a tag of nothing but spaces as no answer at all', async () => {
    await selectOrphan();
    await userEvent.click(screen.getByRole('button', { name: new RegExp(copy.tidy.tag) }));
    const dialog = await screen.findByRole('dialog');

    // Not the same as cancelling, and it used to be: a tag of blanks would pass
    // the null check, be trimmed away downstream, and report success for a no-op.
    await userEvent.type(within(dialog).getByLabelText(copy.bulk.tag), '   ');

    expect(within(dialog).getByRole('button', { name: copy.bulk.apply })).toBeDisabled();
    expect(server.bulks).toEqual([]);
  });

  it('sends a tag without the hash, however it was typed', async () => {
    await selectOrphan();
    await userEvent.click(screen.getByRole('button', { name: new RegExp(copy.tidy.tag) }));
    const dialog = await screen.findByRole('dialog');

    await userEvent.type(within(dialog).getByLabelText(copy.bulk.tag), '#homelab');
    await userEvent.click(within(dialog).getByRole('button', { name: copy.bulk.apply }));

    await waitFor(() =>
      expect(server.bulks).toEqual([{ action: 'tag', paths: ['Verwaist.md'], tag: 'homelab' }]),
    );
  });

  /**
   * The delete asks with the damage in the question.
   *
   * A selection of orphans is the case where this matters least and is easiest to
   * get wrong: the preview is what turns "delete 1 note?" into a sentence that
   * says what else stops working.
   */
  it('shows what a delete will break before it asks', async () => {
    await selectOrphan();
    // One note that can be brought back, which is what makes the sentence worth
    // putting in front of somebody.
    server.preview = { restorable: 1, unsaved: 0, notYours: 0, unknown: 0, history: 'ready' as const };
    const asked = vi.spyOn(window, 'confirm').mockReturnValue(false);

    await userEvent.click(screen.getByRole('button', { name: new RegExp(copy.tidy.delete) }));

    await waitFor(() => expect(asked).toHaveBeenCalled());
    const question = asked.mock.calls[0]?.[0] ?? '';
    expect(question).toContain(copy.ask.deleteNotes(1));
    expect(question).toContain(
      copy.ask.afterDelete({ restorable: 1, unsaved: 0, notYours: 0, unknown: 0, history: 'ready' }),
    );
    expect(server.bulks).toEqual([]);
  });
});
