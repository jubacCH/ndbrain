/**
 * Starting a note, which is the first thing this product ever asks anybody.
 *
 * Behind a very good first-run line in the tree — "Start your first note" —
 * sat a `window.prompt`. An unstyled system box with the operating system's
 * typeface on it, no theme, no validation, no folder, and one line of
 * instruction about typing a slash. It was the first interaction a new account
 * had, and the only one in the product that looked like it belonged to another
 * program.
 *
 * `RenameDialog.tsx` had already decided what the answer looks like: a dialog
 * of this application's own, the folder *picked* from the vault's folders
 * rather than typed from memory, and the resulting path shown before anything
 * happens. This is the same dialog for the other direction.
 *
 * What is pinned here:
 *
 *  - every door to it — the sidebar, the palette, the tree's first-run line,
 *    a space's own header — opens the dialog, and no native prompt is opened
 *    anywhere along the way
 *  - the folder is picked, and the path that will be written is shown first
 *  - a slash in the name still nests, as the prompt allowed, and the dialog
 *    says which folder that brings into being
 *  - a name the server would refuse is refused here, before the request: the
 *    four characters no `[[wikilink]]` can hold, and a path already taken
 *  - in a space, only the folders that may be written are offered, and a path
 *    outside them is said here rather than found out from a refusal
 *  - it is a dialog for a keyboard too: Escape closes it, the focus goes back
 *
 * `window.prompt` is deliberately left unstubbed in most of these. jsdom has no
 * implementation, so a prompt that is still reached throws rather than quietly
 * returning null — which is exactly the signal wanted.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NoteRow, Share, User } from '../src/api';
import { App } from '../src/App';
import { copy } from '../src/copy';

vi.mock('../src/Brain', () => ({ Brain: () => <canvas data-testid="brain" /> }));
vi.mock('../src/Editor', () => ({
  Editor: (props: { path: string }) => <div data-testid="editor" data-path={props.path} />,
}));
vi.mock('../src/Context', () => ({ ContextPanel: () => <div /> }));

const server = vi.hoisted(() => ({
  signedIn: null as User | null,
  notes: [] as NoteRow[],
  dirs: [] as Array<{ owner: string; path: string }>,
  received: [] as Share[],
  /** Who the vaults belong to; a space is named and drawn as one. */
  owners: [] as Array<{ id: string; kind: 'person' | 'space'; displayName: string }>,
  /** Every note written, so a dialog that sent nothing can be told from one that did. */
  written: [] as Array<{ owner: string; path: string }>,
}));

vi.mock('../src/api', async (original) => {
  const real = await original<typeof import('../src/api')>();
  const fake: Record<string, (...args: never[]) => Promise<unknown>> = {
    me: async () => ({ user: server.signedIn }),
    tree: async () => ({ notes: server.notes, dirs: server.dirs, owners: server.owners }),
    shares: async () => ({ granted: [], received: server.received }),
    tags: async () => ({ tags: [] }),
    pulse: async () => ({ events: [], now: 1 }),
    propKeys: async () => ({ props: [] }),
    graph: async () => ({ nodes: [], edges: [] }),
    quickFind: async () => ({ notes: [] }),
    links: async () => ({ backlinks: [], outgoing: [] }),
    getNote: async (owner: string, path: string) => ({
      owner,
      canWrite: true,
      note: { path, title: path, content: '', size: 0, mtimeMs: 1 },
    }),
    putNote: async (owner: string, path: string, content: string) => {
      server.written.push({ owner, path });
      server.notes = [...server.notes, rowOf(owner, path)];
      return { note: { path, title: path, content, size: 0, mtimeMs: 2 }, created: true };
    },
  };
  const api = new Proxy(fake, { get: (target, key: string) => target[key] ?? (() => new Promise(() => {})) });
  return { ...real, api };
});

function rowOf(owner: string, path: string): NoteRow {
  return { owner, path, title: path.split('/').pop()!.replace(/\.md$/, ''), size: 1, mtimeMs: 0 };
}

let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  user = userEvent.setup();
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
  server.dirs = [];
  server.received = [];
  server.owners = [];
  server.written = [];
});

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

