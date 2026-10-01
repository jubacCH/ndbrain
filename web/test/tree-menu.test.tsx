/**
 * The right-click menu on a row of the tree.
 *
 * Most of what it offers, the row could already do — renaming was F2, deleting
 * was Delete, and both were named in `aria-keyshortcuts` and in no other place
 * somebody would look. So what these pin is that the menu offers exactly what
 * that row is allowed to do and nothing else: a row the caller may only read
 * must not grow entries, and a folder in a space must offer the two creating
 * entries, which is the thing that was impossible before.
 *
 * `contextmenu` is dispatched rather than typed. The browser raises it for the
 * right button, for the keyboard's menu key and for Shift+F10 alike, and
 * `userEvent` has no gesture for any of them — so the event is the honest unit
 * to test against, and it is the same event all three produce.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NoteRow, OwnerInfo, Share } from '../src/api';
import { copy } from '../src/copy';
import { OwnersContext, ownerDirectory, ownerKind } from '../src/owners';
import { mayShare } from '../src/rights';
import { Tree, type TreeProps } from '../src/Tree';

function row(owner: string, path: string): NoteRow {
  return { owner, path, title: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''), size: 1, mtimeMs: 0 };
}

function share(owner: string, kind: Share['kind'], prefix: string, canWrite: boolean): Share {
  return { id: `${owner}:${prefix}`, owner, prefix, grantee: 'julian', canWrite, createdAt: 0, kind };
}

const OWNERS: OwnerInfo[] = [
  { id: 'julian', kind: 'person', displayName: 'Julian' },
  { id: 'anna', kind: 'person', displayName: 'Anna' },
  { id: 'verein', kind: 'space', displayName: 'Verein' },
];

const NOTES = [
  row('julian', 'Projekte/Plan.md'),
  row('verein', 'Sitzungen/Protokoll.md'),
  // Anna's vault is readable and nothing in it may be changed — a note at the
  // top and a folder, because the two rows ask different questions of the
  // rights and only one of them was being asked.
  row('anna', 'Einkauf.md'),
  row('anna', 'Listen/Wocheneinkauf.md'),
];

const RECEIVED = [
  share('anna', 'vault', '', false),
  share('verein', 'vault', '', true),
];

const directory = ownerDirectory(OWNERS);

function renderTree(props: Partial<TreeProps> = {}) {
  const user = { id: 'julian', role: 'user' as const };
  return render(
    <OwnersContext.Provider value={directory}>
      <Tree
        notes={NOTES}
        self="julian"
        received={RECEIVED}
        selected={null}
        findings={new Map()}
        filter=""
        hidePrefixes
        onSelect={vi.fn()}
        onRenameFolder={vi.fn()}
        onRenameNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onShareNote={vi.fn()}
        onNewNoteIn={vi.fn()}
        onNewFolderIn={vi.fn()}
        mayShareNote={(owner) => mayShare(user, owner, ownerKind(directory, owner))}
        {...props}
      />
    </OwnersContext.Provider>,
  );
}

/** Right-clicks a row and hands back the menu, or null where none opened. */
function rightClick(target: HTMLElement): HTMLElement | null {
  fireEvent.contextMenu(target, { clientX: 40, clientY: 80 });
  return screen.queryByRole('menu');
}

const labels = (menu: HTMLElement): string[] =>
  within(menu)
    .getAllByRole('menuitem')
    .map((item) => item.textContent ?? '');

