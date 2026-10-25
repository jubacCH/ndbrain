/**
 * What the list view shows of a task list: filtered, grouped, sorted.
 *
 * Pure, and apart from the component, because these are the rules somebody
 * will want to change and the ones a test can pin without rendering anything.
 * The component decides what the controls look like; this decides what they
 * mean.
 *
 * Subtasks follow their parent. Grouping and sorting apply to the tasks at the
 * top, and each one brings its subtasks along underneath it in board order — a
 * subtask in another status than its parent stays where ClickUp keeps it, under
 * the parent, rather than being torn out into a group of its own.
 */

import { orderBetween, type TaskListFile, type TaskListItem } from '../../shared/tasklist';

export type Grouping = 'status' | 'priority' | 'due' | 'none';
export type Sorting = 'order' | 'due' | 'priority' | 'title' | 'updated';

/** Where a due date falls, seen from today. */
export type DueBucket = 'overdue' | 'today' | 'week' | 'later' | 'none';

export interface TaskFilter {
  /** Words that must all appear in the title, the description or a tag. */
  text: string;
  /** Statuses to show; empty means every status. */
  statuses: string[];
  /** Leave out tasks whose status counts as done. */
  hideDone: boolean;
  /** Only tasks assigned to the signed-in account. */
  mine: boolean;
}

export const NO_FILTER: TaskFilter = { text: '', statuses: [], hideDone: false, mine: false };

export interface TaskRowEntry {
  task: TaskListItem;
  /** 0 for a task at the top, 1 for its subtask, and so on. */
  depth: number;
}

export interface TaskGroup {
  /**
   * What the group is: a status id, a priority, a due bucket, or `all`. The
   * view turns it into words; a status keeps the name the list gave it.
   */
  key: string;
  rows: TaskRowEntry[];
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const PRIORITY_KEYS = ['urgent', 'high', 'normal', 'low', 'none'] as const;
const DUE_KEYS: readonly DueBucket[] = ['overdue', 'today', 'week', 'later', 'none'];

function priorityRank(task: TaskListItem): number {
  return task.priority === null ? 4 : (PRIORITY_RANK[task.priority] ?? 4);
}

/** `YYYY-MM-DD` plus some days, as plain calendar arithmetic. */
function addDays(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, date + days));
  return shifted.toISOString().slice(0, 10);
}

/** Today and the six days after it are "this week": the next seven, not the calendar week. */
export function dueBucket(due: string | null, today: string): DueBucket {
  if (due === null) return 'none';
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  if (due <= addDays(today, 6)) return 'week';
  return 'later';
}

export function isDone(list: TaskListFile, task: TaskListItem): boolean {
  return list.statuses.find((status) => status.id === task.status)?.done ?? false;
}

function matches(list: TaskListFile, task: TaskListItem, filter: TaskFilter, self: string): boolean {
  if (filter.hideDone && isDone(list, task)) return false;
  if (filter.statuses.length > 0 && !filter.statuses.includes(task.status)) return false;
  if (filter.mine && !task.assignees.includes(self)) return false;
  const words = filter.text.toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length > 0) {
    const haystack = [task.title, task.description, ...task.tags].join('\n').toLowerCase();
    if (!words.every((word) => haystack.includes(word))) return false;
  }
  return true;
}

function compare(sorting: Sorting): (a: TaskListItem, b: TaskListItem) => number {
  const byOrder = (a: TaskListItem, b: TaskListItem): number => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0);
  switch (sorting) {
    case 'due':
      // Undated last, whichever way round: a task without a date is not due first.
      return (a, b) =>
        a.due === b.due ? byOrder(a, b) : a.due === null ? 1 : b.due === null ? -1 : a.due < b.due ? -1 : 1;
    case 'priority':
      return (a, b) => priorityRank(a) - priorityRank(b) || byOrder(a, b);
    case 'title':
      return (a, b) => a.title.localeCompare(b.title) || byOrder(a, b);
    case 'updated':
      return (a, b) => (a.updated === b.updated ? byOrder(a, b) : a.updated > b.updated ? -1 : 1);
    case 'order':
    default:
      return byOrder;
  }
}

/**
 * The rows on screen, in groups.
 *
 * A subtask that matches the filter while its parent does not is shown at the
 * top rather than hidden: the filter asked for it, and leaving it out because
 * of something about another task would be a filter that lies.
 */
