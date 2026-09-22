/**
 * The tidy-up view's two sections that do not fit the shared findings table.
 *
 * A conflict copy is a fifth finding, and it has to behave like one: it counts
 * toward the total, it can be selected, and selecting one alone still shows the
 * delete bar — a vault that has nothing but conflict copies must not look like
 * it has no findings at all just because the shared `rows` table is empty.
 *
 * "Asked for, never written" is the opposite case and is checked for the
 * opposite thing. It is the broken links regrouped, so it must *not* count
 * again, must not be selectable, and above all must not appear at all on a
 * vault whose data does not carry it.
 */

import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TidyView } from '../src/Views';
import type { ConflictRow, LinkRow, Tidy } from '../src/api';
import { copy } from '../src/copy';

function conflict(overrides: Partial<ConflictRow> = {}): ConflictRow {
  return {
    owner: 'julian',
    path: 'Projekt/Plan (Konflikt 2026-09-11 10.58).md',
    title: 'Plan (Konflikt 2026-09-11 10.58)',
    size: 42,
    mtimeMs: 1_700_000_000_000,
    originalPath: 'Projekt/Plan.md',
    originalTitle: 'Plan',
    originalExists: true,
    at: 1_699_999_000_000,
    ...overrides,
  };
}

function tidy(overrides: Partial<Tidy> = {}): Tidy {
  return {
    orphans: [],
    untagged: [],
    deadLinks: [],
    stale: [],
    conflicts: [],
    missing: [],
    truncated: false,
    totals: { orphans: 0, untagged: 0, deadLinks: 0, stale: 0, conflicts: 0, missing: 0 },
    ...overrides,
  };
}

