/**
 * The palette answers two questions: which note is called this, and which notes
 * say this.
 *
 * Pinned here:
 *
 *  - notes by title come at once and on top, full-text hits below under their
 *    own heading, with the matched words marked
 *  - the full-text search waits for a pause in typing, and only from two
 *    characters on
 *  - an answer for words since replaced never overwrites the newer one
 *  - a note already offered by title is not offered again below
 *  - the arrow keys walk through both halves and Enter opens what is marked
 *  - the last row opens the Search view on the same words
 *  - an excerpt is text: markup in a note is shown, never run
 *  - the line a hit sits on is found from its excerpt, for the editor to jump to
 *
 * And the commands above the notes: every one of them is run through the
 * palette and checked by what it did, not by being in the list. A command that
 * renders and does nothing is the failure this half is prone to — the list is
 * built in one file and the action lives in another.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NoteRow, SearchHit, User } from '../src/api';
import { App } from '../src/App';
import { copy } from '../src/copy';
import { Palette, TEXT_SEARCH_DELAY_MS } from '../src/Palette';
import { lineOfHit, snippetParts } from '../src/snippet';

vi.mock('../src/Brain', () => ({ Brain: () => <canvas data-testid="brain" /> }));
vi.mock('../src/Editor', () => ({
  Editor: (props: { path: string; line: number | undefined }) => (
    <div data-testid="editor" data-path={props.path} data-line={props.line ?? ''} />
  ),
}));
vi.mock('../src/Context', () => ({ ContextPanel: () => <div /> }));

interface Pending {
  q: string;
  resolve: (hits: SearchHit[]) => void;
}

const server = vi.hoisted(() => ({
  signedIn: null as User | null,
  notes: [] as NoteRow[],
  /** What the title lookup answers, whatever is typed. */
  byTitle: [] as NoteRow[],
  /** Every full-text request, answered only when a test says so. */
  searches: [] as Pending[],
  contents: new Map<string, string>(),
  /** Every note written, so a command that creates one can be checked by it. */
  written: [] as Array<{ owner: string; path: string; content: string }>,
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
    quickFind: async () => ({ notes: server.byTitle }),
    search: (q: string) =>
      new Promise((resolve) => {
        server.searches.push({ q, resolve: (hits) => resolve({ hits }) });
      }),
    getNote: async (owner: string, path: string) => {
      const content = server.contents.get(path) ?? '';
      return { owner, canWrite: true, note: { path, title: path, content, size: content.length, mtimeMs: 1 } };
    },
    putNote: async (owner: string, path: string, content: string) => {
      server.written.push({ owner, path, content });
      server.contents.set(path, content);
      return { note: { path, title: path, content, size: content.length, mtimeMs: 2 }, created: true };
    },
    ensureNote: async (owner: string, path: string, content: string) => {
      server.written.push({ owner, path, content });
      server.contents.set(path, content);
      return { note: { path, title: path, content, size: content.length, mtimeMs: 2 }, created: true };
    },
  };
  const api = new Proxy(fake, { get: (target, name: string) => target[name] ?? (() => new Promise(() => {})) });
  return { ...real, api };
});

function note(path: string, owner = 'julian'): NoteRow {
  return { owner, path, title: path.split('/').pop()!.replace(/\.md$/, ''), size: 1, mtimeMs: 1 };
}

