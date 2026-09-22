/**
 * Renaming and moving one note, through the whole shell.
 *
 * Until this existed a note could not be renamed in the interface at all:
 * `api.rename` was there, the endpoint was there, and nothing reached them.
 * Folders had a pencil, notes had none, and the only way to move a note was to
 * have it turn up as a finding in Tidy up and use the bulk "Move…".
 *
 * What these tests pin down is the part a restyle would lose quietly:
 *
 *  - both doors — the note's header menu and its row in the tree — reach the
 *    same dialog and really send the rename
 *  - the dialog moves as well as renames, by picking a folder rather than
 *    typing a path, and it says what the links will do
 *  - the open note follows the rename instead of pointing at a path that is gone
 *  - a taken name is reported in the dialog, which stays open, and nothing moves
 *  - text typed and not yet saved is written to the *old* path before the
 *    rename, so no late save re-creates the note where it used to be
 *  - a note held through a read-only share offers no rename anywhere
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NoteRow, Share, User } from '../src/api';
import { App } from '../src/App';
import { copy } from '../src/copy';
import { recentsKey } from '../src/accountStorage';

// The canvas has nothing to draw in jsdom, and nothing here asks it to.
vi.mock('../src/Brain', () => ({
  Brain: () => <canvas className="brain" data-testid="brain" tabIndex={0} />,
}));
vi.mock('../src/Editor', () => ({
  Editor: (props: { path: string; locked?: boolean; onChange: (content: string) => void }) => (
    <div data-testid="editor" data-locked={props.locked === true}>
      {props.path}
      <button type="button" onClick={() => props.onChange('typed, not yet saved')}>
        type
      </button>
    </div>
  ),
}));
vi.mock('../src/Context', () => ({ ContextPanel: () => <div /> }));

const server = vi.hoisted(() => ({
  signedIn: null as User | null,
  notes: [] as NoteRow[],
  dirs: [] as Array<{ owner: string; path: string }>,
  received: [] as Share[],
  /** Link rows pointing at a path, as the backlinks endpoint answers them. */
  backlinks: new Map<string, Array<{ source: string }>>(),
  /** Every rename that reached the server, as [owner, from, to]. */
  renamed: [] as Array<[string, string, string]>,
  /** Every folder rename that reached the server, as [from, to]. */
  renamedFolders: [] as Array<[string, string]>,
  /** Which notes the server says it rewrote links in, for the next rename. */
  updatedLinks: [] as string[],
  /** Set to refuse the next rename with that code. */
  renameFails: null as string | null,
  renameDelayMs: 0,
  /** How long a save takes to answer. */
  putDelayMs: 0,
  /** Each write, with the path it went to. */
  writes: [] as string[],
  /** The order requests started and ended in. */
  log: [] as string[],
}));

