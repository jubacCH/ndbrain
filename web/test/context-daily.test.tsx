/**
 * The panel beside the editor, for a daily note.
 *
 * It follows the same rule as the server's findings, from the same function:
 * yesterday and tomorrow not written yet are a way to go, not "points nowhere",
 * and a day nothing links to is not "orphaned". A real typo in the same note
 * is still a broken link, and an ordinary note keeps both findings.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, type LinkRow } from '../src/api';
import { ContextPanel } from '../src/Context';
import { copy } from '../src/copy';

const DAY = '50_Journal/2026/09/2026-09-17.md';

function link(source: string, targetRaw: string, targetPath: string | null, alias: string | null = null, offset = 0): LinkRow {
  return { owner: 'julian', source, targetRaw, targetPath, heading: null, alias, offset };
}

function renderPanel(path: string, outgoing: LinkRow[], owner = 'julian', canCreate = true) {
  vi.spyOn(api, 'links').mockResolvedValue({ backlinks: [], outgoing });
  vi.spyOn(api, 'history').mockResolvedValue({ available: false, versions: [] });
  const onCreate = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ContextPanel
        note={{ owner, path }}
        self="julian"
        canCreate={canCreate}
        onRestored={vi.fn()}
        onOpen={vi.fn()}
        onCreate={onCreate}
      />
    </QueryClientProvider>,
  );
  return { onCreate };
}

const section = (heading: RegExp): HTMLElement => screen.getByRole('heading', { name: heading }).closest('section')!;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the context panel for a daily note', () => {
  it('lists yesterday and tomorrow as links out, not as pointing nowhere, and keeps a typo red', async () => {
    const { onCreate } = renderPanel(DAY, [
      link(DAY, '50_Journal/2026/09/2026-09-16', null, '2026-09-16', 10),
      link(DAY, '50_Journal/2026/09/2026-09-18', null, '2026-09-18', 20),
      link(DAY, 'Tippfehler', null, null, 30),
    ]);

    await screen.findByRole('heading', { name: /Links out · 2/ });
    const out = section(/Links out · 2/);
    expect(await within(out).findByRole('button', { name: /2026-09-16/ })).toBeInTheDocument();
    expect(within(out).getByRole('button', { name: /2026-09-18/ })).toBeInTheDocument();

    const nowhere = section(/Points nowhere · 1/);
    expect(within(nowhere).getByText('Tippfehler')).toHaveClass('p-crit');
    expect(within(nowhere).queryByText(/2026-09-1[68]/)).toBeNull();

    expect(screen.getByText(copy.context.noLinksToDay)).toBeInTheDocument();
    expect(screen.queryByText(copy.context.orphanedNote)).toBeNull();

    await userEvent.click(within(out).getByRole('button', { name: /2026-09-18/ }));
    expect(onCreate).toHaveBeenCalledWith('50_Journal/2026/09/2026-09-18');
  });

  it('offers no way to start a day in somebody else’s journal', async () => {
    renderPanel(DAY, [link(DAY, '50_Journal/2026/09/2026-09-18', null, '2026-09-18')], 'anna');
    expect(await screen.findByRole('button', { name: /2026-09-18/ })).toBeDisabled();
  });

  it('leaves an ordinary note with its findings', async () => {
    renderPanel('Plan.md', [link('Plan.md', '50_Journal/2026/09/2026-09-18', null, '2026-09-18')]);
    const nowhere = await screen.findByRole('heading', { name: /Points nowhere · 1/ });
    expect(within(nowhere.closest('section')!).getByText('50_Journal/2026/09/2026-09-18')).toHaveClass('p-crit');
    expect(screen.getByText(copy.context.orphanedNote)).toBeInTheDocument();
  });
});
