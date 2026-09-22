/**
 * Deleting a note, and showing one in the tree, through the whole shell.
 *
 * Until this existed there was no way to delete a single note at all: the API
 * call, the endpoint and the confirmation text were there, and no control
 * reached them. What these tests pin down is the part a restyle or a refactor
 * would lose quietly:
 *
 *  - all three places (the note's header, the tree, the inspector) go through
 *    one path, which asks first and names the links that will break
 *  - cancelling deletes nothing
 *  - a note read through a read-only share offers no delete anywhere
 *  - afterwards the note is gone from the screen, the recents and the caches
 *  - "Show in tree" opens the folders and marks the note without opening it
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GraphData, NoteRow, Share, User } from '../src/api';
import { App } from '../src/App';
import { copy } from '../src/copy';
import { recentsKey } from '../src/accountStorage';

// The canvas has nothing to draw in jsdom. The stand-in offers what the real
// brain does with a click on a point: it focuses that note.
vi.mock('../src/Brain', () => ({
  Brain: (props: {
    data: GraphData;
    focus?: { onPick: (picked: { kind: 'note'; key: string } | null) => void };
  }) => (
    <>
      <canvas className="brain" data-testid="brain" tabIndex={0} />
      {props.focus !== undefined &&
        props.data.nodes.map((n) => (
          <button
            key={n.path}
            type="button"
            onClick={() => props.focus!.onPick({ kind: 'note', key: `${n.owner}\u0000${n.path}` })}
          >
            {`pick ${n.owner}/${n.path}`}
          </button>
        ))}
    </>
  ),
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
  received: [] as Share[],
  /** Link rows pointing at a path, as the backlinks endpoint answers them. */
  backlinks: new Map<string, Array<{ source: string }>>(),
  deleted: [] as Array<[string, string]>,
  written: [] as Array<[string, string]>,
  calls: { tree: 0, graph: 0, links: 0 },
  /** How long the backlinks endpoint takes to answer. */
  linksDelayMs: 0,
  /** How long the delete takes to answer, and whether it fails. */
  deleteDelayMs: 0,
  deleteFails: false,
  /** How long a save takes to answer. */
  putDelayMs: 0,
  /** Whether the note being saved is gone from its path by the time the save arrives. */
  putMissing: false,
  /** Every note's version on the server, by path; a save moves it on. */
  versions: new Map<string, number>(),
  /**
   * Each write with the version it said it started from.
   *
   * A string, because a version is the hash of a note's text and no longer the
   * moment it was read at; this fake makes one out of its counter so that the
   * base a write claims stays readable in an assertion.
   */
  writes: [] as Array<{ path: string; base: string | undefined }>,
  /** The order requests started and ended in. */
  log: [] as string[],
  /** What the delete preview answers; null makes it fail. */
  preview: null as { restorable: number; unsaved: number; notYours: number; history: boolean } | null,
  previews: [] as Array<[string, string[]]>,
}));