/** Opens a folder row by name, so what is under it is on screen. */
async function openFolder(name: string): Promise<HTMLElement> {
  const folder = screen.getByRole('treeitem', { name: new RegExp(name) });
  await userEvent.click(folder);
  return folder;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('the menu on a note', () => {
  it('offers what the row already did, on a note the caller may change', async () => {
    renderTree();
    await openFolder('Projekte');
    const menu = rightClick(screen.getByRole('treeitem', { name: /Plan/ }));

    expect(menu).not.toBeNull();
    expect(labels(menu!)).toEqual([copy.tree.menu.rename, copy.tree.menu.share, copy.tree.menu.delete]);
  });

  it('runs the entry that was chosen', async () => {
    const onDeleteNote = vi.fn();
    renderTree({ onDeleteNote });
    await openFolder('Projekte');
    const menu = rightClick(screen.getByRole('treeitem', { name: /Plan/ }));

    await userEvent.click(within(menu!).getByRole('menuitem', { name: copy.tree.menu.delete }));
    expect(onDeleteNote).toHaveBeenCalledWith('julian', 'Projekte/Plan.md', 'Plan');
    // And it goes once it has been used.
    expect(screen.queryByRole('menu')).toBeNull();
  });

  /**
   * The case that decides whether this is a menu or a decoration.
   *
   * Anna's vault is shared for reading. A menu offering "Rename" there would be
   * a promise the server refuses, and one offering nothing would be an empty
   * box over her note — so the browser's own menu is left alone instead.
   */
  it('does not open at all on a note the caller may only read', () => {
    renderTree();
    expect(rightClick(screen.getByRole('treeitem', { name: /Einkauf/ }))).toBeNull();
  });
});

describe('the menu on a folder', () => {
  it('offers both creating entries and the rename, in the caller’s own vault', async () => {
    renderTree();
    const folder = screen.getByRole('treeitem', { name: /Projekte/ });
    const menu = rightClick(folder);

    expect(labels(menu!)).toEqual([
      copy.tree.menu.newNote,
      copy.tree.menu.newFolder,
      copy.tree.menu.rename,
    ]);
  });

  /**
   * The defect this was written for.
   *
   * A folder in a space could not be made at all: the client's `createFolder`
   * sent no owner, so the request went to the caller's own vault whatever row
   * was asked for. The entry has to be here, and it has to name the space.
   */
  it('offers a folder inside a space the caller may write', async () => {
    const onNewFolderIn = vi.fn();
    renderTree({ onNewFolderIn });
    const folder = screen.getByRole('treeitem', { name: /Sitzungen/ });
    const menu = rightClick(folder);

    await userEvent.click(within(menu!).getByRole('menuitem', { name: copy.tree.menu.newFolder }));
    expect(onNewFolderIn).toHaveBeenCalledWith('verein', 'Sitzungen');
  });

  /**
   * A folder move relocates everything under it, and a shared region is a part
   * of somebody's vault — so renaming stays off a space, while creating is on.
   * The two rights are not the same right and the menu must not merge them.
   */
  /**
   * Reading a folder is not permission to put things in it.
   *
   * Without this the rights check on the two creating entries could be deleted
   * and every test still passed: the only read-only row in the fixture was a
   * note, and a note's menu asks a different question.
   */
  it('does not open on a folder in a vault shared for reading', () => {
    renderTree();
    expect(rightClick(screen.getByRole('treeitem', { name: /Listen/ }))).toBeNull();
  });

  it('offers no rename on a space’s folder, where the move has no good answer', () => {
    renderTree();
    const menu = rightClick(screen.getByRole('treeitem', { name: /Sitzungen/ }));

    expect(labels(menu!)).toEqual([copy.tree.menu.newNote, copy.tree.menu.newFolder]);
  });
});

describe('the menu on a space’s header', () => {
  it('starts a note and a folder at the top of that vault', async () => {
    const onNewNoteIn = vi.fn();
    const onNewFolderIn = vi.fn();
    renderTree({ onNewNoteIn, onNewFolderIn });
    const head = screen.getByRole('heading', { name: /Verein/ });
    const menu = rightClick(head);

    expect(labels(menu!)).toEqual([copy.tree.menu.newNote, copy.tree.menu.newFolder]);
    await userEvent.click(within(menu!).getByRole('menuitem', { name: copy.tree.menu.newNote }));
    expect(onNewNoteIn).toHaveBeenCalledWith('verein', '');
  });

  it('does not open on a vault shared for reading', () => {
    renderTree();
    expect(rightClick(screen.getByRole('heading', { name: /anna/ }))).toBeNull();
  });
});

describe('the menu itself', () => {
  it('closes on Escape and hands the focus back to the row', async () => {
    renderTree();
    const folder = screen.getByRole('treeitem', { name: /Projekte/ });
    rightClick(folder);

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(folder);
  });

  it('walks its entries with the arrow keys', async () => {
    renderTree();
    const menu = rightClick(screen.getByRole('treeitem', { name: /Projekte/ }));
    const entries = within(menu!).getAllByRole('menuitem');

    expect(document.activeElement).toBe(entries[0]);
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(entries[1]);
    // And round, rather than stopping at the end.
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(document.activeElement).toBe(entries[entries.length - 1]);
  });

  it('is replaced rather than added to, when another row is asked', async () => {
    renderTree();
    rightClick(screen.getByRole('treeitem', { name: /Projekte/ }));
    rightClick(screen.getByRole('treeitem', { name: /Sitzungen/ }));

    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(labels(screen.getByRole('menu'))).toEqual([copy.tree.menu.newNote, copy.tree.menu.newFolder]);
  });
});
