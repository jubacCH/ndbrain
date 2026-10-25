/**
 * The task list file and the rules around it, without a server.
 *
 * Two of these carry more weight than they look like:
 *
 *  - **`orderBetween` must always find room.** A board that cannot place a card
 *    between two others has to renumber a column, which is a write to every
 *    task in it — the thing fractional positions exist to avoid. So it is
 *    asked thousands of times, at the ends and in the middle.
 *  - **A key this version does not know survives a rewrite.** Otherwise the
 *    first older server to touch a list written by a newer one would quietly
 *    drop whatever the newer one added.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_STATUSES,
  TASKLIST_FORMAT,
  TaskListFile,
  isTaskListPath,
  orderBetween,
  serializeTaskList,
  taskListName,
} from '../../shared/tasklist.js';
import { parseTaskList } from '../src/tasklists/service.js';
import { TaskListInvalidError } from '../src/errors.js';

const TASK = {
  id: 'k7Qm2xR9',
  title: 'Send the offer',
  status: 'todo',
  priority: 'high',
  assignees: ['julian'],
  start: null,
  due: '2026-10-30',
  tags: ['kunde'],
  description: '',
  parent: null,
  order: 'V',
  created: '2026-10-25T09:12:00.000Z',
  updated: '2026-10-25T09:12:00.000Z',
};

function list(tasks: unknown[] = [TASK]): unknown {
  return { ndbrain: TASKLIST_FORMAT, statuses: DEFAULT_STATUSES, tasks };
}

describe('the name and the suffix', () => {
  it('knows a list by its suffix, in any letter case', () => {
    expect(isTaskListPath('Kunden/Acme/Website.tasks.json')).toBe(true);
    expect(isTaskListPath('Website.TASKS.JSON')).toBe(true);
    expect(isTaskListPath('Website.json')).toBe(false);
    expect(isTaskListPath('Website.tasks.json.md')).toBe(false);
  });

  it('names a list after its file, as a note is named', () => {
    expect(taskListName('Kunden/Acme/Website.tasks.json')).toBe('Website');
  });
});

describe('orderBetween', () => {
  it('places between, before and after', () => {
    const first = orderBetween(null, null);
    const after = orderBetween(first, null);
    const before = orderBetween(null, first);
    const middle = orderBetween(first, after);
    expect([before, first, middle, after]).toEqual([...[before, first, middle, after]].sort());
    expect(new Set([before, first, middle, after]).size).toBe(4);
  });

  it('always finds room, and never ends a key in a zero', () => {
    // Insert repeatedly at random places in a growing column. Each new key
    // must land strictly between its neighbours, and the column must stay in
    // order as plain string comparison sees it.
    let seed = 42;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const column: string[] = [];
    for (let i = 0; i < 3000; i += 1) {
      const at = Math.floor(random() * (column.length + 1));
      const key = orderBetween(column[at - 1] ?? null, column[at] ?? null);
      expect(key.endsWith('0')).toBe(false);
      column.splice(at, 0, key);
    }
    expect(column).toEqual([...column].sort());
    expect(new Set(column).size).toBe(column.length);
  });

  it('keeps finding room when everything goes to one end', () => {
    // The worst case for key length: always in front of the first card.
    let front: string | null = null;
    for (let i = 0; i < 500; i += 1) {
      const key = orderBetween(null, front);
      if (front !== null) expect(key < front).toBe(true);
      front = key;
    }
    let back: string | null = null;
    for (let i = 0; i < 500; i += 1) {
      const key = orderBetween(back, null);
      if (back !== null) expect(key > back).toBe(true);
      back = key;
    }
  });

  it('refuses when there is no between', () => {
    expect(() => orderBetween('b', 'a')).toThrow(RangeError);
    expect(() => orderBetween('a', 'a')).toThrow(RangeError);
  });
});

describe('the file', () => {
  it('writes known keys in a fixed order, whatever order they came in', () => {
    const shuffled = Object.fromEntries(Object.entries(TASK).reverse());
    const text = serializeTaskList(TaskListFile.parse(list([shuffled])));
    const tasks = text.slice(text.indexOf('"tasks"'));
    const keys = [...tasks.matchAll(/^ {6}"([a-z]+)":/gm)].map((match) => match[1]);
    expect(keys).toEqual([
      'id', 'title', 'status', 'priority', 'assignees', 'start', 'due', 'tags',
      'description', 'parent', 'order', 'created', 'updated',
    ]);
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('carries keys it does not know through a rewrite', () => {
    const newer = {
      ...(list([{ ...TASK, estimate: { hours: 3 } }]) as object),
      views: [{ kind: 'board' }],
    };
    const again = JSON.parse(serializeTaskList(TaskListFile.parse(newer)));
    expect(again.views).toEqual([{ kind: 'board' }]);
    expect(again.tasks[0].estimate).toEqual({ hours: 3 });
  });

  it('reads back exactly what it wrote', () => {
    const parsed = TaskListFile.parse(list());
    expect(parseTaskList(Buffer.from(serializeTaskList(parsed)))).toEqual(parsed);
  });

  it('says where a broken file stops being a list', () => {
    expect(() => parseTaskList(Buffer.from('{ "ndbrain": '))).toThrow(TaskListInvalidError);
    expect(() => parseTaskList(Buffer.from(JSON.stringify(list([{ ...TASK, due: '30.10.2026' }])))))
      .toThrow(/tasks\.0\.due/);
    expect(() => parseTaskList(Buffer.from(JSON.stringify({ ...(list() as object), ndbrain: 'tasklist/2' }))))
      .toThrow(/ndbrain/);
  });

  it('refuses two tasks with one id', () => {
    expect(() => parseTaskList(Buffer.from(JSON.stringify(list([TASK, { ...TASK, title: 'Twin' }])))))
      .toThrow(/tasks\.1\.id: appears twice/);
  });
});
