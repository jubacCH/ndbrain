/**
 * Spaces and single-note shares in the tree.
 *
 * A space is a vault nobody signs in to, so it must never look like a person
 * who shared a folder: its own root, under its display name, with the space
 * icon, between your own vault and other people's. And a note shared on its
 * own must light up exactly that note, not the file beside it whose name
 * happens to start the same way.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NoteRow, OwnerInfo, Share } from '../src/api';
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
  { id: 'familie', kind: 'space', displayName: 'Familie' },
  { id: 'verein', kind: 'space', displayName: 'Verein' },
];

const NOTES = [
  row('julian', 'Eigenes.md'),
  row('anna', 'Einkauf.md'),
  row('familie', 'Ferien.md'),
  row('familie', 'Projekt/Plan.md'),
  row('familie', 'Projekt/Plan.md.bak'),
  row('familie', 'Projekt/Plan2.md'),
];

const RECEIVED = [
  share('anna', 'vault', '', false),
  share('familie', 'vault', '', false),
  share('familie', 'note', 'Projekt/Plan.md', true),
  // A member of a space with nothing in it yet.
  share('verein', 'vault', '', true),
];

function renderTree(props: Partial<TreeProps> = {}, role: 'user' | 'admin' = 'user') {
  const directory = ownerDirectory(OWNERS);
  const user = { id: 'julian', role };
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
        mayShareNote={(owner) => mayShare(user, owner, ownerKind(directory, owner))}
        {...props}
      />
    </OwnersContext.Provider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('a space in the tree', () => {
  it('is its own root, under its display name, between your vault and other people’s', () => {
    const { container } = renderTree();
    const sections = [...container.querySelectorAll('section.vault')];
    expect(sections.map((s) => s.getAttribute('data-kind'))).toEqual(['person', 'space', 'space', 'person']);

    const heads = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(heads[0]).toMatch(/^Familie/);
    expect(heads[1]).toMatch(/^Verein/);
    expect(heads[2]).toMatch(/^anna/);
    // The account name of the space is nowhere on screen.
    expect(screen.queryByText('familie')).toBeNull();
  });

  it('carries the space icon, and a person’s vault does not', () => {
    const { container } = renderTree();
    const [, familie, , anna] = [...container.querySelectorAll('section.vault')];
    expect(familie!.querySelector('.vault-head svg.vault-icon')).not.toBeNull();
    expect(anna!.querySelector('.vault-head svg.vault-icon')).toBeNull();
  });

  it('keeps its notes apart from a person’s shared notes', () => {
    const { container } = renderTree();
    const [, familie, , anna] = [...container.querySelectorAll('section.vault')];
    expect(within(familie as HTMLElement).getByText('Ferien')).toBeInTheDocument();
    expect(within(familie as HTMLElement).queryByText('Einkauf')).toBeNull();
    expect(within(anna as HTMLElement).getByText('Einkauf')).toBeInTheDocument();
  });

  it('says how much of it may be written, as a person’s vault does', () => {
    const { container } = renderTree();
    const [, familie, verein] = [...container.querySelectorAll('section.vault')];
    expect(within(familie as HTMLElement).getByRole('heading')).toHaveTextContent('Familie');
    expect(within(familie as HTMLElement).getByRole('heading')).toHaveTextContent('partly writable');
    expect(within(verein as HTMLElement).getByRole('heading')).toHaveTextContent('read + write');
  });

  it('is there while still empty, with a way to start its first note where writing is allowed', async () => {
    const onCreateIn = vi.fn();
    const { container } = renderTree({ onCreateIn });
    const verein = container.querySelectorAll('section.vault')[2] as HTMLElement;
    expect(within(verein).getByText('Nothing in this space yet.')).toBeInTheDocument();

    await userEvent.click(within(verein).getByRole('button', { name: 'New note in Verein' }));
    expect(onCreateIn).toHaveBeenCalledWith('verein');

    // Familie is readable as a whole and writable only in one note: no new notes.
    expect(screen.queryByRole('button', { name: 'New note in Familie' })).toBeNull();
  });

  it('falls back to account names where the server names no owners', () => {
    render(
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
      />,
    );
    expect(screen.getByText('familie')).toBeInTheDocument();
  });
});

describe('a note shared on its own', () => {
  it('offers a bin on exactly that note, not on the neighbours whose names start the same', async () => {
    const onDeleteNote = vi.fn();
    renderTree({ onDeleteNote });
    await userEvent.click(screen.getByText('Projekt'));

    expect(screen.getByRole('button', { name: 'Delete Plan' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Plan.md' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete Plan2' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete Ferien' })).toBeNull();
  });
});

describe('sharing from the tree', () => {
  it('is offered on your own notes and on nobody else’s', () => {
    renderTree({ onShareNote: vi.fn() });
    expect(screen.getByRole('button', { name: 'Share Eigenes' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share Einkauf' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Share Ferien' })).toBeNull();
  });

  it('is offered to an administrator inside a space, never in a person’s vault', async () => {
    const onShareNote = vi.fn();
    renderTree({ onShareNote }, 'admin');
    await userEvent.click(screen.getByRole('button', { name: 'Share Ferien' }));
    expect(onShareNote).toHaveBeenCalledWith('familie', 'Ferien.md', 'Ferien');
    expect(screen.queryByRole('button', { name: 'Share Einkauf' })).toBeNull();
  });
});
