/**
 * The task list views: what a click reports.
 *
 * The server's side — locks, shares, per-field merging — is covered in
 * `server/test/tasklists.test.ts`. What has to be proved here is that each
 * control asks for the change it means, and for nothing more: a tick is a
 * status, a title is written when it is left and not on every key, and a list
 * somebody may only read offers nothing to change.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_STATUSES, type TaskListFile, type TaskListItem } from '../../shared/tasklist';
import { TaskListView, TaskListsView, type TaskChanges } from '../src/TaskLists';

function task(id: string, extra: Partial<TaskListItem> = {}): TaskListItem {
  return {
    id,
    title: `Task ${id}`,
    status: 'todo',
    priority: null,
    assignees: [],
    start: null,
    due: null,
    tags: [],
    description: '',
    parent: null,
    order: id,
    created: '2026-10-25T09:00:00.000Z',
    updated: '2026-10-25T09:00:00.000Z',
    ...extra,
  };
}

function list(tasks: TaskListItem[]): TaskListFile {
  return { ndbrain: 'tasklist/1', statuses: [...DEFAULT_STATUSES], tasks };
}

function renderList(tasks: TaskListItem[], canWrite = true) {
  const changes: TaskChanges = {
    add: vi.fn(async () => undefined),
    patch: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  };
  render(
    <TaskListView
      name="Website"
      list={list(tasks)}
      canWrite={canWrite}
      self="julian"
      people={[
        { id: 'ramona', name: 'Ramona' },
        { id: 'julian', name: 'Julian', self: true },
      ]}
      today="2026-10-25"
      onBack={() => undefined}
      changes={changes}
    />,
  );
  return changes;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a row', () => {
  it('ticks a task into the done status', async () => {
    const changes = renderList([task('a')]);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Mark “Task a” done' }));
    expect(changes.patch).toHaveBeenCalledWith('a', { status: 'done' });
  });

  it('changes one field from its own control', async () => {
    const changes = renderList([task('a')]);
    const row = screen.getByRole('button', { name: 'Open “Task a”' }).closest('tr')!;
    await userEvent.selectOptions(within(row).getByRole('combobox', { name: 'Priority' }), 'high');
    expect(changes.patch).toHaveBeenCalledWith('a', { priority: 'high' });
  });

  it('offers nothing to change in a list that may only be read', () => {
    renderList([task('a')], false);
    expect(screen.getByRole('checkbox', { name: 'Mark “Task a” done' })).toBeDisabled();
    expect(screen.queryByRole('textbox', { name: 'Add a task' })).toBeNull();
  });
});

describe('adding', () => {
  it('adds a task from the field on Enter, and clears it', async () => {
    const changes = renderList([]);
    const field = screen.getByRole('textbox', { name: 'Add a task' });
    await userEvent.type(field, 'Send the offer{Enter}');
    expect(changes.add).toHaveBeenCalledWith({ title: 'Send the offer' });
    expect(field).toHaveValue('');
  });
});

describe('the detail', () => {
  it('writes a title once, when it is left', async () => {
    const changes = renderList([task('a')]);
    await userEvent.click(screen.getByRole('button', { name: 'Open “Task a”' }));
    const detail = screen.getByRole('complementary');
    const title = within(detail).getByRole('textbox', { name: 'Title' });
    await userEvent.clear(title);
    await userEvent.type(title, 'Offerte');
    expect(changes.patch).not.toHaveBeenCalled();
    await userEvent.tab();
    expect(changes.patch).toHaveBeenCalledTimes(1);
    expect(changes.patch).toHaveBeenCalledWith('a', { title: 'Offerte' });
  });

  it('assigns a person and adds a subtask under the task', async () => {
    const changes = renderList([task('a')]);
    await userEvent.click(screen.getByRole('button', { name: 'Open “Task a”' }));
    const detail = screen.getByRole('complementary');
    await userEvent.click(within(detail).getByRole('checkbox', { name: 'Ramona' }));
    expect(changes.patch).toHaveBeenCalledWith('a', { assignees: ['ramona'] });
    await userEvent.type(within(detail).getByRole('textbox', { name: 'Add a subtask' }), 'Texte{Enter}');
    expect(changes.add).toHaveBeenCalledWith({ title: 'Texte', parent: 'a' });
  });

  it('asks before deleting, and says how many subtasks go with it', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const changes = renderList([task('a'), task('b', { parent: 'a' })]);
    await userEvent.click(screen.getByRole('button', { name: 'Open “Task a”' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete task' }));
    expect(confirm).toHaveBeenCalledWith('Delete “Task a” and its 1 subtask?');
    expect(changes.remove).toHaveBeenCalledWith('a');
  });
});

describe('every list', () => {
  it('creates a list at the typed path, with the suffix added', async () => {
    const onCreate = vi.fn();
    render(
      <TaskListsView
        lists={[]}
        self="julian"
        vaults={[{ id: 'julian', label: 'Julian' }]}
        busy={false}
        onOpen={() => undefined}
        onCreate={onCreate}
      />,
    );
    await userEvent.type(screen.getByRole('textbox', { name: 'New task list' }), 'Kunden/Acme/Website');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).toHaveBeenCalledWith('julian', 'Kunden/Acme/Website.tasks.json');
  });

  it('opens a list from its row', async () => {
    const onOpen = vi.fn();
    render(
      <TaskListsView
        lists={[{ owner: 'julian', path: 'Kunden/Acme/Website.tasks.json', canWrite: true }]}
        self="julian"
        vaults={[{ id: 'julian', label: 'Julian' }]}
        busy={false}
        onOpen={onOpen}
        onCreate={() => undefined}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Website/ }));
    expect(onOpen).toHaveBeenCalledWith('julian', 'Kunden/Acme/Website.tasks.json');
  });
});

describe('the board', () => {
  async function toBoard(): Promise<void> {
    await userEvent.click(screen.getByRole('button', { name: 'Board' }));
  }

  it('shows a column per status and moves a card by its status menu', async () => {
    const changes = renderList([task('a'), task('b', { status: 'done' })]);
    await toBoard();
    expect(screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'))).toEqual([
      'To do',
      'In progress',
      'Done',
    ]);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status of “Task a”' }), 'doing');
    expect(changes.patch).toHaveBeenCalledWith('a', { status: 'doing' });
  });

  it('opens a card on a click, and a drag onto another column moves it there', async () => {
    const changes = renderList([task('a'), task('b', { status: 'done', order: 'b' })]);
    await toBoard();

    await userEvent.click(screen.getByRole('button', { name: 'Open “Task a”' }));
    expect(screen.getByRole('complementary')).toBeInTheDocument();

    // jsdom lays nothing out, so the point under the pointer is said by hand:
    // whatever is asked about, it is the Done column. Every card there has a
    // zero-sized box, so the drop lands below them all.
    const done = screen.getByRole('region', { name: 'Done' });
    const original = document.elementFromPoint;
    document.elementFromPoint = () => done;
    try {
      const card = screen.getByRole('button', { name: 'Open “Task a”' }).closest('article')!;
      fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(window, { clientX: 200, clientY: 40 });
      fireEvent.pointerUp(window, { clientX: 200, clientY: 40 });
    } finally {
      document.elementFromPoint = original;
    }

    expect(changes.patch).toHaveBeenCalledTimes(1);
    const [id, set] = (changes.patch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(id).toBe('a');
    expect(set.status).toBe('done');
    // Below `b`, the one card already there.
    expect(set.order > 'b').toBe(true);
  });

  it('writes nothing for a press that never became a drag', async () => {
    const changes = renderList([task('a')]);
    await toBoard();
    // A column under the pointer, so that only the threshold stands between
    // this wobble and a move into Done.
    const done = screen.getByRole('region', { name: 'Done' });
    const original = document.elementFromPoint;
    document.elementFromPoint = () => done;
    try {
      const card = screen.getByRole('button', { name: 'Open “Task a”' }).closest('article')!;
      fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(window, { clientX: 12, clientY: 11 });
      fireEvent.pointerUp(window, { clientX: 12, clientY: 11 });
    } finally {
      document.elementFromPoint = original;
    }
    expect(changes.patch).not.toHaveBeenCalled();
  });
});
