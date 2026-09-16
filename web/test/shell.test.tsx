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

import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GraphData, NoteRow } from '../src/api';
import { copy } from '../src/copy';
import { MenuButton } from '../src/Menu';
import { NetworkFrame } from '../src/NetworkFrame';
import { DEFAULT_PREFS, loadPrefs, savePrefs } from '../src/prefs';
import { Sidebar, type SidebarProps } from '../src/Sidebar';
import { Topbar } from '../src/Topbar';

// The canvas has nothing to draw in jsdom; the frame is what is under test.
vi.mock('../src/Brain', () => ({
  Brain: () => <canvas className="brain" data-testid="brain" />,
}));

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
  };
  render(
    <Sidebar
      name="Julian"
      view="brain"
      collapsed={false}
      filter=""
      recents={[note('Backup to Azure.md'), note('Migora.md')]}
      current={{ owner: 'julian', path: 'Backup to Azure.md' }}
      tree={<div data-testid="tree" />}
      health={{ orphans: 13, untagged: 7, broken: 21 }}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
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

  it('names the health counts in full and sends them to tidy', async () => {
    const { onHealth } = renderSidebar();
    await userEvent.click(screen.getByRole('button', { name: copy.nav.brokenCount(21) }));
    expect(screen.getByRole('button', { name: copy.nav.orphanedCount(13) })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.nav.untaggedCount(7) })).toBeInTheDocument();
    expect(onHealth).toHaveBeenCalledTimes(1);
  });

  it('withholds the untagged count where nothing is tagged', () => {
    renderSidebar({ health: { orphans: 1, untagged: null, broken: 0 } });
    expect(screen.queryByRole('button', { name: /untagged/ })).toBeNull();
    expect(screen.getByRole('button', { name: copy.nav.brokenCount(0) })).toBeInTheDocument();
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
    for (const label of [copy.nav.overview, copy.nav.network, copy.nav.tidy, copy.nav.tasks, copy.nav.search, copy.nav.files]) {
      const button = screen.getByRole('button', { name: label });
      expect(button).toHaveAttribute('title', label);
    }
    expect(screen.queryByTestId('tree')).toBeNull();
    expect(screen.getByRole('button', { name: copy.nav.orphanedCount(13) })).toBeInTheDocument();

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