export function groupTasks(
  list: TaskListFile,
  filter: TaskFilter,
  grouping: Grouping,
  sorting: Sorting,
  self: string,
  today: string,
): TaskGroup[] {
  const visible = list.tasks.filter((task) => matches(list, task, filter, self));
  const byId = new Map(visible.map((task) => [task.id, task]));
  // A loop of parents can only come from a hand edit. Every task in one would
  // sit under another task in it and none would reach the top, so the whole
  // loop would vanish from the page; they are shown at the top instead.
  const inLoop = (task: TaskListItem): boolean => {
    let cursor = task.parent;
    for (let steps = 0; cursor !== null && steps <= visible.length; steps += 1) {
      if (cursor === task.id) return true;
      cursor = byId.get(cursor)?.parent ?? null;
    }
    return false;
  };
  const children = new Map<string, TaskListItem[]>();
  const tops: TaskListItem[] = [];
  for (const task of visible) {
    if (task.parent !== null && byId.has(task.parent) && !inLoop(task)) {
      children.set(task.parent, [...(children.get(task.parent) ?? []), task]);
    } else {
      tops.push(task);
    }
  }

  const order = compare('order');
  const withChildren = (task: TaskListItem, depth: number, seen: Set<string>): TaskRowEntry[] => {
    // A loop a hand edit put in the file must not hang the page.
    if (seen.has(task.id)) return [];
    seen.add(task.id);
    const below = [...(children.get(task.id) ?? [])].sort(order);
    return [{ task, depth }, ...below.flatMap((child) => withChildren(child, depth + 1, seen))];
  };

  const keyOf = (task: TaskListItem): string => {
    switch (grouping) {
      case 'status':
        return task.status;
      case 'priority':
        return task.priority ?? 'none';
      case 'due':
        return dueBucket(task.due, today);
      default:
        return 'all';
    }
  };
  const keys: readonly string[] =
    grouping === 'status'
      ? [...list.statuses.map((status) => status.id), ...new Set(tops.map((task) => task.status))]
      : grouping === 'priority'
        ? PRIORITY_KEYS
        : grouping === 'due'
          ? DUE_KEYS
          : ['all'];

  const seen = new Set<string>();
  const groups: TaskGroup[] = [];
  for (const key of new Set(keys)) {
    const members = tops.filter((task) => keyOf(task) === key).sort(compare(sorting));
    if (members.length === 0) continue;
    groups.push({ key, rows: members.flatMap((task) => withChildren(task, 0, seen)) });
  }
  return groups;
}

/** The status a task goes to when it is ticked off, and back when it is unticked. */
export function toggledStatus(list: TaskListFile, task: TaskListItem): string {
  const target = isDone(list, task)
    ? list.statuses.find((status) => !status.done)
    : list.statuses.find((status) => status.done);
  return target?.id ?? task.status;
}

/** The vault path for a list named in the "new list" field: a folder, a name, the suffix. */
export function listPathFor(input: string): string | null {
  const trimmed = input.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return null;
  return /\.tasks\.json$/i.test(trimmed) ? trimmed : `${trimmed}.tasks.json`;
}

/* ---- board ------------------------------------------------------------------ */

export interface BoardColumn {
  /** The status this column is. */
  status: string;
  /** Its tasks at the top, in board order; subtasks are counted on their card. */
  tasks: TaskListItem[];
}

/**
 * One column per status of the list, in the list's own order.
 *
 * Only tasks at the top become cards. A subtask on a board of its own would
 * be a card with no context, and ClickUp keeps them inside their parent's
 * card too. A task in a status the list no longer has gets a column of its
 * own at the end, so a hand edit cannot make it disappear.
 */
export function boardColumns(list: TaskListFile, filter: TaskFilter, self: string): BoardColumn[] {
  const tops = list.tasks.filter(
    (task) =>
      (task.parent === null || !list.tasks.some((other) => other.id === task.parent)) &&
      matches(list, task, filter, self),
  );
  const order = compare('order');
  const statuses = [...list.statuses.map((status) => status.id), ...new Set(tops.map((task) => task.status))];
  return [...new Set(statuses)]
    .map((status) => ({ status, tasks: tops.filter((task) => task.status === status).sort(order) }))
    .filter(
      (column) => column.tasks.length > 0 || list.statuses.some((status) => status.id === column.status),
    );
}

/**
 * The `order` a card gets when it is dropped at `index` in `column`.
 *
 * `index` counts the cards as they are on screen *without* the one being
 * moved, which is how the drop marker counts them too. Only the moved card
 * changes: that is the point of fractional positions.
 *
 * Two neighbours with the same position can only come from a hand edit, and
 * there is no key between equal keys. The card then goes after both of them,
 * a place off by one rather than an error; moving it again settles it.
 */
export function orderForDrop(column: readonly TaskListItem[], index: number, moving: string): string {
  const others = column.filter((task) => task.id !== moving);
  const before = others[index - 1]?.order ?? null;
  const after = others[index]?.order ?? null;
  if (before !== null && after !== null && before >= after) return orderBetween(before, null);
  return orderBetween(before, after);
}