vi.mock('../src/api', async (original) => {
  const real = await original<typeof import('../src/api')>();
  const writable = (owner: string, path: string): boolean =>
    owner === server.signedIn?.id ||
    server.received.some((s) => s.owner === owner && s.canWrite && path.startsWith(s.prefix));
  const fake: Record<string, (...args: never[]) => Promise<unknown>> = {
    me: async () => ({ user: server.signedIn }),
    tree: async () => ({ notes: server.notes, dirs: server.dirs }),
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
    quickFind: async () => ({ notes: server.notes }),
    getNote: async (owner: string, path: string) => {
      const row = server.notes.find((n) => n.owner === owner && n.path === path);
      if (row === undefined) throw new real.ApiError(404, 'not_found', 'gone');
      return {
        owner,
        canWrite: writable(owner, path),
        note: { path, title: row.title, content: '', size: 0, mtimeMs: 1 },
      };
    },
    links: async (owner: string, path: string) => {
      const rows = (server.backlinks.get(path) ?? []).map((r) => ({
        owner,
        source: r.source,
        targetRaw: path,
        targetPath: path,
        heading: null,
        alias: null,
        offset: 0,
      }));
      return { backlinks: rows, outgoing: [] };
    },
    putNote: async (_owner: string, path: string) => {
      server.log.push(`put-start ${path}`);
      server.writes.push(path);
      if (server.putDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, server.putDelayMs));
      server.log.push(`put-end ${path}`);
      return { note: { path, title: '', content: '', size: 0, mtimeMs: 2 }, created: false };
    },
    renameFolder: async (from: string, to: string) => {
      server.log.push(`folder-start ${from} -> ${to}`);
      server.renamedFolders.push([from, to]);
      server.log.push(`folder-end ${from} -> ${to}`);
      // The shape the server really answers with. It used to be a pair of
      // counts, which the shell never looked at closely enough to notice —
      // until it started reporting the attachments and the leftovers too, and
      // read a `length` off a number.
      return {
        folder: to,
        movedNotes: server.notes
          .filter((n) => n.path.startsWith(`${from}/`))
          .map((n) => `${to}${n.path.slice(from.length)}`),
        movedFiles: [],
        updatedLinks: [],
        failed: [],
      };
    },
    rename: async (owner: string, from: string, to: string) => {
      server.log.push(`rename-start ${from} -> ${to}`);
      if (server.renameDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, server.renameDelayMs));
      if (server.renameFails !== null) {
        throw new real.ApiError(409, server.renameFails, 'a note already exists at that path');
      }
      if (server.notes.some((n) => n.owner === owner && n.path === to)) {
        throw new real.ApiError(409, 'exists', 'a note already exists at that path');
      }
      server.renamed.push([owner, from, to]);
      const title = to.split('/').pop()!.replace(/\.md$/, '');
      server.notes = server.notes.map((n) =>
        n.owner === owner && n.path === from ? { ...n, path: to, title } : n,
      );
      server.log.push(`rename-end ${from} -> ${to}`);
      return {
        note: { path: to, title, content: '', size: 0, mtimeMs: 3 },
        updatedLinks: server.updatedLinks,
      };
    },
  };
  const api = new Proxy(fake, { get: (target, key: string) => target[key] ?? (() => new Promise(() => {})) });
  return { ...real, api };
});

function row(owner: string, path: string): NoteRow {
  return { owner, path, title: path.split('/').pop()!.replace(/\.md$/, ''), size: 1, mtimeMs: 0 };
}

const PLAN = 'Projects/Deep/Plan.md';

let user: ReturnType<typeof userEvent.setup>;

/*
 * Time is the test's, not the machine's — see `delete-note.test.tsx`. The
 * debounce before a save and the delays below are exactly as long as written,
 * however loaded the machine is.
 */
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
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal('confirm', vi.fn(() => true));
  server.signedIn = { id: 'julian', displayName: 'Julian', role: 'user' };
  server.notes = [
    row('julian', PLAN),
    row('julian', 'Loose.md'),
    row('julian', 'Index.md'),
    row('julian', 'Archive/Old.md'),
    row('anna', 'Lesen/Nur lesen.md'),
    row('anna', 'Team/Gemeinsam.md'),
  ];
  server.dirs = [];
  server.received = [
    { id: 's1', owner: 'anna', prefix: 'Lesen/', grantee: 'julian', canWrite: false, createdAt: 0, kind: 'folder' as const },
    { id: 's2', owner: 'anna', prefix: 'Team/', grantee: 'julian', canWrite: true, createdAt: 0, kind: 'folder' as const },
  ];
  // Two notes link to the plan, one of them twice; the plan links to itself.
  server.backlinks = new Map([
    [PLAN, [{ source: 'Index.md' }, { source: 'Index.md' }, { source: 'Archive/Old.md' }, { source: PLAN }]],
  ]);
  server.renamed = [];
  server.updatedLinks = ['Index.md', 'Archive/Old.md'];
  server.renameFails = null;
  server.renameDelayMs = 0;
  server.putDelayMs = 0;
  server.writes = [];
  server.log = [];
});

afterEach(() => {
  window.localStorage.clear();
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

/** Opens the rename dialog from the open note's header menu. */
async function renameFromHeader(): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: copy.note.actions }));
  await user.click(screen.getByRole('menuitem', { name: copy.renameNote.menu }));
  return screen.findByRole('dialog', { name: /Rename/ });
}

