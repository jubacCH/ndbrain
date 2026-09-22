/**
 * The task list: grouped by note, filtered by folder, checkable in place.
 *
 * The one behaviour worth pinning here is what a click actually reports —
 * `onToggle` gets the exact task (text and current `done`, so the caller can
 * verify it server-side), and `onOpen` gets the line to jump to, not just the
 * note. Everything the server refuses is covered in `server/test/tasks.test.ts`;
 * this only has to prove the view asks for the right thing.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TasksView } from '../src/Views';
import type { TaskRow, Tasks } from '../src/api';

function task(path: string, line: number, text: string, done = false, owner = 'julian'): TaskRow {
  return { owner, path, line, done, text };
}

function tasks(rows: TaskRow[], total = rows.length, truncated = false): Tasks {
  return { tasks: rows, total, truncated };
}

function renderTasks(props: Partial<Parameters<typeof TasksView>[0]> = {}) {
  const handlers = {
    onDir: vi.fn(),
    onIncludeDone: vi.fn(),
    onToggle: vi.fn(),
    onOpen: vi.fn(),
  };
  render(
    <TasksView
      data={tasks([])}
      dirs={[]}
      dir={undefined}
      includeDone={false}
      self="julian"
      busy={false}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('grouping', () => {
  it('groups tasks under the note they live in', () => {
    renderTasks({
      data: tasks([
        task('Homelab/Proxmox.md', 6, 'RAM prüfen'),
        task('Homelab/Proxmox.md', 7, 'Quorum prüfen'),
        task('Journal/Heute.md', 1, 'Journal schreiben'),
      ]),
    });

    const proxmoxHeader = screen.getByText(/Proxmox\.md/).closest('tr');
    expect(within(proxmoxHeader!).getByText('Homelab')).toBeInTheDocument();
    expect(screen.getByText('RAM prüfen')).toBeInTheDocument();
    expect(screen.getByText('Quorum prüfen')).toBeInTheDocument();
    expect(screen.getByText('Journal schreiben')).toBeInTheDocument();
  });

  it('marks a task from a shared vault with its owner', () => {
    renderTasks({
      data: tasks([task('Team/Plan.md', 1, 'Abstimmen', false, 'ramona')]),
      self: 'julian',
    });

    const header = screen.getByText(/Plan\.md/).closest('tr');
    expect(within(header!).getByText('ramona')).toBeInTheDocument();
  });
});

describe('toggling', () => {
  it('reports the exact task, not just its path', async () => {
    const user = userEvent.setup();
    const target = task('Homelab/Proxmox.md', 6, 'RAM prüfen');
    const { onToggle } = renderTasks({ data: tasks([target]) });

    await user.click(screen.getByRole('checkbox', { name: /RAM prüfen/ }));

    expect(onToggle).toHaveBeenCalledWith(target);
  });

  it('disables every checkbox while a toggle is in flight', () => {
    renderTasks({ data: tasks([task('A.md', 1, 'eins')]), busy: true });
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });
});

describe('opening', () => {
  it('opens the exact line a task sits on, not just the note', async () => {
    const user = userEvent.setup();
    const { onOpen } = renderTasks({
      data: tasks([task('Homelab/Proxmox.md', 6, 'RAM prüfen')]),
    });

    await user.click(screen.getByText('RAM prüfen'));

    expect(onOpen).toHaveBeenCalledWith('julian', 'Homelab/Proxmox.md', 6);
  });

  it('opens the note at its first task from the group header', async () => {
    const user = userEvent.setup();
    const { onOpen } = renderTasks({
      data: tasks([
        task('Homelab/Proxmox.md', 6, 'RAM prüfen'),
        task('Homelab/Proxmox.md', 9, 'Quorum prüfen'),
      ]),
    });

    await user.click(screen.getByText(/Proxmox\.md/));

    expect(onOpen).toHaveBeenCalledWith('julian', 'Homelab/Proxmox.md', 6);
  });
});

describe('filters', () => {
  it('offers the folders it was given and reports a pick', async () => {
    const user = userEvent.setup();
    const { onDir } = renderTasks({ dirs: ['Homelab', 'Journal'] });

    await user.click(screen.getByRole('button', { name: 'Homelab' }));

    expect(onDir).toHaveBeenCalledWith('Homelab');
  });

  it('clears the active folder on a second click', async () => {
    const user = userEvent.setup();
    const { onDir } = renderTasks({ dirs: ['Homelab'], dir: 'Homelab' });

    await user.click(screen.getByRole('button', { name: 'Homelab' }));

    expect(onDir).toHaveBeenCalledWith(undefined);
  });

  it('reports the "show done" toggle', async () => {
    const user = userEvent.setup();
    const { onIncludeDone } = renderTasks({ includeDone: false });

    await user.click(screen.getByRole('button', { name: /show done/i }));

    expect(onIncludeDone).toHaveBeenCalledWith(true);
  });
});

describe('honesty about what is shown', () => {
  it('says so when the list was capped', () => {
    renderTasks({ data: tasks([task('A.md', 1, 'eins')], 40, true) });
    expect(screen.getByRole('status')).toHaveTextContent('1');
    expect(screen.getByRole('status')).toHaveTextContent('40');
  });

  it('does not claim a cap that did not happen', () => {
    renderTasks({ data: tasks([task('A.md', 1, 'eins')], 1, false) });
    // The live region stays — that is what lets it announce later — and says
    // nothing. What must be absent is the claim, not the place to put it.
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('tells an empty vault apart from an empty filter result', () => {
    const { rerender } = render(
      <TasksView
        data={tasks([])}
        dirs={[]}
        dir={undefined}
        includeDone={false}
        self="julian"
        busy={false}
        onDir={vi.fn()}
        onIncludeDone={vi.fn()}
        onToggle={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText(/no open tasks\./i)).toBeInTheDocument();

    rerender(
      <TasksView
        data={tasks([])}
        dirs={['Homelab']}
        dir="Homelab"
        includeDone={false}
        self="julian"
        busy={false}
        onDir={vi.fn()}
        onIncludeDone={vi.fn()}
        onToggle={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText(/no open tasks match this filter/i)).toBeInTheDocument();
  });
});

/**
 * Both ways into a note from this list were an `onClick` on a table cell: the
 * note header above a group, and the task text itself. The keyboard reached the
 * checkbox that ticks a task off and nothing else — there was no way to go and
 * read the task where it was written.
 */
