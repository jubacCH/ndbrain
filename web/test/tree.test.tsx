/**
 * The navigation, which is where a growing vault first becomes unusable.
 *
 * Measured on the real one: 72% of notes hung under a single branch, and the
 * tree opened everything by default — so reaching anything meant scrolling a
 * long alphabetical list. The three habits that fixed it are what these tests
 * pin down, because each of them is easy to undo by accident:
 *
 *  - it starts shut, and reveals the note you are actually on
 *  - typing filters, flat, each hit under its own path
 *  - numeric sort prefixes are hidden **in the display only** — the path on disk
 *    keeps its digits, and a test that let that slip would be a test that let
 *    every wikilink break
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Tree, displayName, displayPath } from '../src/Tree';
import { refKey, type NoteRow } from '../src/api';

function note(path: string): NoteRow {
  return {
    owner: 'julian',
    path,
    title: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''),
    size: 10,
    mtimeMs: 1_700_000_000_000,
  };
}

const NOTES = [
  note('20_Areas/21_Homelab/Proxmox Cluster.md'),
  note('20_Areas/21_Homelab/Hardware & NAS.md'),
  note('20_Areas/22_Selfhosted-Services/CT 104 — Paperless.md'),
  note('00_Inbox/Notiz.md'),
  note('Willkommen.md'),
];

function renderTree(props: Partial<Parameters<typeof Tree>[0]> = {}) {
  const onSelect = vi.fn();
  render(
    <Tree
      notes={NOTES}
      self="julian"
      received={[]}
      selected={null}
      findings={new Map()}
      filter=""
      hidePrefixes
      onSelect={onSelect}
      onRenameFolder={vi.fn()}
      {...props}
    />,
  );
  return { onSelect };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('sort prefixes', () => {
  it('hides a prefix that exists only to force an order', () => {
    expect(displayName('20_Areas')).toBe('Areas');
    expect(displayName('00_Inbox')).toBe('Inbox');
    expect(displayName('22_Selfhosted-Services')).toBe('Selfhosted-Services');
  });

  it('keeps digits that are the name rather than a sorting device', () => {
    // The rule is narrow on purpose: a date and a count are not sort prefixes.
    expect(displayName('2026-07-27')).toBe('2026-07-27');
    expect(displayName('100 Ideen')).toBe('100 Ideen');
    expect(displayName('3D-Druck')).toBe('3D-Druck');
  });

  it('reads a whole path the way the tree shows it', () => {
    expect(displayPath('20_Areas/21_Homelab/Proxmox Cluster.md')).toBe('Areas › Homelab');
  });
});

describe('the closed-by-default tree', () => {
  it('shows the top level only', () => {
    renderTree();

    expect(screen.getByText('Areas')).toBeInTheDocument();
    // A note three levels down must not be on screen before anything is opened.
    expect(screen.queryByText('Proxmox Cluster')).not.toBeInTheDocument();
  });

  it('says how much a shut folder is hiding', () => {
    renderTree();

    const areas = screen.getByText('Areas').closest('button');
    expect(within(areas!).getByText('3')).toBeInTheDocument();
  });

  it('opens on click and remembers it', async () => {
    const user = userEvent.setup();
    const { unmount } = { unmount: renderTree() && (() => undefined) };
    void unmount;

    await user.click(screen.getByText('Areas'));
    expect(screen.getByText('Homelab')).toBeInTheDocument();

    // Persisted, so the shape of the tree survives a reload — per account.
    expect(window.localStorage.getItem('ndbrain.openFolders.julian')).toContain('20_Areas');
  });

  it('reveals the note that is selected, however deep it sits', () => {
    // Opening a note from search, a link or the palette must not leave the tree
    // looking like it has lost track of where you are.
    renderTree({ selected: { owner: 'julian', path: '20_Areas/21_Homelab/Proxmox Cluster.md' } });

    expect(screen.getByText('Proxmox Cluster')).toBeInTheDocument();
  });
});

describe('the filter', () => {
  it('lists matches flat, each under its own path', () => {
    renderTree({ filter: 'proxmox' });

    expect(screen.getByText('Proxmox Cluster')).toBeInTheDocument();
    // The location is shown as read, not as stored.
    expect(screen.getByText('Areas › Homelab')).toBeInTheDocument();
    expect(screen.queryByText('Notiz')).not.toBeInTheDocument();
  });

  it('matches what is on screen, not only what is on disk', () => {
    // Somebody types what the tree shows them: "homelab", never "21_homelab".
    renderTree({ filter: 'homelab' });

    expect(screen.getByText('Proxmox Cluster')).toBeInTheDocument();
    expect(screen.getByText('Hardware & NAS')).toBeInTheDocument();
  });

  it('treats several words as all of them', () => {
    renderTree({ filter: 'homelab hardware' });

    expect(screen.getByText('Hardware & NAS')).toBeInTheDocument();
    expect(screen.queryByText('Proxmox Cluster')).not.toBeInTheDocument();
  });

  it('says so when nothing matches', () => {
    renderTree({ filter: 'zzgibtesnicht' });

    expect(screen.getByText('No match.')).toBeInTheDocument();
  });

  it('hands back the real path, digits and all', async () => {
    // The one that would break every wikilink if display and identity were ever
    // allowed to become the same string.
    const user = userEvent.setup();
    const { onSelect } = renderTree({ filter: 'proxmox' });

    await user.click(screen.getByText('Proxmox Cluster'));

    expect(onSelect).toHaveBeenCalledWith('julian', '20_Areas/21_Homelab/Proxmox Cluster.md');
  });
});

describe('findings', () => {
  const marked = '20_Areas/21_Homelab/Proxmox Cluster.md';

  it('marks a note that has one', () => {
    renderTree({
      filter: 'proxmox',
      findings: new Map([[refKey('julian', marked), 'crit' as const]]),
    });

    expect(document.querySelector('.st-crit')).not.toBeNull();
  });

  it('keys the marker by vault as well as path', () => {
    // A marker keyed by path alone would light up a note of the same name in
    // somebody else's shared vault. Same path, wrong owner: no marker at all.
    renderTree({
      filter: 'proxmox',
      findings: new Map([[refKey('ramona', marked), 'crit' as const]]),
    });

    expect(document.querySelector('.st-crit')).toBeNull();
  });
});

describe('keyboard navigation', () => {
  // Measured before this existed: zero key handlers, so every row was its own
  // tab stop — sixty presses to cross the sidebar, and no way to open a folder
  // without a mouse. The ARIA tree pattern fixes both with roving tabindex.

  it('is a single tab stop, however many rows are showing', async () => {
    const user = userEvent.setup();
    renderTree();

    // Opened two deep, so the count is well past the three top-level rows.
    await user.click(screen.getByText('Areas').closest('button')!);
    await user.click(screen.getByText('Homelab').closest('button')!);

    const rows = screen.getAllByRole('treeitem');
    const reachable = rows.filter((b) => b.getAttribute('tabindex') === '0');

    expect(rows.length).toBeGreaterThan(3);
    expect(reachable).toHaveLength(1);
  });

  it('moves down and up with the arrow keys', async () => {
    const user = userEvent.setup();
    renderTree();

    // The fixture's top level, in the order buildTree sorts it: 00_Inbox,
    // 20_Areas, then the loose note.
    const first = screen.getByText('Inbox').closest('button')!;
    first.focus();

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByText('Areas').closest('button'));

    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(first);
  });

  it('opens a folder with the right arrow and closes it with the left', async () => {
    const user = userEvent.setup();
    renderTree();

    screen.getByText('Areas').closest('button')!.focus();
    expect(screen.queryByText('Homelab')).not.toBeInTheDocument();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByText('Homelab')).toBeInTheDocument();

    await user.keyboard('{ArrowLeft}');
    expect(screen.queryByText('Homelab')).not.toBeInTheDocument();
  });

  it('steps into an already open folder with the right arrow', async () => {
    const user = userEvent.setup();
    renderTree();

    const areas = screen.getByText('Areas').closest('button')!;
    areas.focus();
    await user.keyboard('{ArrowRight}'); // opens
    await user.keyboard('{ArrowRight}'); // steps in

    expect(document.activeElement).toBe(screen.getByText('Homelab').closest('button'));
  });

  it('jumps to the ends with Home and End', async () => {
    const user = userEvent.setup();
    renderTree();

    const rows = () => screen.getAllByRole('treeitem');

    rows()[2]!.focus();
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(rows()[rows().length - 1]);

    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(rows()[0]);
  });
});

describe('the first screen a new account sees', () => {
  it('names the action rather than reporting an absence', () => {
    const onCreateFirst = vi.fn();
    render(
      <Tree
        notes={[]}
        self="julian"
        received={[]}
        selected={null}
        findings={new Map()}
        filter=""
        hidePrefixes
        onSelect={vi.fn()}
        onRenameFolder={vi.fn()}
        onCreateFirst={onCreateFirst}
      />,
    );

    // Carbon's anatomy: an action title, a line on what it gets you, one control.
    expect(screen.getByText(/Start your first note/i)).toBeInTheDocument();
    expect(screen.getByText(/link to each other/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New note/i })).toBeInTheDocument();
  });

  it('offers the action, not just the words', async () => {
    const user = userEvent.setup();
    const onCreateFirst = vi.fn();
    render(
      <Tree
        notes={[]}
        self="julian"
        received={[]}
        selected={null}
        findings={new Map()}
        filter=""
        hidePrefixes
        onSelect={vi.fn()}
        onRenameFolder={vi.fn()}
        onCreateFirst={onCreateFirst}
      />,
    );

    await user.click(screen.getByRole('button', { name: /New note/i }));
    expect(onCreateFirst).toHaveBeenCalledTimes(1);
  });
});

describe('deleting a note', () => {
  const SHARED: NoteRow[] = [
    { owner: 'anna', path: 'Lesen/Nur lesen.md', title: 'Nur lesen', size: 1, mtimeMs: 0 },
    { owner: 'anna', path: 'Team/Gemeinsam.md', title: 'Gemeinsam', size: 1, mtimeMs: 0 },
  ];
  const RECEIVED = [
    { id: 's1', owner: 'anna', prefix: 'Lesen/', grantee: 'julian', canWrite: false, createdAt: 0, kind: 'folder' as const },
    { id: 's2', owner: 'anna', prefix: 'Team/', grantee: 'julian', canWrite: true, createdAt: 0, kind: 'folder' as const },
  ];

  it('offers a bin on a note of your own, which hands the note to the shell', async () => {
    const onDeleteNote = vi.fn();
    const { onSelect } = renderTree({ onDeleteNote });

    await userEvent.click(screen.getByRole('button', { name: 'Delete Willkommen' }));

    expect(onDeleteNote).toHaveBeenCalledWith('julian', 'Willkommen.md', 'Willkommen');
    // Deleting is not opening.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('offers no bin on a folder, and none at all without a handler', () => {
    const first = render(
      <Tree
        notes={NOTES}
        self="julian"
        received={[]}
        selected={null}
        findings={new Map()}
        filter=""
        hidePrefixes
        onSelect={vi.fn()}
        onRenameFolder={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /^Delete / })).toBeNull();
    first.unmount();

    renderTree({ onDeleteNote: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Delete Areas' })).toBeNull();
    // Willkommen is the only note at the top level; the rest sit in shut folders.
    expect(screen.getAllByRole('button', { name: /^Delete / })).toHaveLength(1);
  });

  it('deletes the focused note with the Delete key, and does nothing on a folder', async () => {
    const user = userEvent.setup();
    const onDeleteNote = vi.fn();
    renderTree({ onDeleteNote });

    // Top level in order: 00_Inbox, 20_Areas, Willkommen.
    screen.getByText('Inbox').closest('button')!.focus();
    await user.keyboard('{Delete}');
    expect(onDeleteNote).not.toHaveBeenCalled();

    await user.keyboard('{End}');
    expect(screen.getByText('Willkommen').closest('button')).toHaveFocus();
    // A bare Backspace is too easy to press by accident.
    await user.keyboard('{Backspace}');
    expect(onDeleteNote).not.toHaveBeenCalled();
    await user.keyboard('{Delete}');
    expect(onDeleteNote).toHaveBeenCalledWith('julian', 'Willkommen.md', 'Willkommen');
    await user.keyboard('{Meta>}{Backspace}{/Meta}');
    expect(onDeleteNote).toHaveBeenCalledTimes(2);
  });

  it('keeps the tree a single tab stop: the bins are not in the tab order', () => {
    renderTree({ onDeleteNote: vi.fn() });
    const bins = screen.getAllByRole('button', { name: /^Delete / });
    expect(bins.every((b) => b.getAttribute('tabindex') === '-1')).toBe(true);
    expect(screen.getByText('Willkommen').closest('button')).toHaveAttribute('aria-keyshortcuts', 'Delete Meta+Backspace');
  });

  it('offers nothing on a note shared read-only, by bin or by key, and both on a writable share', async () => {
    const user = userEvent.setup();
    const onDeleteNote = vi.fn();
    renderTree({ notes: [...NOTES, ...SHARED], received: RECEIVED, onDeleteNote });
    await user.click(screen.getByText('Lesen'));
    await user.click(screen.getByText('Team'));

    expect(screen.queryByRole('button', { name: 'Delete Nur lesen' })).toBeNull();
    screen.getByText('Nur lesen').closest('button')!.focus();
    await user.keyboard('{Delete}');
    expect(onDeleteNote).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete Gemeinsam' }));
    expect(onDeleteNote).toHaveBeenCalledWith('anna', 'Team/Gemeinsam.md', 'Gemeinsam');
  });
});

describe('showing a note without opening it', () => {
  const base = {
    notes: NOTES,
    self: 'julian',
    received: [],
    selected: null,
    findings: new Map<string, 'crit' | 'warn'>(),
    filter: '',
    hidePrefixes: true,
    onRenameFolder: vi.fn(),
  };

  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('opens the folders above it, marks the row and scrolls to it, without selecting it', () => {
    const onSelect = vi.fn();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(
      <Tree
        {...base}
        onSelect={onSelect}
        revealed={{ owner: 'julian', path: '20_Areas/21_Homelab/Proxmox Cluster.md', seq: 1 }}
      />,
    );

    const row = screen.getByText('Proxmox Cluster').closest('button')!;
    expect(row).toHaveAttribute('data-revealed', 'true');
    expect(row).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('Areas').closest('button')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Homelab').closest('button')).toHaveAttribute('aria-expanded', 'true');
    expect(document.querySelectorAll('[data-revealed]')).toHaveLength(1);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(row);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('scrolls once per request, and again when the same note is asked for a second time', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { rerender } = render(<Tree {...base} onSelect={vi.fn()} revealed={{ owner: 'julian', path: 'Willkommen.md', seq: 1 }} />);
    rerender(<Tree {...base} onSelect={vi.fn()} revealed={{ owner: 'julian', path: 'Willkommen.md', seq: 1 }} />);
    expect(scroll).toHaveBeenCalledTimes(1);
    rerender(<Tree {...base} onSelect={vi.fn()} revealed={{ owner: 'julian', path: 'Willkommen.md', seq: 2 }} />);
    expect(scroll).toHaveBeenCalledTimes(2);
  });
});

/**
 * The container said `role="tree"` and held not one `treeitem`.
 *
 * A screen reader that is told it is in a tree then asks the rows how deep they
 * are and which one is selected, and got nothing back: the rows were plain
 * buttons in plain list items, the nesting was invisible, and the open note was
 * marked with `aria-current` — a link's word, not a tree's.
 */
