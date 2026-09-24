/**
 * A space goes by its name everywhere a note's vault is said.
 *
 * Its account name is a folder name on disk ("familie"); what its members know
 * it as is the display name ("Familie"). The tree has its own test; these are
 * the other places a note from another vault is labelled: search hits, the
 * palette, the list and the map, the inspector beside the brain, and the
 * sharing page, which also has to say what each share opens.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, type GraphData, type OwnerInfo, type SearchHit, type Share } from '../src/api';
import { copy } from '../src/copy';
import { indexGraph } from '../src/inspect';
import { Inspector } from '../src/Inspector';
import { ListView } from '../src/network/ListView';
import { layoutMap } from '../src/network/MapView';
import { buildFolderTree } from '../src/network/treemap';
import { OwnersContext, ownerDirectory, ownerLabel } from '../src/owners';
import { Palette } from '../src/Palette';
import { refKey } from '../src/refkey';
import { SearchView, SharesView } from '../src/Views';

const OWNERS: OwnerInfo[] = [
  { id: 'julian', kind: 'person', displayName: 'Julian' },
  { id: 'anna', kind: 'person', displayName: 'Anna' },
  { id: 'familie', kind: 'space', displayName: 'Familie' },
];
const DIRECTORY = ownerDirectory(OWNERS);

function withOwners(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OwnersContext.Provider value={DIRECTORY}>{ui}</OwnersContext.Provider>
    </QueryClientProvider>,
  );
}

const GRAPH: GraphData = {
  nodes: [
    { owner: 'julian', path: 'Eigenes.md', title: 'Eigenes', folder: '', links: 0, tags: [], updatedAt: 0 },
    { owner: 'familie', path: 'Ferien/Plan.md', title: 'Plan', folder: 'Ferien', links: 0, tags: [], updatedAt: 0 },
  ],
  edges: [],
};

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the owner label', () => {
  it('is a space’s display name and a person’s account name', () => {
    expect(ownerLabel(DIRECTORY, 'familie')).toBe('Familie');
    expect(ownerLabel(DIRECTORY, 'anna')).toBe('anna');
    expect(ownerLabel(DIRECTORY, 'unbekannt')).toBe('unbekannt');
  });
});

describe('search', () => {
  it('marks a hit from a space with the space’s name', () => {
    const hits: SearchHit[] = [
      { owner: 'familie', path: 'Ferien/Plan.md', title: 'Plan', size: 1, mtimeMs: 0, snippet: '' },
      { owner: 'julian', path: 'Eigenes.md', title: 'Eigenes', size: 1, mtimeMs: 0, snippet: '' },
    ];
    withOwners(
      <SearchView
        query="plan"
        hits={hits}
        filters={{}}
        tags={[]}
        dirs={[]}
        self="julian"
        props={[]}
        propValues={[]}
        onToggleFilter={vi.fn()}
        onClearFilters={vi.fn()}
        onOpen={vi.fn()}
        onQuery={vi.fn()}
      />,
    );
    const plan = screen.getByText('Plan').closest('button')!;
    expect(within(plan).getByText('Familie')).toHaveClass('pill');
    expect(within(plan).queryByText('familie')).toBeNull();
  });
});

describe('the palette', () => {
  it('marks a note from a space with the space’s name', async () => {
    vi.spyOn(api, 'quickFind').mockResolvedValue({
      notes: [{ owner: 'familie', path: 'Ferien/Plan.md', title: 'Plan', size: 1, mtimeMs: 0 }],
    });
    withOwners(<Palette open self="julian" onClose={vi.fn()} onOpenNote={vi.fn()} />);
    const row = (await screen.findByText('Plan')).closest('button')!;
    expect(within(row).getByText('Familie')).toBeInTheDocument();
  });
});

describe('list and map', () => {
  it('name the space in the list’s owner column', () => {
    withOwners(<ListView graph={GRAPH} onOpen={vi.fn()} />);
    const row = screen.getByText('Plan').closest('tr')!;
    expect(within(row).getByText('Familie')).toHaveClass('nv-owner');
  });

  it('name the space’s own root in the map', () => {
    const root = buildFolderTree(
      GRAPH.nodes.map((n) => ({ ...n })),
      0,
      'julian',
    );
    const cells = layoutMap(root, 800, 600, true, (owner) => ownerLabel(DIRECTORY, owner));
    expect(cells.some((cell) => cell.label.startsWith('Familie'))).toBe(true);
    expect(cells.some((cell) => cell.label.startsWith('familie'))).toBe(false);
  });
});

describe('the inspector', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getNote').mockResolvedValue({
      owner: 'familie',
      canWrite: false,
      note: { path: 'Ferien/Plan.md', title: 'Plan', content: '', size: 0, mtimeMs: 0, hash: 'h1' },
    });
    vi.spyOn(api, 'history').mockResolvedValue({ available: false, versions: [] });
  });

  it('says the note is in a space, by name, with the space icon', () => {
    withOwners(
      <Inspector index={indexGraph(GRAPH)} picked={refKey('familie', 'Ferien/Plan.md')} onPick={vi.fn()} onOpen={vi.fn()} self="julian" />,
    );
    const facts = document.querySelector('.inspector-facts')!;
    expect(within(facts as HTMLElement).getByText(copy.inspector.space)).toBeInTheDocument();
    const owner = within(facts as HTMLElement).getByText('Familie');
    expect(owner.querySelector('svg')).not.toBeNull();
  });

  it('offers “Share…” only when the shell hands it the action', () => {
    const onShare = vi.fn();
    const first = withOwners(
      <Inspector index={indexGraph(GRAPH)} picked={refKey('familie', 'Ferien/Plan.md')} onPick={vi.fn()} onOpen={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: copy.tree.shareNoteLabel('Plan') })).toBeNull();
    first.unmount();

    withOwners(
      <Inspector
        index={indexGraph(GRAPH)}
        picked={refKey('familie', 'Ferien/Plan.md')}
        onPick={vi.fn()}
        onOpen={vi.fn()}
        onShare={onShare}
      />,
    );
    screen.getByRole('button', { name: copy.tree.shareNoteLabel('Plan') }).click();
    expect(onShare).toHaveBeenCalledWith('familie', 'Ferien/Plan.md', 'Plan');
  });
});

describe('the sharing page', () => {
  const GRANTED: Share[] = [
    { id: 'g1', owner: 'julian', prefix: '', grantee: 'anna', canWrite: false, createdAt: 0, kind: 'vault' },
    { id: 'g2', owner: 'julian', prefix: 'Projekt/', grantee: 'anna', canWrite: true, createdAt: 0, kind: 'folder' },
    { id: 'g3', owner: 'julian', prefix: 'Projekt/Plan.md', grantee: 'bert', canWrite: false, createdAt: 0, kind: 'note' },
  ];
  const RECEIVED: Share[] = [
    { id: 'r1', owner: 'familie', prefix: 'Ferien/Plan.md', grantee: 'julian', canWrite: true, createdAt: 0, kind: 'note' },
  ];

  it('says what each share opens, with the matching icon', () => {
    withOwners(
      <SharesView granted={GRANTED} received={RECEIVED} dirs={[]} busy={false} onGrant={vi.fn()} onRevoke={vi.fn()} />,
    );
    const kinds = [...document.querySelectorAll<HTMLElement>('.share-kind')].map((el) => ({
      kind: el.dataset['kind'],
      word: el.textContent,
      icon: el.querySelector('svg') !== null,
    }));
    expect(kinds).toEqual([
      { kind: 'vault', word: copy.shares.kind.vault, icon: true },
      { kind: 'folder', word: copy.shares.kind.folder, icon: true },
      { kind: 'note', word: copy.shares.kind.note, icon: true },
      { kind: 'note', word: copy.shares.kind.note, icon: true },
    ]);
    // The three icons differ: a vault, a folder and a note do not look alike.
    const drawn = [...document.querySelectorAll('.share-kind svg')].map((svg) => svg.innerHTML);
    expect(new Set(drawn.slice(0, 3)).size).toBe(3);
  });

  it('names a space that shares with you by its display name', () => {
    withOwners(
      <SharesView granted={[]} received={RECEIVED} dirs={[]} busy={false} onGrant={vi.fn()} onRevoke={vi.fn()} />,
    );
    const row = screen.getByText('Ferien/Plan.md').closest('tr')!;
    expect(within(row).getByText('Familie')).toBeInTheDocument();
  });
});