function mount(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

/**
 * The sidebar's own "New note" button, at the foot of the nav.
 *
 * Named apart from the tree's first-run button, which sits in the same
 * landmark under the same words: the sidebar's is the icon whose name comes
 * from its `aria-label`, the tree's has the words as its text.
 */
function newNoteButton(nav: HTMLElement): HTMLElement {
  const all = within(nav).getAllByRole('button', { name: copy.nav.newNote });
  return all.find((one) => one.getAttribute('aria-label') === copy.nav.newNote)!;
}

async function fromSidebar(): Promise<HTMLElement> {
  const nav = await screen.findByRole('navigation', { name: copy.nav.label });
  await user.click(newNoteButton(nav));
  return screen.findByRole('dialog', { name: copy.newNote.title });
}

/** Fills the dialog in and submits it. */
async function start(dialog: HTMLElement, name: string, folder?: string): Promise<void> {
  await user.clear(within(dialog).getByLabelText(copy.newNote.name));
  await user.type(within(dialog).getByLabelText(copy.newNote.name), name);
  if (folder !== undefined) {
    await user.selectOptions(within(dialog).getByLabelText(copy.newNote.folder), folder);
  }
  await user.click(within(dialog).getByRole('button', { name: copy.newNote.submit }));
}

describe('starting a note in your own vault', () => {
  it('opens a dialog of this application, never a system prompt', async () => {
    const prompt = vi.fn(() => null);
    vi.stubGlobal('prompt', prompt);
    mount();

    const dialog = await fromSidebar();
    expect(prompt).not.toHaveBeenCalled();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.activeElement).toBe(within(dialog).getByLabelText(copy.newNote.name));
  });

  it('writes the note at the name typed and opens it', async () => {
    mount();
    const dialog = await fromSidebar();
    await start(dialog, 'Backup plan');

    await waitFor(() => expect(server.written).toEqual([{ owner: 'julian', path: 'Backup plan.md' }]));
    expect(await screen.findByTestId('editor')).toHaveAttribute('data-path', 'Backup plan.md');
    expect(screen.queryByRole('dialog', { name: copy.newNote.title })).toBeNull();
  });

  it('picks the folder from the vault rather than asking for it to be typed', async () => {
    server.notes = [rowOf('julian', 'Homelab/Proxmox.md'), rowOf('julian', 'Archive/Old.md')];
    mount();
    const dialog = await fromSidebar();

    const folder = within(dialog).getByLabelText(copy.newNote.folder);
    expect([...folder.querySelectorAll('option')].map((one) => one.textContent)).toEqual([
      copy.newNote.root,
      'Archive',
      'Homelab',
    ]);

    await start(dialog, 'Backup plan', 'Homelab');
    await waitFor(() => expect(server.written).toEqual([{ owner: 'julian', path: 'Homelab/Backup plan.md' }]));
  });

  it('shows the path it will write before it writes it', async () => {
    server.notes = [rowOf('julian', 'Homelab/Proxmox.md')];
    mount();
    const dialog = await fromSidebar();

    await user.type(within(dialog).getByLabelText(copy.newNote.name), 'Backup plan');
    await user.selectOptions(within(dialog).getByLabelText(copy.newNote.folder), 'Homelab');

    expect(within(dialog).getByText('Homelab/Backup plan.md')).toBeInTheDocument();
    expect(server.written).toEqual([]);
  });

  it('will not send an empty name', async () => {
    mount();
    const dialog = await fromSidebar();
    expect(within(dialog).getByRole('button', { name: copy.newNote.submit })).toBeDisabled();

    await user.type(within(dialog).getByLabelText(copy.newNote.name), '   ');
    expect(within(dialog).getByRole('button', { name: copy.newNote.submit })).toBeDisabled();
    expect(server.written).toEqual([]);
  });

  it('still nests on a slash, and says which folder that makes', async () => {
    mount();
    const dialog = await fromSidebar();

    await user.type(within(dialog).getByLabelText(copy.newNote.name), 'Homelab/Backup plan');
    expect(within(dialog).getByText(copy.newNote.makesFolder('Homelab'))).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: copy.newNote.submit }));
    await waitFor(() => expect(server.written).toEqual([{ owner: 'julian', path: 'Homelab/Backup plan.md' }]));
  });

  it('refuses a name no wikilink could point at, and sends nothing', async () => {
    mount();
    const dialog = await fromSidebar();

    // Set rather than typed: `user.type` reads `[` and `]` as key descriptors,
    // and the point here is the characters, not the typing.
    fireEvent.change(within(dialog).getByLabelText(copy.newNote.name), {
      target: { value: '[CT 110] phpIPAM' },
    });
    expect(within(dialog).getByText(copy.newNote.unlinkable)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: copy.newNote.submit })).toBeDisabled();
    expect(server.written).toEqual([]);
  });

  /*
   * The picked folder is the guarantee that the note lands somewhere the caller
   * may write, and a slash in the name only ever nests deeper inside it. `..`
   * is the one shape that could leave it again — the server refuses it, and
   * being refused after typing was the prompt's way of saying so.
   */
  it.each(['../Elsewhere/Note', '/Absolute', '.hidden'])('refuses “%s” before sending it', async (name) => {
    mount();
    const dialog = await fromSidebar();

    await user.type(within(dialog).getByLabelText(copy.newNote.name), name);
    expect(within(dialog).getByText(copy.newNote.badPath)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: copy.newNote.submit })).toBeDisabled();
    expect(server.written).toEqual([]);
  });

  it('says a path is taken before it sends it, not after', async () => {
    server.notes = [rowOf('julian', 'Homelab/Proxmox.md')];
    mount();
    const dialog = await fromSidebar();

    await user.type(within(dialog).getByLabelText(copy.newNote.name), 'Proxmox');
    await user.selectOptions(within(dialog).getByLabelText(copy.newNote.folder), 'Homelab');

    expect(within(dialog).getByText(copy.newNote.taken('Homelab/Proxmox.md'))).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: copy.newNote.submit })).toBeDisabled();
    expect(server.written).toEqual([]);
  });
});

