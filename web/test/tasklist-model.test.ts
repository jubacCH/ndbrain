/**
 * What the list view shows: the rules in `taskListModel.ts`, without React.
 *
 * The ones that would be easy to get quietly wrong are pinned here: subtasks
 * stay under their parent whatever the grouping, a subtask the filter wants is
 * not hidden because its parent is not wanted, and an undated task is never
 * the first thing due.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_STATUSES, type TaskListFile, type TaskListItem } from '../../shared/tasklist';
import {
  NO_FILTER,
  dueBucket,
  groupTasks,
  listPathFor,
  toggledStatus,
} from '../src/taskListModel';

function task(id: string, extra: Partial<TaskListItem> = {}): TaskListItem {
  return {
    id,
    title: id,
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

const TODAY = '2026-10-25';

function ids(groups: ReturnType<typeof groupTasks>): string[][] {
  return groups.map((group) => group.rows.map((row) => `${'  '.repeat(row.depth)}${row.task.id}`));
}

describe('grouping', () => {
  it('follows the order of the list\'s own statuses, and leaves empty ones out', () => {
    const groups = groupTasks(
      list([task('b', { status: 'done' }), task('a')]),
      NO_FILTER,
      'status',
      'order',
      'me',
      TODAY,
    );
    expect(groups.map((group) => group.key)).toEqual(['todo', 'done']);
  });

  it('keeps a subtask under its parent, even in another status', () => {
    const groups = groupTasks(
      list([task('a'), task('b', { parent: 'a', status: 'done' }), task('c', { parent: 'b' })]),
      NO_FILTER,
      'status',
      'order',
      'me',
      TODAY,
    );
    expect(ids(groups)).toEqual([['a', '  b', '    c']]);
  });

  it('shows a wanted subtask at the top when its parent is filtered out', () => {
    const groups = groupTasks(
      list([task('parent', { status: 'done' }), task('child', { parent: 'parent' })]),
      { ...NO_FILTER, hideDone: true },
      'none',
      'order',
      'me',
      TODAY,
    );
    expect(ids(groups)).toEqual([['child']]);
  });

  it('buckets due dates from today', () => {
    expect(dueBucket('2026-10-24', TODAY)).toBe('overdue');
    expect(dueBucket(TODAY, TODAY)).toBe('today');
    expect(dueBucket('2026-10-31', TODAY)).toBe('week');
    expect(dueBucket('2026-11-01', TODAY)).toBe('later');
    expect(dueBucket(null, TODAY)).toBe('none');
    // Across a month and a year end, as calendar days rather than as text.
    expect(dueBucket('2027-01-02', '2026-12-30')).toBe('week');
  });

  it('survives a parent loop a hand edit put in the file', () => {
    const groups = groupTasks(
      list([task('a', { parent: 'b' }), task('b', { parent: 'a' })]),
      NO_FILTER,
      'none',
      'order',
      'me',
      TODAY,
    );
    // Each has the other as parent, so followed naively neither reaches the
    // top and both vanish. Shown at the top instead, and without a hang.
    expect(ids(groups)).toEqual([['a', 'b']]);
  });
});

describe('filtering', () => {
  const tasks = list([
    task('mine', { assignees: ['me'], title: 'Offerte schicken', tags: ['kunde'] }),
    task('theirs', { assignees: ['ramona'], description: 'Offerte prüfen' }),
    task('done', { status: 'done' }),
  ]);
  const shown = (filter: Partial<typeof NO_FILTER>): string[] =>
    ids(groupTasks(tasks, { ...NO_FILTER, ...filter }, 'none', 'order', 'me', TODAY)).flat();

  it('by words in the title, the description or a tag, all of them', () => {
    expect(shown({ text: 'offerte' })).toEqual(['mine', 'theirs']);
    expect(shown({ text: 'offerte kunde' })).toEqual(['mine']);
  });

  it('by assignee, status and doneness', () => {
    expect(shown({ mine: true })).toEqual(['mine']);
    expect(shown({ statuses: ['done'] })).toEqual(['done']);
    expect(shown({ hideDone: true })).toEqual(['mine', 'theirs']);
  });
});

describe('sorting', () => {
  it('puts undated tasks last when sorting by due date', () => {
    const groups = groupTasks(
      list([task('none'), task('later', { due: '2026-12-01' }), task('soon', { due: '2026-10-26' })]),
      NO_FILTER,
      'none',
      'due',
      'me',
      TODAY,
    );
    expect(ids(groups)).toEqual([['soon', 'later', 'none']]);
  });

  it('puts urgent first and no priority last', () => {
    const groups = groupTasks(
      list([task('none'), task('low', { priority: 'low' }), task('urgent', { priority: 'urgent' })]),
      NO_FILTER,
      'none',
      'priority',
      'me',
      TODAY,
    );
    expect(ids(groups)).toEqual([['urgent', 'low', 'none']]);
  });
});

describe('small rules', () => {
  it('ticks a task into the first done status and back into the first open one', () => {
    const tasks = list([task('a'), task('b', { status: 'done' })]);
    expect(toggledStatus(tasks, tasks.tasks[0]!)).toBe('done');
    expect(toggledStatus(tasks, tasks.tasks[1]!)).toBe('todo');
  });

  it('makes a list path out of what was typed', () => {
    expect(listPathFor('Kunden/Acme/Website')).toBe('Kunden/Acme/Website.tasks.json');
    expect(listPathFor(' /Website.tasks.json/ ')).toBe('Website.tasks.json');
    expect(listPathFor('   ')).toBeNull();
  });
});
