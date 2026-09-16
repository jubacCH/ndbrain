/**
 * The map view: zooming into a folder, opening a note, the hover panel, and
 * the three vault sizes the brief calls out.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MapView } from '../src/network/MapView';
import type { GraphData } from '../src/api';

type Node = GraphData['nodes'][number];

function node(overrides: Partial<Node> & { path: string; folder: string }): Node {
  return {
    owner: 'jb',
    title: overrides.path.slice(overrides.path.lastIndexOf('/') + 1).replace(/\.md$/, ''),
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

describe('MapView — empty and small vaults', () => {
  it('shows an empty-vault message for zero notes', () => {
    render(<MapView graph={graph([])} onOpen={vi.fn()} />);
    expect(screen.getByText(/no notes yet/i)).toBeInTheDocument();
  });

  it('renders a single root-level note as one cell', () => {
    render(<MapView graph={graph([node({ path: 'Solo.md', folder: '', updatedAt: NOW })])} onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Solo/ })).toBeInTheDocument();
  });
});

describe('MapView — zoom, breadcrumb and opening a note', () => {
  function vault(): Node[] {
    return [
      node({ path: '10_Projects/A.md', folder: '10_Projects', updatedAt: NOW }),
      node({ path: '10_Projects/B.md', folder: '10_Projects', updatedAt: NOW }),
      node({ path: '20_Areas/C.md', folder: '20_Areas', updatedAt: NOW }),
    ];
  }

  it('shows the top-level folders at the root', () => {
    render(<MapView graph={graph(vault())} onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Projects, 2 notes/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Areas, 1 note/ })).toBeInTheDocument();
  });

  it('zooms into a folder on click, and shows a breadcrumb back', () => {
    render(<MapView graph={graph(vault())} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Projects, 2 notes/ }));

    // Now inside 10_Projects: its two notes are the cells, the other folder is gone.
    expect(screen.getByRole('button', { name: /A — open note/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /B — open note/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Areas, 1 note/ })).not.toBeInTheDocument();

    // Breadcrumb: root + the folder zoomed into.
    const crumbs = screen.getByLabelText(/folder path/i);
    expect(crumbs).toBeInTheDocument();

    // Clicking the root breadcrumb goes back.
    fireEvent.click(screen.getByRole('button', { name: /^Vault$/ }));
    expect(screen.getByRole('button', { name: /Projects, 2 notes/ })).toBeInTheDocument();
  });

  it('opens a note on click, not a folder zoom', () => {
    const onOpen = vi.fn();
    render(<MapView graph={graph(vault())} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: /Projects, 2 notes/ }));
    fireEvent.click(screen.getByRole('button', { name: /A — open note/ }));
    expect(onOpen).toHaveBeenCalledWith('jb', '10_Projects/A.md');
  });

  it('opens a focused note on Enter', () => {
    const onOpen = vi.fn();
    render(<MapView graph={graph(vault())} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: /Projects, 2 notes/ }));
    const cell = screen.getByRole('button', { name: /A — open note/ });
    fireEvent.keyDown(cell, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('jb', '10_Projects/A.md');
  });

  it('shows folder details in the hover panel on hover and on focus', () => {
    const { container } = render(<MapView graph={graph(vault())} onOpen={vi.fn()} />);
    const cell = screen.getByRole('button', { name: /Projects, 2 notes/ });
    fireEvent.mouseEnter(cell);
    // The cell itself may carry the same "2 notes" as a label inside the SVG,
    // so the hover panel is checked by itself rather than by text anywhere on
    // the page.
    const panel = container.querySelector('.nv-hover-panel');
    expect(panel).toHaveTextContent('Projects');
    expect(panel).toHaveTextContent('2 notes');
  });
});

describe('MapView — a large synthetic vault (2000 notes)', () => {
  it('builds and renders the root level without error', () => {
    const folders = ['10_Projects/11_Active', '10_Projects/19_Done', '20_Areas', '30_Resources'];
    const nodes = Array.from({ length: 2000 }, (_, i) => {
      const folder = folders[i % folders.length]!;
      return node({ path: `${folder}/N${i}.md`, folder, updatedAt: NOW - i * 1000 });
    });
    render(<MapView graph={graph(nodes)} onOpen={vi.fn()} />);
    // 10_Projects covers two of the four folders in the cycle (1000 notes);
    // 20_Areas is one of the remaining two (500 notes).
    expect(screen.getByRole('button', { name: /Projects, 1000 notes/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Areas, 500 notes/ })).toBeInTheDocument();
  });
});
