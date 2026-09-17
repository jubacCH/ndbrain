/**
 * The tidy-up view's conflict-copy section.
 *
 * A conflict copy is a fifth finding, and it has to behave like one: it counts
 * toward the total, it can be selected, and selecting one alone still shows the
 * delete bar — a vault that has nothing but conflict copies must not look like
 * it has no findings at all just because the shared `rows` table is empty.
 */

import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TidyView } from '../src/Views';
import type { ConflictRow, Tidy } from '../src/api';

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
    truncated: false,
    totals: { orphans: 0, untagged: 0, deadLinks: 0, stale: 0, conflicts: 0 },
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
          totals: { orphans: 2, untagged: 0, deadLinks: 1, stale: 0, conflicts: 0 },
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
        totals: { orphans: 1, untagged: 0, deadLinks: 0, stale: 0, conflicts: 1 },
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
        totals: { orphans: 1, untagged: 0, deadLinks: 0, stale: 0, conflicts: 1 },
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
        totals: { orphans: 0, untagged: 0, deadLinks: 0, stale: 0, conflicts: 5 },
      }),
    });

    expect(screen.getByRole('status')).toHaveTextContent(/1 of 5 conflict copies/i);
  });
});