function renderTidy(props: Partial<Parameters<typeof TidyView>[0]> = {}) {
  const handlers = {
    onToggle: vi.fn(),
    onToggleAll: vi.fn(),
    onOpen: vi.fn(),
    onBulk: vi.fn(),
  };
  render(
    <TidyView
      data={tidy()}
      selected={new Set<string>()}
      busy={false}
      tags={[]}
      dirs={[]}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe('narrowing to one finding', () => {
  function Harness({ onBulk }: { onBulk: (paths: string[]) => void }): React.JSX.Element {
    // The shell's own selection rules, as App.tsx has them.
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const note = (path: string) => ({ owner: 'julian', path, title: path.replace(/\.md$/, ''), size: 1, mtimeMs: 1_700_000_000_000 });
    return (
      <TidyView
        data={tidy({
          orphans: [note('Allein.md'), note('Einsam.md')],
          deadLinks: [{ owner: 'julian', source: 'Kaputt.md', targetRaw: 'Nirgends', targetPath: null, heading: null, alias: null, offset: 0 }],
          totals: { orphans: 2, untagged: 0, deadLinks: 1, stale: 0, conflicts: 0, missing: 0 },
        })}
        selected={selected}
        busy={false}
        tags={[]}
        dirs={[]}
        health={{ notes: 10, tagsInUse: false }}
        onToggle={(path) => setSelected((c) => { const n = new Set(c); if (n.has(path)) n.delete(path); else n.add(path); return n; })}
        onToggleAll={(paths) => setSelected((c) => (c.size === paths.length ? new Set() : new Set(paths)))}
        onKeepSelected={(paths) => setSelected((c) => new Set([...c].filter((p) => paths.includes(p))))}
        onOpen={vi.fn()}
        onBulk={() => onBulk([...selected])}
      />
    );
  }

  it('drops selected rows that are no longer shown, so the bulk action cannot reach them', async () => {
    const onBulk = vi.fn();
    render(<Harness onBulk={onBulk} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all' }));
    expect(screen.getByText('3 selected')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Show the 1 broken/ }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(onBulk).toHaveBeenCalledWith(['Kaputt.md']);

    // Widening again does not bring the dropped rows back.
    await userEvent.click(screen.getByRole('button', { name: /^Show the 1 broken/ }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });
});

describe('a vault with only conflict copies', () => {
  it('still shows the delete bar, not just checkboxes with nothing to act on', () => {
    renderTidy({ data: tidy({ conflicts: [conflict()] }) });

    // The bar the other findings share — same delete button, no second one.
    expect(screen.getByRole('button', { name: 'Delete…' })).toBeInTheDocument();
  });

  it('draws delete as the destructive button, not the accent', () => {
    renderTidy({ data: tidy({ conflicts: [conflict()] }) });
    const button = screen.getByRole('button', { name: 'Delete…' });
    expect(button).toHaveClass('btn-danger');
    expect(button).not.toHaveClass('btn-solid');
  });

  it('counts the conflict copy in the header, with no other finding present', () => {
    renderTidy({ data: tidy({ conflicts: [conflict(), conflict({ path: 'Zwei (Konflikt 2026-09-11 10.58).md' })] }) });

    expect(screen.getByText(/2 findings/i)).toBeInTheDocument();
  });
});

describe('the original-is-gone pill', () => {
  it('uses the warning colour, not the critical one — a missing original is a warning', () => {
    renderTidy({
      data: tidy({ conflicts: [conflict({ originalExists: false, originalTitle: null })] }),
    });

    const pill = screen.getByText('Original is gone');
    expect(pill.className).toContain('p-warn');
    expect(pill.className).not.toContain('p-crit');
  });
});

describe('copy and original, side by side', () => {
  it('opens the copy and the original independently', async () => {
    const user = userEvent.setup();
    const { onOpen } = renderTidy({ data: tidy({ conflicts: [conflict()] }) });

    await user.click(screen.getByRole('button', { name: 'Plan (Konflikt 2026-09-11 10.58)' }));
    expect(onOpen).toHaveBeenCalledWith('Projekt/Plan (Konflikt 2026-09-11 10.58).md');

    await user.click(screen.getByRole('button', { name: 'Plan' }));
    expect(onOpen).toHaveBeenCalledWith('Projekt/Plan.md');
  });

  it('checks the copy in, ready for the shared bulk action', async () => {
    const user = userEvent.setup();
    const { onToggle } = renderTidy({ data: tidy({ conflicts: [conflict()] }) });

    const row = screen.getByText('Plan (Konflikt 2026-09-11 10.58)').closest('tr');
    expect(row).not.toBeNull();
    await user.click(within(row as HTMLElement).getByRole('checkbox'));
    expect(onToggle).toHaveBeenCalledWith('Projekt/Plan (Konflikt 2026-09-11 10.58).md');
  });

  it('deletes a selected copy through the shared bulk action — no dedicated button', async () => {
    const user = userEvent.setup();
    const copyPath = 'Projekt/Plan (Konflikt 2026-09-11 10.58).md';
    const { onBulk } = renderTidy({
      data: tidy({ conflicts: [conflict()] }),
      selected: new Set([copyPath]),
    });

    // One delete button for the whole view — not a second one scoped to this
    // section — and it is enabled once the copy alone is selected.
    const deleteButton = screen.getByRole('button', { name: 'Delete…' });
    expect(deleteButton).toBeEnabled();
    await user.click(deleteButton);
    expect(onBulk).toHaveBeenCalledWith('delete');
  });
});

describe('"select all"', () => {
  it('takes conflict copies with it, not just the four findings above them', async () => {
    const user = userEvent.setup();
    const { onToggleAll } = renderTidy({
      data: tidy({
        orphans: [
          { owner: 'julian', path: 'Verirrt.md', title: 'Verirrt', size: 1, mtimeMs: 1 },
        ],
        conflicts: [conflict()],
        totals: { orphans: 1, untagged: 0, deadLinks: 0, stale: 0, conflicts: 1, missing: 0 },
      }),
    });

    const selectAllBoxes = screen.getAllByRole('checkbox', { name: 'Select all' });
    // One in the findings table, one in the conflicts table — both drive the
    // same selection, so either one selects everything.
    expect(selectAllBoxes).toHaveLength(2);
    await user.click(selectAllBoxes[0] as HTMLElement);

    expect(onToggleAll).toHaveBeenCalledWith(
      expect.arrayContaining(['Verirrt.md', 'Projekt/Plan (Konflikt 2026-09-11 10.58).md']),
    );
    expect((onToggleAll.mock.calls[0]?.[0] as string[]).length).toBe(2);
  });

  it('shows as checked once every finding, conflicts included, is selected', () => {
    renderTidy({
      data: tidy({
        orphans: [{ owner: 'julian', path: 'Verirrt.md', title: 'Verirrt', size: 1, mtimeMs: 1 }],
        conflicts: [conflict()],
        totals: { orphans: 1, untagged: 0, deadLinks: 0, stale: 0, conflicts: 1, missing: 0 },
      }),
      selected: new Set(['Verirrt.md', 'Projekt/Plan (Konflikt 2026-09-11 10.58).md']),
    });

    for (const box of screen.getAllByRole('checkbox', { name: 'Select all' })) {
      expect(box).toBeChecked();
    }
  });
});

describe('a truncated answer', () => {
  it('names conflict copies among what was left out, not just orphaned and untagged', () => {
    renderTidy({
      data: tidy({
        conflicts: [conflict()],
        truncated: true,
        totals: { orphans: 0, untagged: 0, deadLinks: 0, stale: 0, conflicts: 5, missing: 0 },
      }),
    });

    expect(screen.getByRole('status')).toHaveTextContent(/1 of 5 conflict copies/i);
  });
});

/**
 * "Asked for, never written" — the answer to the briefing's "What's missing?"
 * that the index can actually give.
 *
 * The section states two things and no third: a name, and the notes that link
 * to it. Everything below is about the line it must not cross — it never says a
 * subject is neglected, it never appears on a vault whose data does not carry
 * it, and it does not turn into a sixth finding, because the broken links it is
 * made of are counted once already.
 */
describe('asked for, never written', () => {
  const link = (source: string, targetRaw: string): LinkRow => ({
    owner: 'julian',
    source,
    targetRaw,
    targetPath: null,
    heading: null,
    alias: null,
    offset: 0,
  });

  const pricing = tidy({
    deadLinks: [link('Services.md', 'Pricing'), link('Offer.md', 'Pricing')],
    missing: [{ owner: 'julian', name: 'Pricing', asked: ['Offer.md', 'Services.md'] }],
    totals: { orphans: 0, untagged: 0, deadLinks: 2, stale: 0, conflicts: 0, missing: 1 },
  });

  it('names the gap, counts the notes that ask, and lists every one of them', () => {
    renderTidy({ data: pricing });

    const section = screen.getByRole('region', { name: copy.tidy.missing.title });
    expect(within(section).getByText('Pricing')).toBeInTheDocument();
    expect(within(section).getByText('2 notes link to this name')).toBeInTheDocument();
    // The sources, per briefing point 28: the claim is checkable where it came from.
    expect(within(section).getByRole('button', { name: 'Open Offer.md' })).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Open Services.md' })).toBeInTheDocument();
  });

  it('opens the note that asks', async () => {
    const user = userEvent.setup();
    const { onOpen } = renderTidy({ data: pricing });

    await user.click(screen.getByRole('button', { name: 'Open Services.md' }));
    expect(onOpen).toHaveBeenCalledWith('Services.md');
  });

  /**
   * The promise of this whole strand: a number the data does not carry is left
   * out, not softened. A vault with broken links but no name asked for twice
   * gets no section at all — not an empty one saying the vault is complete,
   * which would be a claim about knowledge nobody counted.
   */
  it('is absent altogether when nothing was asked for twice', () => {
    renderTidy({
      data: tidy({
        deadLinks: [link('Services.md', 'Pricing')],
        totals: { orphans: 0, untagged: 0, deadLinks: 1, stale: 0, conflicts: 0, missing: 0 },
      }),
    });

    expect(screen.queryByRole('region', { name: copy.tidy.missing.title })).toBeNull();
    // The broken link itself is still a finding, and still says so.
    expect(screen.getByText('broken link')).toBeInTheDocument();
  });

  it('does not become a sixth finding: the links behind it are counted once', () => {
    renderTidy({ data: pricing });

    expect(screen.getByText(/^2 findings/)).toBeInTheDocument();
  });

  it('stays out of sight while another finding is being worked through', async () => {
    const user = userEvent.setup();
    renderTidy({
      data: tidy({
        ...pricing,
        orphans: [{ owner: 'julian', path: 'Verirrt.md', title: 'Verirrt', size: 1, mtimeMs: 1 }],
        totals: { ...pricing.totals, orphans: 1 },
      }),
      health: { notes: 10, tagsInUse: false },
    });

    // It belongs to the broken links, so narrowing to those keeps it…
    await user.click(screen.getByRole('button', { name: /^Show the 2 broken/ }));
    expect(screen.getByRole('region', { name: copy.tidy.missing.title })).toBeInTheDocument();

    // …and narrowing to anything else takes it away with them.
    await user.click(screen.getByRole('button', { name: /^Show the 1 orphaned/ }));
    expect(screen.queryByRole('region', { name: copy.tidy.missing.title })).toBeNull();
  });
});