vi.mock('../src/api', async (original) => {
  const real = await original<typeof import('../src/api')>();
  const writable = (owner: string, path: string): boolean =>
    owner === server.signedIn?.id ||
    server.received.some((s) => s.owner === owner && s.canWrite && path.startsWith(s.prefix));
  const fake: Record<string, (...args: never[]) => Promise<unknown>> = {
    me: async () => ({ user: server.signedIn }),
    tree: async () => {
      server.calls.tree += 1;
      return { notes: server.notes, dirs: [] };
    },
    tidy: async () => ({
      orphans: server.notes.filter((n) => n.owner === server.signedIn?.id && n.path === 'Loose.md'),
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
    graph: async () => {
      server.calls.graph += 1;
      return {
        nodes: server.notes.map((n) => ({
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
    },
    quickFind: async () => ({ notes: server.notes }),
    getNote: async (owner: string, path: string) => {
      const row = server.notes.find((n) => n.owner === owner && n.path === path);
      if (row === undefined) throw new real.ApiError(404, 'not_found', 'gone');
      server.log.push(`get ${path}`);
      return {
        owner,
        canWrite: writable(owner, path),
        note: {
          path,
          title: row.title,
          content: '',
          size: 0,
          mtimeMs: server.versions.get(path) ?? 0,
          hash: String(server.versions.get(path) ?? 0),
        },
      };
    },
    links: async (owner: string, path: string) => {
      server.calls.links += 1;
      if (server.linksDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, server.linksDelayMs));
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
    putNote: async (owner: string, path: string, _content: string, base?: string) => {
      server.log.push(`put-start ${path}`);
      server.written.push([owner, path]);
      server.writes.push({ path, base });
      if (server.putDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, server.putDelayMs));
      if (server.putMissing) throw new real.ApiError(404, 'not_found', 'note does not exist');
      const version = (server.versions.get(path) ?? 0) + 1000;
      server.versions.set(path, version);
      server.log.push(`put-end ${path}`);
      return {
        note: { path, title: '', content: '', size: 0, mtimeMs: version, hash: String(version) },
        created: false,
      };
    },
    deletePreview: async (owner: string, paths: string[]) => {
      server.previews.push([owner, paths]);
      if (server.preview === null) throw new real.ApiError(500, 'internal', 'no');
      return server.preview;
    },
    deleteNote: async (owner: string, path: string) => {
      server.log.push(`delete-start ${path}`);
      if (server.deleteDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, server.deleteDelayMs));
      server.log.push(`delete-end ${path}`);
      if (server.deleteFails) throw new real.ApiError(500, 'internal', 'disk full');
      server.deleted.push([owner, path]);
      server.notes = server.notes.filter((n) => !(n.owner === owner && n.path === path));
      return {};
    },
  };
  const api = new Proxy(fake, { get: (target, key: string) => target[key] ?? (() => new Promise(() => {})) });
  return { ...real, api };
});

function row(owner: string, path: string): NoteRow {
  return { owner, path, title: path.split('/').pop()!.replace(/\.md$/, ''), size: 1, mtimeMs: 0 };
}

const PLAN = 'Projects/Deep/Plan.md';

let confirm: ReturnType<typeof vi.fn>;

/*
 * Time is the test's, not the machine's. The fake server answers after set
 * delays, and the races below are about which answer comes first; on real
 * timers a busy machine could stretch one delay past another and turn a
 * correct order into a failure. On fake timers every delay is exactly as long
 * as written, however loaded the machine is.
 *
 * Testing Library advances fake timers while it waits once it can see a
 * `jest`-style clock, and user-event is told to advance them between its steps.
 */
let user: ReturnType<typeof userEvent.setup>;

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function narrowScreen(narrow: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: narrow && query.includes('max-width'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
  user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  window.localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
  narrowScreen(false);
  confirm = vi.fn(() => true);
  vi.stubGlobal('confirm', confirm);
  server.signedIn = { id: 'julian', displayName: 'Julian', role: 'user' };
  server.notes = [
    row('julian', PLAN),
    row('julian', 'Loose.md'),
    row('julian', 'Index.md'),
    row('julian', 'Projects/Log.md'),
    row('anna', 'Lesen/Nur lesen.md'),
    row('anna', 'Team/Gemeinsam.md'),
  ];
  server.received = [
    { id: 's1', owner: 'anna', prefix: 'Lesen/', grantee: 'julian', canWrite: false, createdAt: 0, kind: 'folder' as const },
    { id: 's2', owner: 'anna', prefix: 'Team/', grantee: 'julian', canWrite: true, createdAt: 0, kind: 'folder' as const },
  ];
  // Two notes link to the plan, one of them twice; the plan links to itself.
  server.backlinks = new Map([[PLAN, [{ source: 'Index.md' }, { source: 'Index.md' }, { source: 'Projects/Log.md' }, { source: PLAN }]]]);
  server.deleted = [];
  server.written = [];
  server.calls = { tree: 0, graph: 0, links: 0 };
  server.linksDelayMs = 0;
  server.deleteDelayMs = 0;
  server.deleteFails = false;
  server.putDelayMs = 0;
  server.putMissing = false;
  server.versions = new Map([[PLAN, 111], ['Loose.md', 222]]);
  server.writes = [];
  server.log = [];
  server.preview = { restorable: 1, unsaved: 0, notYours: 0, history: true };
  server.previews = [];
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

/** Opens a note by title and waits until the editor shows that one. */
async function switchTo(title: string, path: string): Promise<void> {
  await user.keyboard('{Control>}k{/Control}');
  const dialog = await screen.findByRole('dialog', { name: copy.palette.label });
  await user.click(await within(dialog).findByRole('button', { name: new RegExp(title) }));
  await waitFor(() => expect(screen.getByTestId('editor')).toHaveTextContent(path), { timeout: 3000 });
}

async function toNetwork(): Promise<void> {
  await user.click(await screen.findByRole('button', { name: copy.nav.network }));
  await screen.findByTestId('brain');
}

function storedRecents(): string {
  return window.localStorage.getItem(recentsKey('julian')) ?? '';
}

const RESTORABLE = copy.ask.afterDelete({ restorable: 1, unsaved: 0, notYours: 0, history: true });

/** The question for a note whose last saved version can be restored. */
function ask(title: string): string {
  return `${copy.ask.deleteNote(title)} ${RESTORABLE}`;
}

const QUESTION_PLAN = `${ask('Plan')} ${copy.ask.linksWillBreak(2)}`;

describe("deleting from the note's header", () => {
  it('asks with the number of linking notes, deletes, and goes home with the note gone everywhere', async () => {
    mount();
    await openFromPalette('Plan');
    await waitFor(() => expect(storedRecents()).toContain(PLAN));
    const treeBefore = server.calls.tree;

    await user.click(screen.getByRole('button', { name: copy.note.actions }));
    await user.click(screen.getByRole('menuitem', { name: copy.note.delete }));

    await waitFor(() => expect(server.deleted).toEqual([['julian', PLAN]]));
    // Distinct notes other than itself: Index (twice) and Log.
    expect(confirm).toHaveBeenCalledWith(QUESTION_PLAN);
    expect(copy.ask.linksWillBreak(2)).toBe('2 notes link here — those links will break.');

    // Off the screen, back home.
    await waitFor(() => expect(screen.queryByTestId('editor')).toBeNull());
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(copy.nav.overview);
    // Out of the recents, in storage and in the sidebar.
    expect(storedRecents()).not.toContain(PLAN);
    // The tree was asked again, and no longer lists it.
    await waitFor(() => expect(server.calls.tree).toBeGreaterThan(treeBefore));
    await waitFor(() => expect(screen.queryByText('Plan')).toBeNull());
  });

  it('drops unsaved text in the deleted note, so no late save brings it back', async () => {
    mount();
    await openFromPalette('Plan');
    await user.click(within(screen.getByTestId('editor')).getByRole('button', { name: 'type' }));

    await user.click(screen.getByRole('button', { name: copy.note.actions }));
    await user.click(screen.getByRole('menuitem', { name: copy.note.delete }));
    await waitFor(() => expect(server.deleted).toEqual([['julian', PLAN]]));

    // Longer than the save delay, and then a switch, which writes whatever is
    // still pending before it opens anything.
    await advance(700);
    await openFromPalette('Loose');
    expect(server.written).toEqual([]);
  });

  it('holds a save that would fire while the links are being counted', async () => {
    // Slower than the save delay: without holding it, the save lands first and
    // an in-flight write can arrive after the delete.
    server.linksDelayMs = 700;
    mount();
    await openFromPalette('Plan');
    await user.click(within(screen.getByTestId('editor')).getByRole('button', { name: 'type' }));
    await user.click(screen.getByRole('button', { name: copy.note.actions }));
    await user.click(screen.getByRole('menuitem', { name: copy.note.delete }));
    await waitFor(() => expect(server.deleted).toEqual([['julian', PLAN]]), { timeout: 2000 });
    await advance(600);
    expect(server.written).toEqual([]);
  });

  describe('nothing written while the delete is under way', () => {
    const typeInEditor = (): Promise<void> =>
      user.click(within(screen.getByTestId('editor')).getByRole('button', { name: 'type' }));
    const askToDelete = async (): Promise<void> => {
      await user.click(screen.getByRole('button', { name: copy.note.actions }));
      await user.click(screen.getByRole('menuitem', { name: copy.note.delete }));
    };
    const settle = advance;

    it('typing while the links are counted', async () => {
      server.linksDelayMs = 200;
      server.deleteDelayMs = 900;
      mount();
      await openFromPalette('Plan');
      await askToDelete();
      await typeInEditor();
      await waitFor(() => expect(server.deleted).toEqual([['julian', PLAN]]), { timeout: 3000 });
      await settle(700);
      expect(server.written).toEqual([]);
    });

    it('typing after the question was answered, while the delete runs', async () => {
      server.deleteDelayMs = 900;
      mount();
      await openFromPalette('Plan');
      await askToDelete();
      await waitFor(() => expect(confirm).toHaveBeenCalled());
      await typeInEditor();
      await settle(650);
      expect(server.written).toEqual([]);
      await waitFor(() => expect(server.deleted).toEqual([['julian', PLAN]]), { timeout: 3000 });
      await settle(700);
      expect(server.written).toEqual([]);
    });

    it('the tab being hidden while the delete runs', async () => {
      server.deleteDelayMs = 900;
      mount();
      await openFromPalette('Plan');
      await typeInEditor();
      await askToDelete();
      await waitFor(() => expect(confirm).toHaveBeenCalled());
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
      await settle(100);
      expect(server.written).toEqual([]);
      await waitFor(() => expect(server.deleted).toEqual([['julian', PLAN]]), { timeout: 3000 });
      await settle(700);
      expect(server.written).toEqual([]);
    });

    it('locks the editor for the time of the delete', async () => {
      server.deleteDelayMs = 600;
      confirm.mockReturnValue(false);
      mount();
      await openFromPalette('Plan');
      expect(screen.getByTestId('editor')).toHaveAttribute('data-locked', 'false');

      // Cancelled: locked while asking, free again afterwards.
      server.linksDelayMs = 300;
      await askToDelete();
      await waitFor(() => expect(screen.getByTestId('editor')).toHaveAttribute('data-locked', 'true'));
      await waitFor(() => expect(confirm).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByTestId('editor')).toHaveAttribute('data-locked', 'false'));

      // Accepted: locked until the delete has answered.
      server.linksDelayMs = 0;
      confirm.mockReturnValue(true);
      await askToDelete();
      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
      expect(screen.getByTestId('editor')).toHaveAttribute('data-locked', 'true');
      await waitFor(() => expect(screen.queryByTestId('editor')).toBeNull(), { timeout: 3000 });
    });

    it('writes the held text after a failed delete', async () => {
      server.deleteFails = true;
      // Longer than the save delay: a debounce that ran anyway would have
      // fired, been refused, and left nothing to write once the delete failed.
      server.deleteDelayMs = 900;
      mount();
      await openFromPalette('Plan');
      await askToDelete();
      await waitFor(() => expect(confirm).toHaveBeenCalled());
      await typeInEditor();
      await waitFor(() => expect(screen.getByText('disk full')).toBeInTheDocument(), { timeout: 3000 });
      await waitFor(() => expect(server.written).toEqual([['julian', PLAN]]), { timeout: 2000 });
      expect(screen.getByTestId('editor')).toHaveAttribute('data-locked', 'false');
    });

    it('says in the question that unsaved text goes, only when there is some', async () => {
      confirm.mockReturnValue(false);
      mount();
      await openFromPalette('Plan');
      await askToDelete();
      await waitFor(() => expect(confirm).toHaveBeenCalledWith(QUESTION_PLAN));

      await typeInEditor();
      await askToDelete();
      await waitFor(() => expect(confirm).toHaveBeenLastCalledWith(`${QUESTION_PLAN} ${copy.ask.unsavedDropped}`));
    });
  });

  it('keeps unsaved text when the question is cancelled', async () => {
    confirm.mockReturnValue(false);
    mount();
    await openFromPalette('Plan');
    await user.click(within(screen.getByTestId('editor')).getByRole('button', { name: 'type' }));
    await user.click(screen.getByRole('button', { name: copy.note.actions }));
    await user.click(screen.getByRole('menuitem', { name: copy.note.delete }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    await waitFor(() => expect(server.written).toEqual([['julian', PLAN]]));
  });

  it('deletes nothing when the question is cancelled', async () => {
    confirm.mockReturnValue(false);
    mount();
    await openFromPalette('Plan');

    await user.click(screen.getByRole('button', { name: copy.note.actions }));
    await user.click(screen.getByRole('menuitem', { name: copy.note.delete }));

    await waitFor(() => expect(confirm).toHaveBeenCalledWith(QUESTION_PLAN));
    expect(server.deleted).toEqual([]);
    expect(screen.getByTestId('editor')).toHaveTextContent(PLAN);
    expect(storedRecents()).toContain(PLAN);
  });

  it('asks without a count where nothing links to the note', async () => {
    mount();
    await openFromPalette('Loose');
    await user.click(screen.getByRole('button', { name: copy.note.actions }));
    await user.click(screen.getByRole('menuitem', { name: copy.note.delete }));
    await waitFor(() => expect(server.deleted).toEqual([['julian', 'Loose.md']]));
    expect(confirm).toHaveBeenCalledWith(ask('Loose'));
  });

  it('offers no actions on a note shared read-only, and delete on one shared writable', async () => {
    mount();
    await openFromPalette('Nur lesen');
    expect(screen.queryByRole('button', { name: copy.note.actions })).toBeNull();

    await openFromPalette('Gemeinsam');
    await user.click(await screen.findByRole('button', { name: copy.note.actions }));
    await user.click(screen.getByRole('menuitem', { name: copy.note.delete }));
    await waitFor(() => expect(server.deleted).toEqual([['anna', 'Team/Gemeinsam.md']]));
  });
});

describe('what the question says about the way back', () => {
  async function deleteLoose(): Promise<void> {
    mount();
    await openFromPalette('Loose');
    await user.click(screen.getByRole('button', { name: copy.note.actions }));
    await user.click(screen.getByRole('menuitem', { name: copy.note.delete }));
    await waitFor(() => expect(server.deleted).toEqual([['julian', 'Loose.md']]));
  }

  it('asks the server about exactly this note', async () => {
    await deleteLoose();
    expect(server.previews).toEqual([['julian', ['Loose.md']]]);
    expect(RESTORABLE).toBe('Its last saved version can be restored from Tidy up for 30 days.');
  });

  it('says a note cannot come back where the host keeps no history', async () => {
    server.preview = { restorable: 0, unsaved: 1, notYours: 0, history: false };
    await deleteLoose();
    expect(confirm).toHaveBeenCalledWith(
      `${copy.ask.deleteNote('Loose')} This server keeps no history, so it cannot be restored.`,
    );
  });

  it('says a note cannot come back when no version of it was saved yet', async () => {
    server.preview = { restorable: 0, unsaved: 1, notYours: 0, history: true };
    await deleteLoose();
    expect(confirm).toHaveBeenCalledWith(
      `${copy.ask.deleteNote('Loose')} No version of it has been saved yet, so it cannot be restored.`,
    );
  });

  it('tells somebody who could not restore it so', async () => {
    server.preview = { restorable: 0, unsaved: 0, notYours: 1, history: false };
    await deleteLoose();
    expect(confirm).toHaveBeenCalledWith(`${copy.ask.deleteNote('Loose')} You will not be able to restore it.`);
  });

  it('promises nothing when the server could not say', async () => {
    server.preview = null;
    await deleteLoose();
    expect(confirm).toHaveBeenCalledWith(copy.ask.deleteNote('Loose'));
  });
});

describe('a bulk delete from Tidy up', () => {
  it('asks the server about the selection and says how many can come back', async () => {
    server.preview = { restorable: 0, unsaved: 1, notYours: 0, history: true };
    mount();
    await user.click(await screen.findByRole('button', { name: copy.nav.tidy }));
    await user.click(await screen.findByRole('checkbox', { name: copy.tidy.select('Loose') }));
    await user.click(screen.getByRole('button', { name: copy.tidy.delete }));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(server.previews).toEqual([['julian', ['Loose.md']]]);
    expect(confirm).toHaveBeenCalledWith(
      `${copy.ask.deleteNotes(1)} No version of it has been saved yet, so it cannot be restored.`,
    );
  });
});

describe('deleting from the tree', () => {
  it('asks, deletes, and leaves the open note alone when it is a different one', async () => {
    mount();
    await openFromPalette('Plan');

    await user.click(await screen.findByRole('button', { name: copy.tree.deleteNoteLabel('Loose') }));

    await waitFor(() => expect(server.deleted).toEqual([['julian', 'Loose.md']]));
    expect(confirm).toHaveBeenCalledWith(ask('Loose'));
    expect(screen.getByTestId('editor')).toHaveTextContent(PLAN);
  });

  it('closes the editor when the note deleted from the tree is the open one', async () => {
    mount();
    await openFromPalette('Plan');
    // The tree has opened the folders down to the open note.
    await user.click(await screen.findByRole('button', { name: copy.tree.deleteNoteLabel('Plan') }));
    await waitFor(() => expect(server.deleted).toEqual([['julian', PLAN]]));
    await waitFor(() => expect(screen.queryByTestId('editor')).toBeNull());
  });

  it('deletes nothing when cancelled', async () => {
    confirm.mockReturnValue(false);
    mount();
    await user.click(await screen.findByRole('button', { name: copy.tree.deleteNoteLabel('Loose') }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(server.deleted).toEqual([]);
    expect(screen.getByText('Loose')).toBeInTheDocument();
  });

  it('offers no bin on a note shared read-only', async () => {
    mount();
    await openFromPalette('Nur lesen');
    expect(screen.getAllByText('Nur lesen').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: copy.tree.deleteNoteLabel('Nur lesen') })).toBeNull();
    await openFromPalette('Gemeinsam');
    expect(await screen.findByRole('button', { name: copy.tree.deleteNoteLabel('Gemeinsam') })).toBeInTheDocument();
  });
});

describe('the inspector', () => {
  it('deletes the focused note after asking, and the focus ends', async () => {
    mount();
    await toNetwork();
    await user.click(screen.getByRole('button', { name: `pick julian/${PLAN}` }));
    const card = await screen.findByRole('region', { name: copy.inspector.label('Plan') });

    await user.click(within(card).getByRole('button', { name: copy.tree.deleteNoteLabel('Plan') }));

    await waitFor(() => expect(server.deleted).toEqual([['julian', PLAN]]));
    expect(confirm).toHaveBeenCalledWith(QUESTION_PLAN);
    await waitFor(() => expect(screen.queryByRole('region', { name: copy.inspector.label('Plan') })).toBeNull());
    // Still on the network, and the keyboard is back on the canvas rather than
    // on a button that no longer exists.
    expect(screen.getByTestId('brain')).toHaveFocus();
  });

  it('deletes nothing when cancelled, and keeps the focus', async () => {
    confirm.mockReturnValue(false);
    mount();
    await toNetwork();
    await user.click(screen.getByRole('button', { name: `pick julian/${PLAN}` }));
    const card = await screen.findByRole('region', { name: copy.inspector.label('Plan') });
    await user.click(within(card).getByRole('button', { name: copy.tree.deleteNoteLabel('Plan') }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(server.deleted).toEqual([]);
    expect(screen.getByRole('region', { name: copy.inspector.label('Plan') })).toBeInTheDocument();
  });

  it('offers no delete on a note shared read-only, and offers it on one shared writable', async () => {
    mount();
    await toNetwork();
    await user.click(screen.getByRole('button', { name: 'pick anna/Lesen/Nur lesen.md' }));
    const card = await screen.findByRole('region', { name: copy.inspector.label('Nur lesen') });
    expect(within(card).getByRole('button', { name: copy.inspector.open })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /^Delete / })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'pick anna/Team/Gemeinsam.md' }));
    const other = await screen.findByRole('region', { name: copy.inspector.label('Gemeinsam') });
    expect(within(other).getByRole('button', { name: copy.tree.deleteNoteLabel('Gemeinsam') })).toBeInTheDocument();
  });
});

describe('show in tree', () => {
  it('opens the folders to the note and marks it, without opening it or leaving the network', async () => {
    mount();
    await toNetwork();
    const tree = screen.getByRole('tree', { name: 'Notes' });
    expect(within(tree).queryByText('Plan')).toBeNull();

    await user.click(screen.getByRole('button', { name: `pick julian/${PLAN}` }));
    const card = await screen.findByRole('region', { name: copy.inspector.label('Plan') });
    await user.click(within(card).getByRole('button', { name: copy.inspector.reveal }));

    const row = (await within(tree).findByText('Plan')).closest('button')!;
    expect(row).toHaveAttribute('data-revealed', 'true');
    expect(row).toHaveAttribute('aria-current', 'false');
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(screen.getByTestId('brain')).toBeInTheDocument();
    expect(server.calls.links).toBe(0);
  });

  it('clears a filter that would hide the folders', async () => {
    mount();
    await toNetwork();
    const filter = screen.getByLabelText(copy.nav.filterLabel);
    await user.type(filter, 'Loose');
    const tree = screen.getByRole('tree', { name: 'Notes' });
    expect(within(tree).queryByText('Plan')).toBeNull();

    await user.click(screen.getByRole('button', { name: `pick julian/${PLAN}` }));
    await user.click(await screen.findByRole('button', { name: copy.inspector.reveal }));

    expect(filter).toHaveValue('');
    expect((await within(tree).findByText('Plan')).closest('button')).toHaveAttribute('data-revealed', 'true');
  });

  it('unfolds a folded sidebar', async () => {
    window.localStorage.setItem('ndbrain.prefs', JSON.stringify({ sidebarCollapsed: true }));
    mount();
    await toNetwork();
    expect(document.querySelector('.app')).toHaveAttribute('data-collapsed', 'true');

    await user.click(screen.getByRole('button', { name: `pick julian/${PLAN}` }));
    await user.click(await screen.findByRole('button', { name: copy.inspector.reveal }));

    await waitFor(() => expect(document.querySelector('.app')).toHaveAttribute('data-collapsed', 'false'));
    const tree = await screen.findByRole('tree', { name: 'Notes' });
    expect((await within(tree).findByText('Plan')).closest('button')).toHaveAttribute('data-revealed', 'true');
  });

  it('opens the drawer on a phone', async () => {
    narrowScreen(true);
    mount();
    await toNetwork();
    expect(document.querySelector('.app')).toHaveAttribute('data-drawer', 'false');

    await user.click(screen.getByRole('button', { name: `pick julian/${PLAN}` }));
    await user.click(await screen.findByRole('button', { name: copy.inspector.reveal }));

    expect(document.querySelector('.app')).toHaveAttribute('data-drawer', 'true');
    const tree = screen.getByRole('tree', { name: 'Notes' });
    expect((await within(tree).findByText('Plan')).closest('button')).toHaveAttribute('data-revealed', 'true');
  });

  it('lets go of the mark once a note is opened', async () => {
    mount();
    await toNetwork();
    await user.click(screen.getByRole('button', { name: `pick julian/${PLAN}` }));
    await user.click(await screen.findByRole('button', { name: copy.inspector.reveal }));
    const tree = screen.getByRole('tree', { name: 'Notes' });
    await within(tree).findByText('Plan');
    expect(tree.querySelector('[data-revealed]')).not.toBeNull();

    await user.click(within(tree).getByText('Loose'));
    await screen.findByTestId('editor');
    expect(tree.querySelector('[data-revealed]')).toBeNull();
  });
});

describe('races around saving and deleting', () => {
  const settle = advance;
  const typeInEditor = (): Promise<void> =>
    user.click(within(screen.getByTestId('editor')).getByRole('button', { name: 'type' }));
  const askToDelete = async (): Promise<void> => {
    await user.click(screen.getByRole('button', { name: copy.note.actions }));
    await user.click(screen.getByRole('menuitem', { name: copy.note.delete }));
  };
  /** The log, for a failure message that shows the order things happened in. */
  const order = (): string => server.log.join(' → ');

  it.each([
    ['the first answered OK, the second cancelled', [true, false]],
    ['the first cancelled, the second answered OK', [false, true]],
  ])('asked twice for the same note, %s: one question, and no save afterwards', async (_name, answers) => {
    const replies = [...answers];
    confirm.mockImplementation(() => replies.shift() ?? false);
    server.linksDelayMs = 300;
    server.deleteDelayMs = 900;
    mount();
    await openFromPalette('Plan');
    await typeInEditor();

    await askToDelete();
    await askToDelete();
    await waitFor(() => expect(confirm).toHaveBeenCalled(), { timeout: 2000 });
    await settle(1800);

    // The second request returned at once, without a question of its own.
    expect(confirm, order()).toHaveBeenCalledTimes(1);
    const deleted = answers[0] === true;
    if (deleted) {
      expect(server.log.filter((line) => line.startsWith('put-start')), order()).toEqual([]);
      expect(server.deleted).toEqual([['julian', PLAN]]);
    } else {
      // Cancelled first: the note stays, and its text is saved once.
      expect(server.deleted).toEqual([]);
      expect(server.written, order()).toEqual([['julian', PLAN]]);
    }
  });

  it('a switch while the links are counted, then a cancel: both notes keep their text, each against its own version', async () => {
    confirm.mockReturnValue(false);
    server.linksDelayMs = 1500;
    mount();
    await openFromPalette('Plan');
    await typeInEditor();
    await askToDelete();

    await switchTo('Loose', 'Loose.md');
    await typeInEditor();
    await waitFor(() => expect(confirm).toHaveBeenCalled(), { timeout: 3000 });
    await waitFor(() => expect(server.writes).toHaveLength(2), { timeout: 3000 });

    expect([...server.writes].sort((a, b) => a.path.localeCompare(b.path)), order()).toEqual([
      { path: 'Loose.md', base: '222' },
      { path: PLAN, base: '111' },
    ]);

    // The held write answered while Loose was open; Loose goes on from its own version.
    await typeInEditor();
    await waitFor(() => expect(server.writes).toHaveLength(3), { timeout: 2000 });
    expect(server.writes[2], order()).toEqual({ path: 'Loose.md', base: '1222' });
  });

  it('a second save of the same note waits for the first, and starts from the version it produced', async () => {
    server.putDelayMs = 900;
    mount();
    await openFromPalette('Plan');
    await typeInEditor();
    await waitFor(() => expect(server.log).toContain(`put-start ${PLAN}`), { timeout: 2000 });
    await typeInEditor();
    await waitFor(() => expect(server.writes).toHaveLength(2), { timeout: 4000 });
    await waitFor(() => expect(server.log.filter((l) => l === `put-end ${PLAN}`)).toHaveLength(2), { timeout: 4000 });
    expect(server.log, order()).toEqual([
      `get ${PLAN}`,
      `put-start ${PLAN}`,
      `put-end ${PLAN}`,
      `put-start ${PLAN}`,
      `put-end ${PLAN}`,
    ]);
    expect(server.writes[1]).toEqual({ path: PLAN, base: '1111' });
  });

  it('a switch while the links are counted, then a cancel, no typing: the held text is saved against its own version', async () => {
    confirm.mockReturnValue(false);
    server.linksDelayMs = 1200;
    mount();
    await openFromPalette('Plan');
    await typeInEditor();
    await askToDelete();
    await switchTo('Loose', 'Loose.md');
    await waitFor(() => expect(confirm).toHaveBeenCalled(), { timeout: 3000 });
    await waitFor(() => expect(server.writes).toHaveLength(1), { timeout: 2000 });
    expect(server.writes, order()).toEqual([{ path: PLAN, base: '111' }]);
  });

  it('a slow delete does not close the note opened meanwhile', async () => {
    server.deleteDelayMs = 900;
    mount();
    await openFromPalette('Plan');
    await askToDelete();
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    await switchTo('Loose', 'Loose.md');
    await waitFor(() => expect(server.deleted).toEqual([['julian', PLAN]]), { timeout: 3000 });
    await settle(100);
    expect(screen.queryByTestId('editor'), order()).not.toBeNull();
    expect(screen.getByTestId('editor')).toHaveTextContent('Loose.md');
  });

  it('reopening a note whose save is still running reads it after the save, and saves on from that version', async () => {
    server.putDelayMs = 600;
    mount();
    await openFromPalette('Plan');
    await typeInEditor();
    // The debounce fires and the save starts.
    await waitFor(() => expect(server.log).toContain(`put-start ${PLAN}`), { timeout: 2000 });

    await switchTo('Loose', 'Loose.md');
    await switchTo('Plan', PLAN);
    await waitFor(() => expect(server.log).toContain(`put-end ${PLAN}`), { timeout: 2000 });

    const lastGet = server.log.lastIndexOf(`get ${PLAN}`);
    expect(server.log.indexOf(`put-end ${PLAN}`), order()).toBeLessThan(lastGet);

    // The next save starts from the version the reopened editor was read at.
    server.putDelayMs = 0;
    await typeInEditor();
    await waitFor(() => expect(server.writes).toHaveLength(2), { timeout: 2000 });
    expect(server.writes[1], order()).toEqual({ path: PLAN, base: '1111' });
  });

  it('a save that answers after the switch does not become the version of the note now open', async () => {
    server.putDelayMs = 1500;
    mount();
    await openFromPalette('Plan');
    await typeInEditor();
    await waitFor(() => expect(server.log).toContain(`put-start ${PLAN}`), { timeout: 2000 });
    await switchTo('Loose', 'Loose.md');
    server.putDelayMs = 0;
    await waitFor(() => expect(server.log).toContain(`put-end ${PLAN}`), { timeout: 3000 });
    await typeInEditor();
    await waitFor(() => expect(server.writes).toHaveLength(2), { timeout: 3000 });
    expect(server.writes[1], order()).toEqual({ path: 'Loose.md', base: '222' });
  });

  it('a delete asked during a running save starts only after the save has answered', async () => {
    server.putDelayMs = 1500;
    mount();
    await openFromPalette('Plan');
    await typeInEditor();
    await waitFor(() => expect(server.log).toContain(`put-start ${PLAN}`), { timeout: 2000 });
    await askToDelete();
    await waitFor(() => expect(server.log).toContain(`delete-start ${PLAN}`), { timeout: 4000 });
    await waitFor(() => expect(server.log).toContain(`put-end ${PLAN}`), { timeout: 4000 });
    expect(server.log.indexOf(`put-end ${PLAN}`), order()).toBeLessThan(server.log.indexOf(`delete-start ${PLAN}`));
  });
});

describe('a save of a note that was renamed meanwhile', () => {
  it('says what happened and keeps the text, rather than failing with the server’s words', async () => {
    mount();
    await openFromPalette('Plan');
    server.putMissing = true;
    await user.click(within(screen.getByTestId('editor')).getByRole('button', { name: 'type' }));
    await waitFor(() => expect(server.writes).toHaveLength(1));

    expect(await screen.findByText(copy.errors.noteMovedWhileSaving)).toBeInTheDocument();
    expect(screen.queryByText('note does not exist')).toBeNull();
    expect(screen.getByText(copy.save.failed)).toBeInTheDocument();
    // Still open, and the text is where the crash box would find it.
    expect(screen.getByTestId('editor')).toHaveTextContent(PLAN);
    expect(window.__ndbrainPending).toEqual({ path: PLAN, content: 'typed, not yet saved' });
  });
});