describe('the other doors to it', () => {
  it('is what the tree offers a vault with nothing in it', async () => {
    mount();
    // The invitation's own button, not the sidebar's — they share a label.
    const invitation = (await screen.findByText(copy.tree.noNotes)).parentElement!;
    await user.click(within(invitation).getByRole('button', { name: copy.tree.noNotesAction }));

    const dialog = await screen.findByRole('dialog', { name: copy.newNote.title });
    await start(dialog, 'First note');
    await waitFor(() => expect(server.written).toEqual([{ owner: 'julian', path: 'First note.md' }]));
  });

  it('is what the palette command opens', async () => {
    mount();
    await screen.findByRole('button', { name: copy.shell.account });
    await user.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog', { name: copy.palette.label });
    await user.click(within(palette).getByRole('option', { name: new RegExp(`^${copy.nav.newNote}`) }));

    const dialog = await screen.findByRole('dialog', { name: copy.newNote.title });
    await start(dialog, 'From the palette');
    await waitFor(() => expect(server.written).toEqual([{ owner: 'julian', path: 'From the palette.md' }]));
  });
});

describe('starting a note in a space', () => {
  beforeEach(() => {
    server.owners = [
      { id: 'julian', kind: 'person', displayName: 'Julian' },
      { id: 'verein', kind: 'space', displayName: 'verein' },
    ];
    server.notes = [rowOf('verein', 'Protokolle/2026.md'), rowOf('verein', 'Kasse/Budget.md')];
    server.received = [
      {
        id: 's1',
        owner: 'verein',
        prefix: 'Protokolle/',
        grantee: 'julian',
        canWrite: true,
        createdAt: 0,
        kind: 'folder' as const,
      },
      {
        id: 's2',
        owner: 'verein',
        prefix: 'Kasse/',
        grantee: 'julian',
        canWrite: false,
        createdAt: 0,
        kind: 'folder' as const,
      },
    ];
  });

  /** The "+" on the space's own row in the tree. */
  async function fromSpace(): Promise<HTMLElement> {
    const nav = await screen.findByRole('navigation', { name: copy.nav.label });
    await user.click(await within(nav).findByRole('button', { name: copy.tree.newNoteIn('verein') }));
    return screen.findByRole('dialog', { name: copy.newNote.titleIn('verein') });
  }

  it('offers only the folders of that space the caller may write in', async () => {
    mount();
    const dialog = await fromSpace();

    const folder = within(dialog).getByLabelText(copy.newNote.folder);
    const offered = [...folder.querySelectorAll('option')].map((one) => one.textContent);
    expect(offered).toEqual(['Protokolle']);
    // Not the root of somebody else's vault, and not the folder shared for
    // reading: the server refuses both, and finding that out afterwards was the
    // prompt's behaviour.
    expect(offered).not.toContain(copy.newNote.root);
    expect(offered).not.toContain('Kasse');
  });

  it('writes into the space, at the folder picked', async () => {
    mount();
    const dialog = await fromSpace();
    await start(dialog, 'Sitzung Mai', 'Protokolle');

    await waitFor(() =>
      expect(server.written).toEqual([{ owner: 'verein', path: 'Protokolle/Sitzung Mai.md' }]),
    );
  });

  it('cannot be talked out of the writable folder with a slash', async () => {
    mount();
    const dialog = await fromSpace();

    // Deeper is allowed and stays inside the share; upwards is refused, which
    // is the only way the typed half could have left it.
    await user.type(within(dialog).getByLabelText(copy.newNote.name), '../Kasse/Budget 2027');
    expect(within(dialog).getByText(copy.newNote.badPath)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: copy.newNote.submit })).toBeDisabled();

    await user.clear(within(dialog).getByLabelText(copy.newNote.name));
    await user.type(within(dialog).getByLabelText(copy.newNote.name), '2026/Sitzung Mai');
    await user.click(within(dialog).getByRole('button', { name: copy.newNote.submit }));
    await waitFor(() =>
      expect(server.written).toEqual([{ owner: 'verein', path: 'Protokolle/2026/Sitzung Mai.md' }]),
    );
  });
});

describe('the dialog and the keyboard', () => {
  it('closes on Escape and hands the focus back to what opened it', async () => {
    mount();
    const nav = await screen.findByRole('navigation', { name: copy.nav.label });
    const button = newNoteButton(nav);
    await user.click(button);
    await screen.findByRole('dialog', { name: copy.newNote.title });

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: copy.newNote.title })).toBeNull());
    expect(document.activeElement).toBe(button);
    expect(server.written).toEqual([]);
  });

  it('keeps Tab inside itself', async () => {
    mount();
    const dialog = await fromSidebar();
    for (let press = 0; press < 12; press += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement), `after ${press + 1} tabs`).toBe(true);
    }
  });
});