function hit(path: string, snippet: string, owner = 'julian'): SearchHit {
  return { ...note(path, owner), snippet };
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
  server.signedIn = { id: 'julian', displayName: 'Julian', role: 'user' };
  server.notes = [];
  server.byTitle = [];
  server.searches = [];
  server.contents = new Map();
  server.written = [];
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function renderPalette() {
  const handlers = { onClose: vi.fn(), onOpenNote: vi.fn(), onSearchAll: vi.fn(), today: vi.fn() };
  render(
    <Palette
      open
      self="julian"
      commands={[{ key: 'today', label: copy.palette.openToday, run: handlers.today }]}
      onClose={handlers.onClose}
      onOpenNote={handlers.onOpenNote}
      onSearchAll={handlers.onSearchAll}
    />,
  );
  return handlers;
}

const box = (): HTMLElement => screen.getByRole('textbox', { name: copy.palette.titleLabel });

/** Types the words and lets the pause pass, so the full-text request goes out. */
async function typeAndWait(words: string): Promise<Pending> {
  const before = server.searches.length;
  fireEvent.change(box(), { target: { value: words } });
  await waitFor(() => expect(server.searches.length).toBe(before + 1));
  return server.searches[server.searches.length - 1]!;
}

async function answer(pending: Pending, hits: SearchHit[]): Promise<void> {
  await act(async () => {
    pending.resolve(hits);
    await Promise.resolve();
  });
}

describe('two halves', () => {
  it('lists notes by title on top and full-text hits below, with the words marked', async () => {
    server.byTitle = [note('Homelab/Proxmox.md')];
    renderPalette();
    const pending = await typeAndWait('quorum');
    expect(pending.q).toBe('quorum');
    await answer(pending, [hit('Homelab/Cluster.md', 'drei Knoten für das [Quorum] im Cluster')]);

    const list = screen.getByRole('dialog', { name: copy.palette.label });
    const notesHeading = await within(list).findByText(copy.palette.notes);
    const inNotesHeading = within(list).getByText(copy.palette.inNotes);
    const byTitle = within(list).getByRole('button', { name: /Proxmox/ });
    const byText = within(list).getByRole('button', { name: /Cluster/ });

    const order = [notesHeading, byTitle, inNotesHeading, byText];
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(within(byText).getByText('Quorum').tagName).toBe('MARK');
    expect(byText).toHaveTextContent('drei Knoten für das Quorum im Cluster');
  });

  it('keeps the commands', async () => {
    renderPalette();
    fireEvent.change(box(), { target: { value: 'today' } });
    expect(await screen.findByRole('button', { name: new RegExp(copy.palette.openToday) })).toBeInTheDocument();
  });

  it('does not offer a note twice when its title already matched', async () => {
    server.byTitle = [note('Homelab/Proxmox.md')];
    renderPalette();
    const pending = await typeAndWait('proxmox');
    await answer(pending, [
      hit('Homelab/Proxmox.md', '[Proxmox] VE 8'),
      hit('Homelab/Backup.md', 'Sicherung von [Proxmox] nach Azure'),
    ]);
    await screen.findByText(copy.palette.inNotes);
    expect(screen.getAllByRole('button', { name: /Proxmox/ })).toHaveLength(2); // the title row and the Backup hit
    expect(screen.getAllByRole('button', { name: /^Proxmox/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Backup/ })).toBeInTheDocument();
  });

  it('shows an excerpt as text, never as markup', async () => {
    renderPalette();
    const pending = await typeAndWait('bild');
    await answer(pending, [hit('Evil.md', 'ein [Bild] <img src=x onerror="window.__owned=1"> hier')]);
    const row = await screen.findByRole('button', { name: /Evil/ });
    expect(row.querySelector('img')).toBeNull();
    expect(row).toHaveTextContent('<img src=x onerror="window.__owned=1">');
    expect((window as unknown as { __owned?: number }).__owned).toBeUndefined();
  });
});

describe('asking the server', () => {
  it('waits for a pause in typing, then asks once for the whole word', async () => {
    renderPalette();
    // Typed at an ordinary pace: each key well inside the pause.
    for (const words of ['p', 'pr', 'pro', 'prox']) {
      fireEvent.change(box(), { target: { value: words } });
      await new Promise((resolve) => setTimeout(resolve, TEXT_SEARCH_DELAY_MS / 3));
    }
    expect(server.searches).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, TEXT_SEARCH_DELAY_MS + 80));
    expect(server.searches.map((s) => s.q)).toEqual(['prox']);
  });

  it('does not ask for a single character', async () => {
    renderPalette();
    fireEvent.change(box(), { target: { value: 'p' } });
    await new Promise((resolve) => setTimeout(resolve, TEXT_SEARCH_DELAY_MS + 80));
    expect(server.searches).toHaveLength(0);
  });

  it('keeps the title half usable while the full-text half is pending', async () => {
    server.byTitle = [note('Homelab/Proxmox.md')];
    const { onOpenNote } = renderPalette();
    fireEvent.change(box(), { target: { value: 'prox' } });
    await screen.findByRole('button', { name: /Proxmox/ });
    expect(server.searches).toHaveLength(0);
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onOpenNote).toHaveBeenCalledWith('julian', 'Homelab/Proxmox.md');
  });

  it('drops an answer that arrives after the answer to newer words', async () => {
    renderPalette();
    const older = await typeAndWait('pro');
    const newer = await typeAndWait('proxmox');
    await answer(newer, [hit('Fresh.md', 'the [proxmox] cluster')]);
    await screen.findByRole('button', { name: /Fresh/ });
    await answer(older, [hit('Stale.md', 'a [pro] tip')]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('button', { name: /Stale/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Fresh/ })).toBeInTheDocument();
  });
});