/** Types a new name into the open dialog and submits it. */
async function rename(dialog: HTMLElement, name: string, folder?: string): Promise<void> {
  const field = within(dialog).getByLabelText(copy.renameNote.name);
  await user.clear(field);
  await user.type(field, name);
  if (folder !== undefined) {
    await user.selectOptions(within(dialog).getByLabelText(copy.renameNote.folder), folder);
  }
  await user.click(within(dialog).getByRole('button', { name: copy.renameNote.submit }));
}

describe('renaming from the note header', () => {
  it('sends the rename, follows the open note, and says how many links were rewritten', async () => {
    mount();
    await openFromPalette('Plan');

    const dialog = await renameFromHeader();
    // It says what it will do before it does it: where the note is now, and
    // what the path becomes — the same path until something is typed.
    expect(within(dialog).getAllByText(PLAN)).toHaveLength(2);
    await waitFor(() => expect(within(dialog).getByText(copy.renameNote.linksFollow(2))).toBeInTheDocument());

    await rename(dialog, 'Planning');

    await waitFor(() => expect(server.renamed).toEqual([['julian', PLAN, 'Projects/Deep/Planning.md']]));
    // The view followed the note rather than pointing at a path that is gone.
    await waitFor(() => expect(screen.getByTestId('editor')).toHaveTextContent('Projects/Deep/Planning.md'));
    // The dialog is done with, and the shell reports what the server really did.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Rename/ })).toBeNull());
    expect(
      await screen.findByText(copy.renameNote.done('Projects/Deep/Planning.md', 2), {
        selector: '.floaterror span',
      }),
    ).toBeInTheDocument();
    // The old path is out of the recents; the new one is in.
    const recents = window.localStorage.getItem(recentsKey('julian')) ?? '';
    expect(recents).not.toContain(PLAN);
    expect(recents).toContain('Projects/Deep/Planning.md');
  });

  it('moves the note by picking a folder, keeping the name', async () => {
    mount();
    await openFromPalette('Plan');

    const dialog = await renameFromHeader();
    await user.selectOptions(within(dialog).getByLabelText(copy.renameNote.folder), 'Archive');
    await user.click(within(dialog).getByRole('button', { name: copy.renameNote.submit }));

    await waitFor(() => expect(server.renamed).toEqual([['julian', PLAN, 'Archive/Plan.md']]));
  });

  it('offers the top of the vault as a destination', async () => {
    mount();
    await openFromPalette('Plan');

    const dialog = await renameFromHeader();
    await user.selectOptions(within(dialog).getByLabelText(copy.renameNote.folder), '');
    await user.click(within(dialog).getByRole('button', { name: copy.renameNote.submit }));

    await waitFor(() => expect(server.renamed).toEqual([['julian', PLAN, 'Plan.md']]));
  });

  it('says a target that is taken in words, keeps the dialog open, and moves nothing', async () => {
    mount();
    await openFromPalette('Plan');

    const dialog = await renameFromHeader();
    await rename(dialog, 'Old', 'Archive');

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(copy.renameNote.taken('Archive/Old.md'));
    expect(server.renamed).toEqual([]);
    // Still open, still on the note: the name is corrected here.
    expect(screen.getByRole('dialog', { name: /Rename/ })).toBeInTheDocument();
    expect(screen.getByTestId('editor')).toHaveTextContent(PLAN);
  });

  it('will not submit a name that changes nothing', async () => {
    mount();
    await openFromPalette('Plan');

    const dialog = await renameFromHeader();
    expect(within(dialog).getByRole('button', { name: copy.renameNote.submit })).toBeDisabled();

    await user.clear(within(dialog).getByLabelText(copy.renameNote.name));
    expect(within(dialog).getByRole('button', { name: copy.renameNote.submit })).toBeDisabled();
  });

  it('writes text that is not saved yet to the old path first', async () => {
    server.putDelayMs = 20;
    mount();
    await openFromPalette('Plan');

    // Typed, and not yet written: the debounce has not fired.
    await user.click(within(screen.getByTestId('editor')).getByRole('button', { name: 'type' }));
    expect(server.writes).toEqual([]);

    const dialog = await renameFromHeader();
    await rename(dialog, 'Planning');
    await advance(100);

    await waitFor(() => expect(server.renamed).toEqual([['julian', PLAN, 'Projects/Deep/Planning.md']]));
    // The save went to the path the text was typed at, and finished before the
    // rename began. A PUT landing after it would re-create the note there.
    expect(server.writes).toEqual([PLAN]);
    expect(server.log.indexOf(`put-end ${PLAN}`)).toBeLessThan(
      server.log.indexOf(`rename-start ${PLAN} -> Projects/Deep/Planning.md`),
    );
  });

  it('writes unsaved text before a folder around it is renamed', async () => {
    // Renaming the folder moves the note with it. A save that overtakes the
    // rename lands at the old path and creates the note there again — the same
    // failure the note rename guards against, on the operation that moves many
    // notes at once instead of one.
    server.putDelayMs = 20;
    mount();
    await openFromPalette('Plan');

    await user.click(within(screen.getByTestId('editor')).getByRole('button', { name: 'type' }));
    expect(server.writes).toEqual([]);

    vi.stubGlobal('prompt', () => 'Projects/Flach');
    const tree = screen.getByRole('tree');
    // `Deep` sits under `Projects`, which the tree opens on demand.
    await user.click(within(tree).getByRole('treeitem', { name: 'Projects' }));
    const pencil = await within(tree).findByRole('button', {
      name: copy.tree.renameFolderLabel('Deep'),
    });
    await user.click(pencil);
    await advance(100);

    await waitFor(() => expect(server.renamedFolders).toEqual([['Projects/Deep', 'Projects/Flach']]));
    expect(server.writes).toEqual([PLAN]);
    expect(server.log.indexOf(`put-end ${PLAN}`)).toBeLessThan(
      server.log.indexOf('folder-start Projects/Deep -> Projects/Flach'),
    );
  });

  it('offers no rename on a note held through a read-only share', async () => {
    mount();
    await openFromPalette('Nur lesen');

    // A read-only note of somebody else's has no action menu at all: nothing
    // in it would be allowed.
    expect(screen.queryByRole('button', { name: copy.note.actions })).toBeNull();
  });

  it('offers the rename on a note in a folder shared with write access', async () => {
    mount();
    await openFromPalette('Gemeinsam');

    await user.click(await screen.findByRole('button', { name: copy.note.actions }));
    expect(screen.getByRole('menuitem', { name: copy.renameNote.menu })).toBeInTheDocument();
  });
});

