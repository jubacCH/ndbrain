/**
 * The inspector beside a focused note: what it shows, where it gets it, and
 * how it is driven from the keyboard.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, type GraphData } from '../src/api';
import { blockedAround } from '../src/brain/blocked';
import { toScreen } from '../src/brain/camera';
import { SceneBuilder } from '../src/brain/scene';
import { copy } from '../src/copy';
import { indexGraph } from '../src/inspect';
import { Inspector } from '../src/Inspector';
import { NetworkFrame } from '../src/NetworkFrame';
import { refKey } from '../src/refkey';

const O = 'julian';
const DAY = 86_400_000;

const graph: GraphData = {
  nodes: [
    {
      owner: O,
      path: '10_Projects/13_Kunden/Backup to Azure.md',
      title: 'Backup to Azure',
      folder: '10_Projects/13_Kunden',
      links: 3,
      tags: ['backup', 'azure'],
      updatedAt: Date.now() - 2 * DAY,
    },
    { owner: O, path: '10_Projects/13_Kunden/Veeam.md', title: 'Veeam', folder: '10_Projects/13_Kunden', links: 1, tags: ['backup'], updatedAt: 0 },
    { owner: O, path: '20_Areas/Storage.md', title: 'Storage', folder: '20_Areas', links: 2, tags: [], updatedAt: 0 },
    { owner: O, path: '40_MOCs/Kunden.md', title: 'Kunden', folder: '40_MOCs', links: 1, tags: [], updatedAt: 0 },
  ],
  edges: [
    { owner: O, from: '10_Projects/13_Kunden/Backup to Azure.md', to: '10_Projects/13_Kunden/Veeam.md' },
    { owner: O, from: '10_Projects/13_Kunden/Backup to Azure.md', to: '20_Areas/Storage.md' },
    { owner: O, from: '40_MOCs/Kunden.md', to: '10_Projects/13_Kunden/Backup to Azure.md' },
    { owner: O, from: '20_Areas/Storage.md', to: '10_Projects/13_Kunden/Veeam.md' },
  ],
};
const index = indexGraph(graph);
const AZURE = refKey(O, '10_Projects/13_Kunden/Backup to Azure.md');
const VEEAM = refKey(O, '10_Projects/13_Kunden/Veeam.md');
const KUNDEN = refKey(O, '40_MOCs/Kunden.md');

const CONTENT = [
  '---',
  'tags: [backup, azure]',
  '---',
  '# Backup to Azure',
  '> [!note] Kunde: Muster AG',
  '',
  'Setup and maintain automated backups to Azure <img src=x onerror="window.__pwned=1"> for personal data.',
].join('\n');

function note(content: string) {
  return {
    note: { path: '10_Projects/13_Kunden/Backup to Azure.md', title: 'Backup to Azure', content, size: content.length, mtimeMs: 0 },
    owner: O,
    canWrite: true,
  };
}

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.spyOn(api, 'getNote').mockResolvedValue(note(CONTENT));
  vi.spyOn(api, 'history').mockResolvedValue({
    available: true,
    versions: [
      { id: 'a1', at: Date.now() - 3 * 3_600_000, subject: 'Vault-Stand · 1 geändert', size: 10 },
      { id: 'b2', at: Date.now() - 4 * DAY, subject: 'Vault-Stand · 2 geändert', size: 9 },
    ],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the inspector', () => {
  it('shows title, type, last edit and tags, and the first paragraph as text', async () => {
    wrap(<Inspector index={index} picked={AZURE} onPick={vi.fn()} onOpen={vi.fn()} />);
    const card = screen.getByRole('region', { name: copy.inspector.label('Backup to Azure') });
    expect(within(card).getByRole('heading', { level: 2 })).toHaveTextContent('Backup to Azure');
    expect(card).toHaveTextContent(copy.network.card.kind.client);
    expect(card).toHaveTextContent('2 days ago');
    expect(card).toHaveTextContent('#backup');
    expect(card).toHaveTextContent('#azure');

    await waitFor(() => expect(card.querySelector('.inspector-summary')).not.toBeNull());
    expect(card.querySelector('.inspector-summary')).toHaveTextContent(
      'Setup and maintain automated backups to Azure for personal data.',
    );
    // Neither the frontmatter, the callout header, nor any markup of the note.
    expect(card).not.toHaveTextContent('Muster AG');
    expect(card.querySelector('img')).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    expect(api.getNote).toHaveBeenCalledWith(O, '10_Projects/13_Kunden/Backup to Azure.md');
  });

  it('splits the neighbours into links to and linked from, and focuses one on click', async () => {
    const onPick = vi.fn();
    wrap(<Inspector index={index} picked={AZURE} onPick={onPick} onOpen={vi.fn()} />);
    const to = screen.getByRole('list', { name: new RegExp(copy.inspector.linksTo) });
    const from = screen.getByRole('list', { name: new RegExp(copy.inspector.linkedFrom) });
    expect(within(to).getAllByRole('button', { name: /^Focus / }).map((b) => b.textContent)).toEqual([
      'Storage20_Areas',
      'Veeam10_Projects/13_Kunden',
    ]);
    expect(within(from).getAllByRole('button', { name: /^Focus / })).toHaveLength(1);

    await userEvent.click(within(from).getByRole('button', { name: copy.inspector.focus('Kunden') }));
    expect(onPick).toHaveBeenLastCalledWith(KUNDEN);
  });

  it('says why a neighbour is connected, from the structure', async () => {
    wrap(<Inspector index={index} picked={AZURE} onPick={vi.fn()} onOpen={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: copy.inspector.whyLabel('Veeam') });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const reason = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    // Linked directly, same folder, one shared tag, Storage links to both.
    expect(reason).toHaveTextContent(
      `${copy.inspector.reason.outgoing} · ${copy.inspector.reason.sameFolder} 13_Kunden · ${copy.inspector.reason.tags(1)} #backup · ${copy.inspector.reason.neighbours(1)}`,
    );
  });

  it('lists recorded versions under activity, and leaves the section out where the host keeps none', async () => {
    const first = wrap(<Inspector index={index} picked={AZURE} onPick={vi.fn()} onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: copy.inspector.activity })).toBeInTheDocument());
    expect(screen.getAllByText(copy.inspector.changed)).toHaveLength(2);
    first.unmount();

    vi.mocked(api.history).mockResolvedValue({ available: false, versions: [] });
    wrap(<Inspector index={index} picked={VEEAM} onPick={vi.fn()} onOpen={vi.fn()} />);
    await waitFor(() => expect(api.history).toHaveBeenCalledWith(O, '10_Projects/13_Kunden/Veeam.md'));
    // Let the answer land before asserting on its absence.
    await vi.mocked(api.history).mock.results.at(-1)!.value;
    await waitFor(() => expect(document.querySelector('.inspector-summary, .inspector-section .inspector-quiet')).not.toBeNull());
    expect(screen.queryByRole('heading', { name: copy.inspector.activity })).toBeNull();
  });

  it('shows markup written as entities as the characters it spells, never as an element', async () => {
    vi.mocked(api.getNote).mockResolvedValue(
      note('# Backup to Azure\n\nBefore &lt;img src=x onerror="window.__pwnedEntity=1"&gt; and &#60;script&#62;alert(1)&#60;/script&#62; after.'),
    );
    wrap(<Inspector index={index} picked={AZURE} onPick={vi.fn()} onOpen={vi.fn()} />);
    await waitFor(() => expect(document.querySelector('.inspector-summary')).not.toBeNull());
    const summary = document.querySelector('.inspector-summary')!;
    expect(summary.children.length).toBe(0);
    expect(summary.textContent).toContain('Before');
    expect(summary.textContent).toContain('after.');
    expect(document.querySelector('.inspector img, .inspector script')).toBeNull();
    expect((window as { __pwnedEntity?: number }).__pwnedEntity).toBeUndefined();
  });

  it('leaves the summary out when the note cannot be read, rather than guessing', async () => {
    vi.mocked(api.getNote).mockRejectedValue(new Error('forbidden'));
    wrap(<Inspector index={index} picked={AZURE} onPick={vi.fn()} onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole('heading', { name: copy.inspector.summary })).toBeNull());
  });

  it('opens the note, and offers "show in tree" only when the shell can do it', async () => {
    const onOpen = vi.fn();
    const onReveal = vi.fn();
    const first = wrap(<Inspector index={index} picked={AZURE} onPick={vi.fn()} onOpen={onOpen} />);
    expect(screen.queryByRole('button', { name: copy.inspector.reveal })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: copy.inspector.open }));
    expect(onOpen).toHaveBeenCalledWith(O, '10_Projects/13_Kunden/Backup to Azure.md');
    first.unmount();

    wrap(<Inspector index={index} picked={AZURE} onPick={vi.fn()} onOpen={onOpen} onReveal={onReveal} />);
    await userEvent.click(screen.getByRole('button', { name: copy.inspector.reveal }));
    expect(onReveal).toHaveBeenCalledWith(O, '10_Projects/13_Kunden/Backup to Azure.md');
  });

  it('offers delete only when the shell passes it, and hands over the note', async () => {
    const onDelete = vi.fn();
    const first = wrap(<Inspector index={index} picked={AZURE} onPick={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^Delete / })).toBeNull();
    first.unmount();

    wrap(<Inspector index={index} picked={AZURE} onPick={vi.fn()} onOpen={vi.fn()} onDelete={onDelete} />);
    const button = screen.getByRole('button', { name: 'Delete Backup to Azure' });
    expect(button).toHaveTextContent(copy.inspector.delete);
    await userEvent.click(button);
    expect(onDelete).toHaveBeenCalledWith(O, '10_Projects/13_Kunden/Backup to Azure.md', 'Backup to Azure');
  });

  it('is reached with Tab, a neighbour is focused with Enter, and Escape ends the focus', async () => {
    const onPick = vi.fn();
    wrap(<Inspector index={index} picked={AZURE} onPick={onPick} onOpen={vi.fn()} />);
    await userEvent.tab();
    expect(screen.getByRole('button', { name: copy.inspector.close })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: copy.inspector.focus('Storage') })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onPick).toHaveBeenLastCalledWith(refKey(O, '20_Areas/Storage.md'));
    await userEvent.keyboard('{Escape}');
    expect(onPick).toHaveBeenLastCalledWith(null);
  });
});

describe('the inspector in the network frame', () => {
  it('appears for a note clicked in the brain, beside the canvas, where region names keep clear of it', async () => {
    const W = 1200;
    const H = 800;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    Object.defineProperty(HTMLCanvasElement.prototype, 'setPointerCapture', { value: () => {}, configurable: true });
    // Every element has a box: the canvas fills the frame, the inspector sits on its right.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = (left: number, top: number, width: number, height: number) =>
        ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
      if (this instanceof HTMLCanvasElement) return box(0, 0, W, H);
      if (this.classList.contains('inspector')) return box(860, 68, 324, 500);
      return box(0, 0, 0, 0);
    });
    const build = vi.spyOn(SceneBuilder.prototype, 'build');

    wrap(<NetworkFrame graph={graph} events={[]} account={O} view="graph" onView={vi.fn()} onOpen={vi.fn()} />);
    await waitFor(() => expect(build).toHaveBeenCalled());
    expect(document.querySelector('.inspector')).toBeNull();

    const canvas = document.querySelector<HTMLCanvasElement>('canvas.brain')!;
    const call = build.mock.calls.at(-1)!;
    const layout = call[0];
    const camera = call[2];
    const i = layout.x.length > 0 ? [...Array(layout.x.length).keys()].find((n) => graph.nodes[n]!.title === 'Backup to Azure')! : -1;
    const p = toScreen(camera, layout.x[i]!, layout.y[i]!);
    fireEvent.pointerDown(canvas, { clientX: p.x, clientY: p.y, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: p.x, clientY: p.y, pointerId: 1 });

    const card = await screen.findByRole('region', { name: copy.inspector.label('Backup to Azure') });
    expect(card.parentElement).toBe(canvas.parentElement);
    expect(card).toHaveAttribute('data-brain-reserve');
    expect(blockedAround(canvas)).toContainEqual({ x: 860, y: 68, w: 324, h: 500 });

    // Escape in the inspector ends the focus and gives the keyboard back to the canvas.
    within(card).getByRole('button', { name: copy.inspector.close }).focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: copy.inspector.label('Backup to Azure') })).toBeNull();
    expect(canvas).toHaveFocus();
    vi.unstubAllGlobals();
  });
});