describe('the keyboard', () => {
  it('walks from the title half into the full-text half and to the last row', async () => {
    server.byTitle = [note('Homelab/Proxmox.md')];
    const { onOpenNote, onSearchAll } = renderPalette();
    const pending = await typeAndWait('quorum');
    await answer(pending, [hit('Homelab/Cluster.md', 'für das [Quorum]')]);
    await screen.findByRole('button', { name: /Cluster/ });

    const active = (): string => screen.getByRole('dialog').querySelector('[data-active="true"]')?.textContent ?? '';
    expect(active()).toMatch(/Proxmox/);
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(active()).toMatch(/Cluster/);
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(active()).toBe(copy.palette.searchAll('quorum') + copy.palette.searchView);
    // The last row is the end: one more step stays on it.
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(active()).toMatch(/Search all/);
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSearchAll).toHaveBeenCalledWith('quorum');

    // Closing is the parent's job, so the list is still up here.
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(active()).toMatch(/Cluster/);
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onOpenNote).toHaveBeenCalledWith('julian', 'Homelab/Cluster.md', { snippet: 'für das [Quorum]', query: 'quorum' });
  });

  it('offers the Search view for the words typed, by click as well', async () => {
    const { onSearchAll, onClose } = renderPalette();
    fireEvent.change(box(), { target: { value: 'backup azure' } });
    await userEvent.click(await screen.findByRole('button', { name: new RegExp(copy.palette.searchAll('backup azure')) }));
    expect(onSearchAll).toHaveBeenCalledWith('backup azure');
    expect(onClose).toHaveBeenCalled();
  });

  it('offers no search row before anything is typed', () => {
    renderPalette();
    expect(screen.queryByRole('button', { name: /Search all/ })).toBeNull();
  });
});

describe('the excerpt', () => {
  it('marks only bracketed words that were searched for', () => {
    // A wikilink comes back from the index with the match bracketed inside it.
    expect(snippetParts('see [[[Proxmox]]] and [x] done', 'proxmox')).toEqual([
      { text: 'see [[', hit: false },
      { text: 'Proxmox', hit: true },
      { text: ']] and [x] done', hit: false },
    ]);
  });

  it('matches across accents, as the index does', () => {
    expect(snippetParts('[Über] den Wolken', 'uber').filter((part) => part.hit)).toEqual([{ text: 'Über', hit: true }]);
  });

  it('finds the line the excerpt came from, not the first mention', () => {
    const content = ['# Cluster', '', 'Quorum ist wichtig.', '', 'Später: drei Knoten für das Quorum im Cluster.'].join('\n');
    expect(lineOfHit(content, '… drei Knoten für das [Quorum] im Cluster.', 'quorum')).toBe(5);
    expect(lineOfHit(content, '[Quorum] ist wichtig.', 'quorum')).toBe(3);
  });

  it('opens at the top when the words are not in the text', () => {
    expect(lineOfHit('nothing here', '[Proxmox]', 'proxmox')).toBeUndefined();
  });
});