describe('opening a task without a mouse', () => {
  function renderTwo() {
    return renderTasks({
      data: tasks([
        task('Homelab/Proxmox.md', 6, 'RAM prüfen'),
        task('Homelab/Proxmox.md', 9, 'Quorum prüfen'),
      ]),
    });
  }

  it('lets Tab reach the note header and Enter open it at its first task', async () => {
    const user = userEvent.setup();
    const { onOpen } = renderTwo();

    const header = screen.getByRole('button', { name: /Proxmox\.md/ });

    const reached: Element[] = [];
    for (let step = 0; step < 12; step += 1) {
      await user.tab();
      reached.push(document.activeElement!);
    }
    expect(reached).toContain(header);

    header.focus();
    await user.keyboard('{Enter}');
    expect(onOpen.mock.calls).toEqual([['julian', 'Homelab/Proxmox.md', 6]]);
  });

  it('lets Tab reach a task and Enter open it at its own line', async () => {
    const user = userEvent.setup();
    const { onOpen } = renderTwo();

    const second = screen.getByRole('button', { name: 'Quorum prüfen' });

    const reached: Element[] = [];
    for (let step = 0; step < 12; step += 1) {
      await user.tab();
      reached.push(document.activeElement!);
    }
    expect(reached).toContain(second);

    second.focus();
    await user.keyboard('{Enter}');
    expect(onOpen.mock.calls).toEqual([['julian', 'Homelab/Proxmox.md', 9]]);
  });

  it('counts one click on a task once, not twice', async () => {
    const user = userEvent.setup();
    const { onOpen } = renderTwo();

    await user.click(screen.getByRole('button', { name: 'RAM prüfen' }));
    expect(onOpen.mock.calls).toEqual([['julian', 'Homelab/Proxmox.md', 6]]);
  });
});