describe('renaming from the tree', () => {
  it('renames a note that is not the open one, and leaves the open one alone', async () => {
    mount();
    await openFromPalette('Plan');

    await user.click(await screen.findByRole('button', { name: copy.tree.renameNoteLabel('Loose') }));
    const dialog = await screen.findByRole('dialog', { name: /Rename/ });
    await rename(dialog, 'Collected');

    await waitFor(() => expect(server.renamed).toEqual([['julian', 'Loose.md', 'Collected.md']]));
    expect(screen.getByTestId('editor')).toHaveTextContent(PLAN);
  });

  it('opens the same dialog from F2 on a focused row', async () => {
    mount();
    await screen.findByRole('button', { name: copy.shell.account });

    // The row itself, not the pencil beside it: the row is the tree's item and
    // the pencil is an ordinary button, so the role tells them apart.
    const rowButton = await screen.findByRole('treeitem', { name: 'Loose' });
    rowButton.focus();
    await user.keyboard('{F2}');

    expect(await screen.findByRole('dialog', { name: copy.renameNote.title('Loose') })).toBeInTheDocument();
  });

  it('offers no pencil on a note shared read-only, and one on a writable share', async () => {
    mount();
    await openFromPalette('Nur lesen');

    expect(screen.queryByRole('button', { name: copy.tree.renameNoteLabel('Nur lesen') })).toBeNull();
    await openFromPalette('Gemeinsam');
    expect(await screen.findByRole('button', { name: copy.tree.renameNoteLabel('Gemeinsam') })).toBeInTheDocument();
  });
});