function mount(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

async function openPalette(): Promise<void> {
  await screen.findByRole('button', { name: copy.shell.account });
  await userEvent.keyboard('{Control>}k{/Control}');
  await screen.findByRole('dialog', { name: copy.palette.label });
}

/** Opens the palette, types the words, and runs the one command they find. */
async function runCommand(words: string, label: string): Promise<void> {
  await openPalette();
  fireEvent.change(box(), { target: { value: words } });
  const dialog = screen.getByRole('dialog', { name: copy.palette.label });
  const row = await within(dialog).findByRole('button', { name: new RegExp(`^${label}`) });
  await userEvent.click(row);
}

describe('in the shell', () => {
  it('opens a full-text hit at the line it was found on', async () => {
    server.notes = [note('Homelab/Cluster.md')];
    server.contents.set('Homelab/Cluster.md', 'Quorum ist wichtig.\n\nDrei Knoten für das Quorum.');
    mount();
    await openPalette();
    const pending = await typeAndWait('quorum');
    await answer(pending, [hit('Homelab/Cluster.md', 'Drei Knoten für das [Quorum].')]);
    await userEvent.click(await screen.findByRole('button', { name: /Cluster/ }));
    const editor = await screen.findByTestId('editor');
    await waitFor(() => expect(editor).toHaveAttribute('data-line', '3'));
  });

  it('opens the Search view on the words typed', async () => {
    mount();
    await openPalette();
    fireEvent.change(box(), { target: { value: 'azure' } });
    await userEvent.click(await screen.findByRole('button', { name: new RegExp(copy.palette.searchAll('azure')) }));
    expect(await screen.findByRole('heading', { level: 1, name: copy.nav.search })).toBeInTheDocument();
    await waitFor(() => expect(server.searches.some((s) => s.q === 'azure')).toBe(true));
  });
});

/**
 * The commands above the notes.
 *
 * Each one is checked by what it did — the view that arrived, the note that was
 * written, the theme on the document — rather than by the row being there. The
 * list is built in `App.tsx` and every action it names lives somewhere else, so
 * a row that renders and does nothing is exactly the way this breaks.
 */
describe('the commands', () => {
  it.each([
    ['files', 'upload', copy.nav.files],
    ['sharing', 'shares', copy.nav.sharing],
    ['settings', 'preferences', copy.nav.settings],
  ])('reaches %s, which is otherwise behind the account menu', async (_what, typed, label) => {
    mount();
    // Found by a keyword rather than by its label: the words somebody reaches
    // for are part of the command, and they are easy to wire up and never use.
    await runCommand(typed, label);
    expect(await screen.findByRole('heading', { level: 1, name: label })).toBeInTheDocument();
  });

  it('opens administration for an administrator', async () => {
    server.signedIn = { id: 'julian', displayName: 'Julian', role: 'admin' };
    mount();
    await runCommand('accounts', copy.nav.admin);
    expect(await screen.findByRole('heading', { level: 1, name: copy.nav.admin })).toBeInTheDocument();
  });

  it('offers administration to nobody else', async () => {
    mount();
    await openPalette();
    fireEvent.change(box(), { target: { value: 'accounts' } });
    const dialog = screen.getByRole('dialog', { name: copy.palette.label });
    await within(dialog).findByText(copy.palette.nothingFound);
    expect(within(dialog).queryByRole('button', { name: new RegExp(`^${copy.nav.admin}`) })).toBeNull();
  });

  it('starts a note, through the same prompt the sidebar opens', async () => {
    vi.stubGlobal('prompt', vi.fn(() => 'Homelab/Backup plan'));
    mount();
    await runCommand('new note', copy.nav.newNote);
    await waitFor(() => expect(server.written.map((w) => w.path)).toEqual(['Homelab/Backup plan.md']));
    const editor = await screen.findByTestId('editor');
    expect(editor).toHaveAttribute('data-path', 'Homelab/Backup plan.md');
  });

  it("opens today's note", async () => {
    mount();
    await runCommand('today', copy.palette.openToday);
    // Whatever today is called, the note that opened is the one started for it —
    // `shared/journal.ts` decides the path, and this is not a second opinion.
    await waitFor(() => expect(server.written).toHaveLength(1));
    const editor = await screen.findByTestId('editor');
    expect(editor.getAttribute('data-path')).toBe(server.written[0]!.path);
  });

  it('flips the theme, and then names the way back', async () => {
    mount();
    await runCommand('dark', copy.shell.darkTheme);
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));

    await runCommand('light', copy.shell.lightTheme);
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('light'));
  });

  /**
   * The restraint, pinned.
   *
   * Everything the sidebar already offers is one click and one glance away, and
   * a palette that repeats it is a second navigation bar to keep in step with
   * the first. Sign out is left out for a different reason: Enter in a fuzzy
   * list is the most accidental key here.
   */
  it('is not a second navigation bar', async () => {
    mount();
    await openPalette();
    const dialog = screen.getByRole('dialog', { name: copy.palette.label });
    for (const label of [copy.nav.overview, copy.nav.network, copy.nav.tidy, copy.nav.journal, copy.nav.signOut]) {
      expect(within(dialog).queryByRole('button', { name: new RegExp(`^${label}`) })).toBeNull();
    }
  });
});
