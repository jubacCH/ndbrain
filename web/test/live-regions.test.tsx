/**
 * Live regions that were mounted together with the thing they were meant to
 * announce.
 *
 * `role="status"` asks the browser to watch a node and report what changes
 * inside it. A region that is created in the same tick as its first and only
 * text has nothing to change — the whole node is new — and in every screen
 * reader that treats a polite region this way, which is all of them, the
 * message is never spoken. Almost every one in this application was written
 * that way: `{condition && <p role="status">…</p>}`.
 *
 * **What these tests assure, exactly.** That the region is in the document
 * *before* it has anything to say, and that the text later appears inside that
 * same node — node identity, compared by reference, not by shape. That is the
 * precondition for an announcement and it is the part that regressed.
 *
 * **What they do not assure.** That anything is spoken. No test in a jsdom can
 * know that: there is no accessibility tree here and no speech. Whether a
 * screen reader announces a change in a region that was already present is the
 * screen reader's business, and this only stops us handing it a region it
 * cannot possibly announce.
 *
 * The one place that was already right is the save indicator in `App.tsx`,
 * which sits in the header at all times and only changes its word. It is the
 * pattern here.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SearchView, TasksView, TidyView } from '../src/Views';
import { SettingsView } from '../src/Settings';
import type { SearchHit, TaskRow, Tasks, Tidy } from '../src/api';
import { copy } from '../src/copy';
import { DEFAULT_PREFS } from '../src/prefs';

/** Every live region on screen, as nodes, so they can be compared by reference. */
const regions = (): HTMLElement[] => screen.queryAllByRole('status');

/**
 * The region that carries `text`, asserted to be one of the nodes that were
 * already there — the whole point of the exercise.
 */
function announcedIn(before: HTMLElement[], text: string | RegExp): void {
  const carrying = regions().filter((node) =>
    typeof text === 'string' ? (node.textContent ?? '').includes(text) : text.test(node.textContent ?? ''),
  );
  expect(carrying.length, `no live region carries ${String(text)}`).toBeGreaterThan(0);
  expect(before, 'the region was created with its message, so there was nothing to announce').toContain(
    carrying[0],
  );
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

const note = (path: string) => ({
  owner: 'julian',
  path,
  title: path.replace(/\.md$/, ''),
  size: 1,
  mtimeMs: 1_700_000_000_000,
});

function tidyProps(data: Tidy) {
  return {
    data,
    selected: new Set<string>(),
    busy: false,
    tags: [],
    dirs: [],
    onToggle: vi.fn(),
    onToggleAll: vi.fn(),
    onOpen: vi.fn(),
    onBulk: vi.fn(),
  };
}

describe('narrowing the findings to one', () => {
  it('says which finding is being shown in a region that was already there', async () => {
    const user = userEvent.setup();
    const data = tidy({
      orphans: [note('Lose.md')],
      totals: { orphans: 1, untagged: 0, deadLinks: 0, stale: 0, conflicts: 0, missing: 0 },
    });
    render(<TidyView {...tidyProps(data)} health={{ notes: 10, tagsInUse: false }} />);

    const before = regions();
    expect(before.length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: /^Show the 1 orphaned/ }));
    announcedIn(before, copy.tidy.findingOrphaned);
  });

  it('reports a capped list in a region that was already there', () => {
    const { rerender } = render(<TidyView {...tidyProps(tidy())} />);
    const before = regions();

    rerender(
      <TidyView
        {...tidyProps(
          tidy({
            truncated: true,
            orphans: [note('Lose.md')],
            totals: { orphans: 40, untagged: 0, deadLinks: 0, stale: 0, conflicts: 0, missing: 0 },
          }),
        )}
      />,
    );

    announcedIn(before, '40');
  });
});

describe('the task list', () => {
  function taskProps(data: Tasks) {
    return {
      data,
      dirs: [],
      dir: undefined,
      includeDone: false,
      self: 'julian',
      busy: false,
      onDir: vi.fn(),
      onIncludeDone: vi.fn(),
      onToggle: vi.fn(),
      onOpen: vi.fn(),
    };
  }

  it('reports a capped list in a region that was already there', () => {
    const rows: TaskRow[] = [{ owner: 'julian', path: 'A.md', line: 1, done: false, text: 'Eins' }];
    const { rerender } = render(<TasksView {...taskProps({ tasks: rows, total: 1, truncated: false })} />);
    const before = regions();
    expect(before.length).toBeGreaterThan(0);

    rerender(<TasksView {...taskProps({ tasks: rows, total: 300, truncated: true })} />);
    announcedIn(before, '300');
  });
});

describe('the search view', () => {
  function searchProps(query: string, hits: SearchHit[]) {
    return {
      query,
      hits,
      filters: {},
      tags: [],
      dirs: [],
      self: 'julian',
      props: [],
      propValues: [],
      onToggleFilter: vi.fn(),
      onClearFilters: vi.fn(),
      onOpen: vi.fn(),
      onQuery: vi.fn(),
    };
  }

  it('says how many results there are in a region that was already there', () => {
    const { rerender } = render(<SearchView {...searchProps('', [])} />);
    const before = regions();
    expect(before.length).toBeGreaterThan(0);

    rerender(
      <SearchView
        {...searchProps('prox', [
          { owner: 'julian', path: 'Proxmox.md', title: 'Proxmox', size: 1, mtimeMs: 0, snippet: '' },
          { owner: 'julian', path: 'Cluster.md', title: 'Cluster', size: 1, mtimeMs: 0, snippet: '' },
        ])}
      />,
    );

    announcedIn(before, copy.search.results(2));
  });
});

describe('the settings page', () => {
  it('has somewhere to report an outcome before there is one to report', () => {
    render(
      <SettingsView
        prefs={DEFAULT_PREFS}
        onPrefs={vi.fn()}
        staleDays={90}
        onStaleDays={vi.fn()}
        user={{ id: 'julian', displayName: 'Julian', role: 'user' }}
        onSignedOutEverywhere={vi.fn()}
        onRenamed={vi.fn()}
      />,
    );

    // Nothing has been changed yet, so there is nothing to say — and that is
    // exactly when the region has to exist, or the first thing it ever holds
    // arrives with it and is never announced.
    expect(regions().length).toBeGreaterThan(0);
    expect(regions().every((node) => (node.textContent ?? '') === '')).toBe(true);
  });
});
