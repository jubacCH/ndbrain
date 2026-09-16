/**
 * The map view: zooming into a folder, opening a note, the hover panel, and
 * the three vault sizes the brief calls out.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { copy } from '../src/copy';
import { MapView } from '../src/network/MapView';
import { layoutFolder } from '../src/network/treemap';
import type { GraphData } from '../src/api';

// The real layout, counted: a hover must not run it again.
vi.mock('../src/network/treemap', async (original) => {
  const real = await original<typeof import('../src/network/treemap')>();
  return { ...real, layoutFolder: vi.fn(real.layoutFolder) };
});

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

describe('MapView — two levels at once', () => {
  function nestedVault(): Node[] {
    return [
      node({ path: '10_Projects/11_Active/A.md', folder: '10_Projects/11_Active', updatedAt: NOW }),
      node({ path: '10_Projects/11_Active/B.md', folder: '10_Projects/11_Active', updatedAt: NOW }),
      node({ path: '10_Projects/Overview.md', folder: '10_Projects', updatedAt: NOW }),
      node({ path: '20_Areas/C.md', folder: '20_Areas', updatedAt: NOW }),
    ];
  }

  it('shows a subfolder and a loose note nested inside their parent, unclicked', () => {
    render(<MapView graph={graph(nestedVault())} onOpen={vi.fn()} />);
    // The root level: "Projects" is a folder cell.
    expect(screen.getByRole('button', { name: /Projects, 3 notes/ })).toBeInTheDocument();
    // Nested one level inside it, without having clicked anything: its
    // subfolder "Active" and its loose note "Overview", both visible at once.
    expect(screen.getByRole('button', { name: /Active, 2 notes/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Overview — open note/ })).toBeInTheDocument();
  });

  it('zooms straight to a nested subfolder on click, skipping the intermediate view', () => {
    render(<MapView graph={graph(nestedVault())} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Active, 2 notes/ }));
    // Now inside 10_Projects/11_Active: its own two notes are the cells.
    expect(screen.getByRole('button', { name: /A — open note/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /B — open note/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Active$/ })).toHaveAttribute('aria-current', 'true');
  });

  it('opens a note nested inside a parent folder without also zooming the parent', () => {
    const onOpen = vi.fn();
    render(<MapView graph={graph(nestedVault())} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: /Overview — open note/ }));
    expect(onOpen).toHaveBeenCalledWith('jb', '10_Projects/Overview.md');
    // Still at the root: the parent folder cell is unchanged, not zoomed into.
    expect(screen.getByRole('button', { name: /Projects, 3 notes/ })).toBeInTheDocument();
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

function nested(): Node[] {
  return [
    node({ path: '10_Projects/11_Active/A.md', folder: '10_Projects/11_Active', updatedAt: NOW }),
    node({ path: '10_Projects/11_Active/B.md', folder: '10_Projects/11_Active', updatedAt: NOW }),
    node({ path: '10_Projects/Overview.md', folder: '10_Projects', updatedAt: NOW }),
    node({ path: '20_Areas/C.md', folder: '20_Areas', updatedAt: NOW }),
    node({ path: '30_Resources/D.md', folder: '30_Resources', updatedAt: 0 }),
  ];
}

describe('MapView — hovering costs no layout', () => {
  it('lays nothing out again while the pointer moves across the cells', () => {
    const { container } = render(<MapView graph={graph(nested())} onOpen={vi.fn()} />);
    const laidOut = vi.mocked(layoutFolder).mock.calls.length;
    expect(laidOut).toBeGreaterThan(0);

    for (const cell of screen.getAllByRole('button').filter((b) => b.tagName.toLowerCase() === 'g')) {
      fireEvent.mouseEnter(cell);
      fireEvent.mouseLeave(cell);
    }
    fireEvent.mouseEnter(screen.getByRole('button', { name: /Active, 2 notes/ }));

    expect(vi.mocked(layoutFolder).mock.calls.length).toBe(laidOut);
    // …and the panel still followed the pointer.
    expect(container.querySelector('.nv-hover-panel')).toHaveTextContent('Active');
  });

  it('speaks what the keyboard reaches, not what the pointer crosses', () => {
    const { container } = render(<MapView graph={graph(nested())} onOpen={vi.fn()} />);
    const live = container.querySelector('[aria-live]')!;
    fireEvent.mouseEnter(screen.getByRole('button', { name: /Areas, 1 note/ }));
    expect(live).toHaveTextContent('');
    act(() => {
      screen.getByRole('button', { name: /Areas, 1 note/ }).focus();
    });
    expect(live).toHaveTextContent(/Areas/);
  });
});

describe('MapView — one tab stop, arrows between cells', () => {
  it('has a single cell in the tab order and moves it with the arrow keys', () => {
    render(<MapView graph={graph(nested())} onOpen={vi.fn()} />);
    const cells = () => screen.getAllByRole('button').filter((b) => b.tagName.toLowerCase() === 'g');
    expect(cells().filter((c) => c.getAttribute('tabindex') === '0')).toHaveLength(1);

    const first = cells().find((c) => c.getAttribute('tabindex') === '0')!;
    act(() => first.focus());
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    const now = document.activeElement as Element;
    expect(now).not.toBe(first);
    expect(cells()).toContain(now);
    expect(now).toHaveAttribute('tabindex', '0');
    expect(first).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(now, { key: 'End' });
    expect(document.activeElement).toBe(cells().at(-1));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(cells()[0]);
  });
});

describe('MapView — the frame is measured, even when it appears late', () => {
  let observed: Element[] = [];

  beforeEach(() => {
    observed = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: () => void) {}
        observe(el: Element): void {
          observed.push(el);
          this.callback();
        }
        disconnect(): void {}
      },
    );
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('nv-treemap-frame') ? 1234 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('nv-treemap-frame') ? 456 : 0;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lays out into the real container after a first render with an empty vault', () => {
    const { rerender, container } = render(<MapView graph={graph([])} onOpen={vi.fn()} />);
    rerender(<MapView graph={graph(nested())} onOpen={vi.fn()} />);
    expect(observed.some((el) => el.classList.contains('nv-treemap-frame'))).toBe(true);
    expect(container.querySelector('svg')).toHaveAttribute('viewBox', '0 0 1234 456');
  });
});

describe('MapView — other vaults and folder names', () => {
  function shared(): Node[] {
    return [
      node({ path: '10_Projects/Mine.md', folder: '10_Projects', updatedAt: NOW }),
      node({ owner: 'anna', path: '10_Projects/Hers.md', folder: '10_Projects', updatedAt: NOW }),
      node({ owner: 'anna', path: '10_Projects/Also hers.md', folder: '10_Projects', updatedAt: NOW }),
    ];
  }

  it('keeps a folder of the same name in another vault apart, under its owner', () => {
    render(<MapView graph={graph(shared())} onOpen={vi.fn()} self="jb" />);
    // Mine: one note. Anna's vault as a folder of its own, not merged into mine.
    expect(screen.getByRole('button', { name: /^Projects, 1 note/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^anna, 2 notes/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Projects, 3 notes/ })).toBeNull();
  });

  it('zooms into the other vault and back by its crumbs', () => {
    const onOpen = vi.fn();
    render(<MapView graph={graph(shared())} onOpen={onOpen} self="jb" />);
    fireEvent.click(screen.getByRole('button', { name: /^anna, 2 notes/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Projects, 2 notes/ }));
    const crumbs = screen.getByRole('navigation', { name: copy.network.mapView.breadcrumbLabel });
    expect(within(crumbs).getAllByRole('button').map((b) => b.textContent)).toEqual(['Vault', 'anna', 'Projects']);
    fireEvent.click(screen.getByRole('button', { name: /Hers — open note/ }));
    expect(onOpen).toHaveBeenCalledWith('anna', '10_Projects/Hers.md');
  });

  it('keeps sort prefixes when the preference says so', () => {
    render(<MapView graph={graph(nested())} onOpen={vi.fn()} hidePrefixes={false} />);
    expect(screen.getByRole('button', { name: /^10_Projects, 3 notes/ })).toBeInTheDocument();
  });
});

describe('MapView — warmth is amber, not mud', () => {
  it('marks warm cells for the amber fill and leaves dormant ones on the surface', () => {
    // Against the real clock: warmth is measured from now.
    const notes = nested().map((n) => (n.updatedAt === 0 ? n : { ...n, updatedAt: Date.now() }));
    const { container } = render(<MapView graph={graph(notes)} onOpen={vi.fn()} />);
    const rects = [...container.querySelectorAll('rect.nv-cell-rect')];
    const warm = rects.filter((r) => r.hasAttribute('data-warm'));
    const cold = rects.filter((r) => !r.hasAttribute('data-warm'));
    expect(warm.length).toBeGreaterThan(0);
    expect(cold.length).toBeGreaterThan(0);
    for (const r of warm) expect(Number((r as SVGElement).style.getPropertyValue('--t'))).toBeGreaterThan(0);
  });

  /** OKLCH to gamma-encoded sRGB, clamped — Björn Ottosson's published matrices. */
  function oklchToSrgb(L: number, C: number, hue: number): [number, number, number] {
    const h = (hue * Math.PI) / 180;
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const lin = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    return lin.map((c) => {
      const v = Math.max(0, Math.min(1, c));
      return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    }) as [number, number, number];
  }

  function hueAndSaturation([r, g, b]: [number, number, number]): { hue: number; sat: number } {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    const light = (max + min) / 2;
    const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * light - 1));
    let hue = 0;
    if (d !== 0) {
      if (max === r) hue = 60 * (((g - b) / d) % 6);
      else if (max === g) hue = 60 * ((b - r) / d + 2);
      else hue = 60 * ((r - g) / d + 4);
    }
    return { hue: (hue + 360) % 360, sat };
  }

  const css = readFileSync(resolve(__dirname, '../src/network/network.css'), 'utf8');

  function tokens(block: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [, name, value] of block.matchAll(/--nv-heat-(h|l0|l1|c0|c1):\s*([\d.]+);/g)) out[name!] = Number(value);
    return out;
  }

  it('gives the details panel a fixed height, so hovering cannot resize the map', () => {
    // Found in the browser, where jsdom has no layout: a panel that grew by a
    // line on hover shrank the treemap frame, and the ResizeObserver laid the
    // whole map out again under the pointer.
    const rule = /\.nv-hover-panel\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/(^|\s)height:\s*[\d.]+rem;/);
    expect(rule).toMatch(/flex:\s*none;/);
    expect(rule).not.toMatch(/min-height/);
  });

  it('fills warm cells in OKLCH at one fixed hue, never by mixing into the petrol surface', () => {
    const rule = /\.nv-cell-rect\[data-warm\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/fill:\s*oklch\(/);
    expect(rule).toMatch(/var\(--nv-heat-h\)/);
    expect(rule).not.toMatch(/fill:[^;]*in srgb/);
  });

  it.each([
    ['light', /\.network-view\s*\{\s*--nv-cool[^}]*\}/],
    ['dark', /:root\[data-theme='dark'\] \.network-view\s*\{\s*--nv-heat[^}]*\}/],
  ])('reads as amber at every warmth in %s', (_theme, blockPattern) => {
    const base = tokens(/\.network-view\s*\{\s*--nv-cool[^}]*\}/.exec(css)![0]);
    const theme = { ...base, ...tokens(blockPattern.exec(css)![0]) };
    for (const t of [0.05, 0.25, 0.5, 0.75, 1]) {
      const L = theme.l0! + (theme.l1! - theme.l0!) * t;
      const C = theme.c0! + (theme.c1! - theme.c0!) * t;
      const { hue, sat } = hueAndSaturation(oklchToSrgb(L, C, theme.h!));
      // Amber sits between orange and gold; khaki and olive are past 45° with
      // little saturation, which is exactly what the sRGB mix produced.
      expect(hue, `hue at warmth ${t}`).toBeGreaterThanOrEqual(28);
      expect(hue, `hue at warmth ${t}`).toBeLessThanOrEqual(45);
      expect(sat, `saturation at warmth ${t}`).toBeGreaterThanOrEqual(0.4);
    }
  });
});
