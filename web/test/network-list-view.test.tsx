/**
 * The list view: sorting, filtering, opening a row, and the three vault sizes
 * the brief calls out (empty, one note, two thousand notes).
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { copy } from '../src/copy';
import { ListView } from '../src/network/ListView';
import type { GraphData } from '../src/api';

type Node = GraphData['nodes'][number];

function node(overrides: Partial<Node> & { path: string }): Node {
  return {
    owner: 'jb',
    title: overrides.path.replace(/\.md$/, ''),
    folder: '',
    links: 0,
    tags: [],
    updatedAt: 0,
    ...overrides,
  };
}

function graph(nodes: Node[]): GraphData {
  return { nodes, edges: [] };
}

const NOW = Date.UTC(2026, 8, 16);
const DAY = 86_400_000;

describe('ListView — empty and small vaults', () => {
  it('shows an empty-vault message for zero notes', () => {
    render(<ListView graph={graph([])} onOpen={vi.fn()} />);
    expect(screen.getByText(/no notes yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders a single note as one row', () => {
    render(<ListView graph={graph([node({ path: 'Solo.md', updatedAt: NOW })])} onOpen={vi.fn()} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(2); // header + one data row
    expect(screen.getByText('Solo')).toBeInTheDocument();
  });
});

describe('ListView — sorting, filtering, opening', () => {
  function threeNotes(): Node[] {
    return [
      node({ path: 'Alpha.md', title: 'Alpha', links: 5, tags: ['x'], updatedAt: NOW - 1 * DAY, folder: 'A' }),
      node({ path: 'Beta.md', title: 'Beta', links: 1, tags: ['y', 'z'], updatedAt: NOW - 10 * DAY, folder: 'B' }),
      node({ path: 'Gamma.md', title: 'Gamma', links: 9, tags: [], updatedAt: NOW, folder: 'C' }),
    ];
  }

  function titlesInOrder(): string[] {
    const rows = screen.getAllByRole('row').slice(1); // drop the header row
    return rows.map((r) => within(r).getAllByRole('cell')[0]!.textContent ?? '');
  }

  it('defaults to most-recently-updated first', () => {
    render(<ListView graph={graph(threeNotes())} onOpen={vi.fn()} />);
    expect(titlesInOrder()).toEqual(['Gamma', 'Alpha', 'Beta']);
  });

  it('sorts by a column on click, and reverses on a second click', () => {
    render(<ListView graph={graph(threeNotes())} onOpen={vi.fn()} />);
    // The accessible name changes once the column is active (it states the
    // sort direction), so the button is found once and reused for both clicks
    // rather than re-queried by its now-stale initial name.
    const linksHeader = screen.getByRole('button', { name: /^Links$/ });
    fireEvent.click(linksHeader);
    expect(titlesInOrder()).toEqual(['Gamma', 'Alpha', 'Beta']); // 9, 5, 1 — desc by default
    fireEvent.click(linksHeader);
    expect(titlesInOrder()).toEqual(['Beta', 'Alpha', 'Gamma']); // ascending now
  });

  it('sorts titles alphabetically', () => {
    render(<ListView graph={graph(threeNotes())} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Title$/ }));
    expect(titlesInOrder()).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('filters by title', () => {
    render(<ListView graph={graph(threeNotes())} onOpen={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'bet' } });
    expect(titlesInOrder()).toEqual(['Beta']);
  });

  it('filters by tag', () => {
    render(<ListView graph={graph(threeNotes())} onOpen={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'z' } });
    expect(titlesInOrder()).toEqual(['Beta']);
  });

  it('opens a note on row click', () => {
    const onOpen = vi.fn();
    render(<ListView graph={graph(threeNotes())} onOpen={onOpen} />);
    fireEvent.click(screen.getByText('Alpha'));
    expect(onOpen).toHaveBeenCalledWith('jb', 'Alpha.md');
  });

  it('opens the focused row on Enter, and moves focus with the arrow keys', () => {
    const onOpen = vi.fn();
    render(<ListView graph={graph(threeNotes())} onOpen={onOpen} />);
    const rows = screen.getAllByRole('row').slice(1);
    (rows[0] as HTMLElement).focus();
    fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' });
    fireEvent.keyDown(rows[1]!, { key: 'Enter' });
    // Row 0 is Gamma (default sort), row 1 is Alpha.
    expect(onOpen).toHaveBeenCalledWith('jb', 'Alpha.md');
  });
});

describe('ListView — owners and folder names', () => {
  it('has no owner column while every note is from one vault', () => {
    render(<ListView graph={graph([node({ path: 'A.md' }), node({ path: 'B.md' })])} onOpen={vi.fn()} />);
    expect(screen.queryByRole('columnheader', { name: copy.network.list.owner })).toBeNull();
  });

  it('names the owner of every row once a second vault is in the graph', () => {
    render(
      <ListView
        graph={graph([node({ path: 'A.md', title: 'Mine' }), node({ path: 'A.md', title: 'Theirs', owner: 'anna' })])}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByRole('columnheader', { name: copy.network.list.owner })).toBeInTheDocument();
    const theirs = screen.getByText('Theirs').closest('tr')!;
    expect(within(theirs).getByText('anna')).toBeInTheDocument();
  });

  it('keeps sort prefixes in folder names when the preference says so', () => {
    const notes = [node({ path: '10_Projects/A.md', folder: '10_Projects' })];
    const { rerender } = render(<ListView graph={graph(notes)} onOpen={vi.fn()} />);
    expect(screen.getByText('Projects')).toBeInTheDocument();
    rerender(<ListView graph={graph(notes)} onOpen={vi.fn()} hidePrefixes={false} />);
    expect(screen.getByText('10_Projects')).toBeInTheDocument();
  });
});

describe('ListView — a large synthetic vault (2000 notes)', () => {
  function manyNotes(): Node[] {
    return Array.from({ length: 2000 }, (_, i) =>
      node({ path: `Note-${i}.md`, title: `Note ${i}`, updatedAt: NOW - i * 1000, links: i % 7 }),
    );
  }

  it('paginates rather than rendering every row', () => {
    render(<ListView graph={graph(manyNotes())} onOpen={vi.fn()} />);
    // One header row plus at most PAGE_SIZE data rows, never all 2000.
    expect(screen.getAllByRole('row').length).toBeLessThan(500);
    expect(screen.getByText(/page 1 of/i)).toBeInTheDocument();
  });

  it('pulls the page back when the graph shrinks under it, so "previous" still steps back', () => {
    const { rerender } = render(<ListView graph={graph(manyNotes())} onOpen={vi.fn()} />);
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    expect(screen.getByText('Page 5 of 10')).toBeInTheDocument();

    // A refetch with fewer notes: four pages left.
    rerender(<ListView graph={graph(manyNotes().slice(0, 700))} onOpen={vi.fn()} />);
    expect(screen.getByText('Page 4 of 4')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /previous page/i }));
    expect(screen.getByText('Page 3 of 4')).toBeInTheDocument();
  });

  it('moves to the next page', () => {
    render(<ListView graph={graph(manyNotes())} onOpen={vi.fn()} />);
    const firstPageFirstTitle = screen.getAllByRole('row')[1]!.textContent;
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    const secondPageFirstTitle = screen.getAllByRole('row')[1]!.textContent;
    expect(secondPageFirstTitle).not.toBe(firstPageFirstTitle);
  });
});