describe('the tree says it is a tree', () => {
  it('makes every row a treeitem that carries its depth', async () => {
    const user = userEvent.setup();
    renderTree();

    const areas = screen.getByText('Areas').closest('button')!;
    expect(areas).toHaveAttribute('role', 'treeitem');
    expect(areas).toHaveAttribute('aria-level', '1');

    await user.click(areas);
    const homelab = screen.getByText('Homelab').closest('button')!;
    expect(homelab).toHaveAttribute('role', 'treeitem');
    expect(homelab).toHaveAttribute('aria-level', '2');

    await user.click(homelab);
    const note = screen.getByText('Proxmox Cluster').closest('button')!;
    expect(note).toHaveAttribute('role', 'treeitem');
    expect(note).toHaveAttribute('aria-level', '3');
  });

  it('groups the children of an open folder, so the nesting is not only visual', async () => {
    const user = userEvent.setup();
    renderTree();

    expect(document.querySelectorAll('ul[role="group"]')).toHaveLength(0);
    await user.click(screen.getByText('Areas').closest('button')!);

    const group = document.querySelector('ul[role="group"]');
    expect(group).not.toBeNull();
    expect(within(group as HTMLElement).getByText('Homelab')).toBeInTheDocument();
  });

  it('marks the open note as the selected item of the tree', () => {
    // Filtered, so two notes are on screen at once without opening anything.
    renderTree({ filter: 'o', selected: { owner: 'julian', path: '00_Inbox/Notiz.md' } });

    expect(screen.getByText('Notiz').closest('button')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Proxmox Cluster').closest('button')).toHaveAttribute('aria-selected', 'false');
  });

  it('keeps the tree one landmark, whatever it holds', () => {
    renderTree();
    expect(screen.getAllByRole('tree')).toHaveLength(1);
  });
});

/**
 * Roving tabindex has to rove.
 *
 * `move()` called `.focus()` and left the tab stop where it started, so Tab out
 * of the tree and back in put you on row one again — the state every roving
 * tabindex exists to avoid, and the one nobody notices until they try it.
 */
describe('the tree remembers where the keyboard was', () => {
  it('hands the single tab stop to whichever row was last focused', async () => {
    const user = userEvent.setup();
    renderTree();

    screen.getByText('Inbox').closest('button')!.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    const landed = document.activeElement as HTMLElement;
    expect(landed).not.toBe(screen.getByText('Inbox').closest('button'));

    // Out of the tree and back: the way in is the tab stop, and it is here.
    landed.blur();
    await user.tab();
    expect(document.activeElement).toBe(landed);
  });

  it('is still a single tab stop after the focus has moved', async () => {
    const user = userEvent.setup();
    renderTree();

    screen.getByText('Inbox').closest('button')!.focus();
    await user.keyboard('{ArrowDown}');

    const seats = [...document.querySelectorAll('button.node')].filter((b) => b.getAttribute('tabindex') === '0');
    expect(seats).toHaveLength(1);
    expect(seats[0]).toBe(document.activeElement);
  });
});

/**
 * The folder pencil was the last row control still in the tab order.
 *
 * The note rows' three actions were taken out of it and given keys instead, and
 * the folder's rename was left behind — so Tab still walked the whole tree, one
 * folder at a time. It follows the same rule now: out of the tab order, and F2
 * on the focused row, which is what the note rows already promise.
 */
describe('renaming a folder from the keyboard', () => {
  it('keeps the folder pencil out of the tab order', () => {
    renderTree();
    const pencils = screen.getAllByRole('button', { name: /^Rename / });
    expect(pencils.length).toBeGreaterThan(0);
    expect(pencils.every((b) => b.getAttribute('tabindex') === '-1')).toBe(true);
  });

  it('renames the focused folder on F2', async () => {
    const user = userEvent.setup();
    const onRenameFolder = vi.fn();
    renderTree({ onRenameFolder });

    screen.getByText('Areas').closest('button')!.focus();
    await user.keyboard('{F2}');

    expect(onRenameFolder).toHaveBeenCalledWith('20_Areas');
  });

  it('says so on the row, so the key is not a secret', () => {
    renderTree();
    expect(screen.getByText('Areas').closest('button')).toHaveAttribute('aria-keyshortcuts', 'F2');
  });

  it("offers neither the pencil nor the key on somebody else's folder", async () => {
    const user = userEvent.setup();
    const onRenameFolder = vi.fn();
    renderTree({
      notes: [...NOTES, { owner: 'anna', path: 'Team/Gemeinsam.md', title: 'Gemeinsam', size: 1, mtimeMs: 0 }],
      received: [
        { id: 's1', owner: 'anna', prefix: 'Team/', grantee: 'julian', canWrite: true, createdAt: 0, kind: 'folder' as const },
      ],
      onRenameFolder,
    });

    const team = screen.getByText('Team').closest('button')!;
    expect(team).not.toHaveAttribute('aria-keyshortcuts');
    team.focus();
    await user.keyboard('{F2}');
    expect(onRenameFolder).not.toHaveBeenCalled();
  });
});
