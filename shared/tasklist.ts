/**
 * The task list file, `<List name>.tasks.json`, and the pure rules around it.
 *
 * Shared because both sides need the same answers: the server validates and
 * writes the file, and the board will compute a card's new `order` in the
 * browser before it sends it. Two copies of the ordering rule would put two
 * cards in the same place the first time they disagreed.
 *
 * The design and the reasons for it are in
 * `docs/superpowers/specs/2026-10-25-task-lists-design.md`.
 */

import { z } from 'zod';

import { parseIsoDate } from './journal.js';

/** The suffix that makes a file a task list. Matched case-insensitively, like `.md`. */
export const TASKLIST_EXTENSION = '.tasks.json';

/** The format marker every list file carries; the number is the format's version. */
export const TASKLIST_FORMAT = 'tasklist/1';

export function isTaskListPath(vaultPath: string): boolean {
  return vaultPath.toLowerCase().endsWith(TASKLIST_EXTENSION);
}

/** The list's name: the file name without its suffix, as a note's title is. */
export function taskListName(vaultPath: string): string {
  const base = vaultPath.slice(vaultPath.lastIndexOf('/') + 1);
  return isTaskListPath(base) ? base.slice(0, -TASKLIST_EXTENSION.length) : base;
}

/* ---- fields --------------------------------------------------------------- */

/** Ids of tasks and statuses. Generated ones are eight characters; a hand-written file may use others. */
export const TaskId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'not a valid id');

const AccountId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'not a valid account id');

/** A calendar day. Times of day are not part of the format yet. */
const Day = z.string().refine((text) => parseIsoDate(text) !== null, 'not a date of the form YYYY-MM-DD');

/**
 * A position between two others, as a string that sorts by code point.
 *
 * Never ends in `0`: the midpoint below relies on that, because `a0` and `a`
 * would be two spellings of the same place with nothing between them.
 */
export const Order = z.string().regex(/^[0-9A-Za-z]*[1-9A-Za-z]$/, 'not a valid position').max(256);

export const Priority = z.enum(['urgent', 'high', 'normal', 'low']);

export const TaskStatus = z.looseObject({
  id: TaskId,
  name: z.string().trim().min(1).max(100),
  /** Whether a task in this status counts as finished. */
  done: z.boolean(),
});

const Title = z.string().trim().min(1).max(500);

/**
 * One task as the file holds it.
 *
 * Loose, so a key this version does not know is carried through a rewrite
 * rather than dropped. Every key it does know is checked as strictly as if the
 * object were strict.
 */
export const TaskListItem = z.looseObject({
  id: TaskId,
  title: Title,
  status: TaskId,
  priority: Priority.nullable(),
  assignees: z.array(AccountId).max(50),
  start: Day.nullable(),
  due: Day.nullable(),
  tags: z.array(z.string().trim().min(1).max(100)).max(50),
  description: z.string().max(100_000),
  parent: TaskId.nullable(),
  order: Order,
  created: z.iso.datetime(),
  updated: z.iso.datetime(),
});

export const TaskListFile = z
  .looseObject({
    ndbrain: z.literal(TASKLIST_FORMAT),
    statuses: z.array(TaskStatus).min(1).max(50),
    tasks: z.array(TaskListItem).max(10_000),
  })
  .superRefine((list, context) => {
    const statusIds = new Set<string>();
    list.statuses.forEach((status, index) => {
      if (statusIds.has(status.id)) {
        context.addIssue({ code: 'custom', path: ['statuses', index, 'id'], message: 'appears twice' });
      }
      statusIds.add(status.id);
    });
    const taskIds = new Set<string>();
    list.tasks.forEach((task, index) => {
      if (taskIds.has(task.id)) {
        context.addIssue({ code: 'custom', path: ['tasks', index, 'id'], message: 'appears twice' });
      }
      taskIds.add(task.id);
    });
  });

export type TaskStatus = z.infer<typeof TaskStatus>;
export type TaskListItem = z.infer<typeof TaskListItem>;
export type TaskListFile = z.infer<typeof TaskListFile>;
export type Priority = z.infer<typeof Priority>;

/* ---- requests ------------------------------------------------------------- */

/** The fields a person sets. Strict: an unknown key here is a typo, not a newer field. */
const Settable = {
  title: Title,
  status: TaskId,
  priority: Priority.nullable(),
  assignees: z.array(AccountId).max(50),
  start: Day.nullable(),
  due: Day.nullable(),
  tags: z.array(z.string().trim().min(1).max(100)).max(50),
  description: z.string().max(100_000),
  parent: TaskId.nullable(),
  order: Order,
};

export const CreateTaskListRequest = z
  .object({
    owner: AccountId.optional(),
    statuses: z.array(z.object({ id: TaskId, name: TaskStatus.shape.name, done: z.boolean() }).strict())
      .min(1)
      .max(50)
      .optional(),
  })
  .strict();

export const AddTaskRequest = z
  .object({
    owner: AccountId.optional(),
    task: z.object(Settable).partial().required({ title: true }).strict(),
  })
  .strict();

export const PatchTaskRequest = z
  .object({
    owner: AccountId.optional(),
    id: TaskId,
    set: z
      .object(Settable)
      .partial()
      .strict()
      .refine((set) => Object.keys(set).length > 0, 'names no field to change'),
  })
  .strict();

export type AddTaskInput = z.infer<typeof AddTaskRequest>['task'];
export type TaskPatch = z.infer<typeof PatchTaskRequest>['set'];

/* ---- responses ------------------------------------------------------------ */

export const TaskListResponse = z.object({
  owner: z.string(),
  path: z.string(),
  name: z.string(),
  list: TaskListFile,
});

export const TaskResponse = z.object({ task: TaskListItem });

export const RemoveTaskResponse = z.object({ removed: z.array(TaskId) });

/* ---- the file ------------------------------------------------------------- */

/** What a new list starts with. Renamed or replaced freely; nothing depends on these ids. */
export const DEFAULT_STATUSES: readonly TaskStatus[] = [
  { id: 'todo', name: 'To do', done: false },
  { id: 'doing', name: 'In progress', done: false },
  { id: 'done', name: 'Done', done: true },
];

const LIST_KEYS = ['ndbrain', 'statuses', 'tasks'] as const;
const STATUS_KEYS = ['id', 'name', 'done'] as const;
const TASK_KEYS = [
  'id', 'title', 'status', 'priority', 'assignees', 'start', 'due', 'tags',
  'description', 'parent', 'order', 'created', 'updated',
] as const;

/** Known keys first in a fixed order, then every other key as it was found. */
function ordered(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in value) out[key] = value[key];
  for (const [key, item] of Object.entries(value)) if (!(key in out)) out[key] = item;
  return out;
}

/**
 * The file's text.
 *
 * Laid out for the history sidecar, which commits the vault every two minutes:
 * a fixed key order and one task per block, so that changing one field of one
 * task is a diff of one line rather than of the file.
 */
export function serializeTaskList(list: TaskListFile): string {
  const shaped = ordered(
    {
      ...list,
      statuses: list.statuses.map((status) => ordered(status, STATUS_KEYS)),
      tasks: list.tasks.map((task) => ordered(task, TASK_KEYS)),
    },
    LIST_KEYS,
  );
  return `${JSON.stringify(shaped, null, 2)}\n`;
}

/* ---- order ---------------------------------------------------------------- */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * A position strictly between `before` and `after`; `null` is an open end.
 *
 * Both are read as base-62 fractions after an implied `0.`, which is why a key
 * may not end in `0`. Strings compare by code point, and `DIGITS` is in code
 * point order, so the comparison JavaScript and SQLite make by default is the
 * comparison this is built for — no collation to agree on.
 *
 * Throws when `before` is not below `after`: there is no answer, and inventing
 * one would put two cards in the same place.
 */
export function orderBetween(before: string | null, after: string | null): string {
  const low = before ?? '';
  if (after !== null && low >= after) {
    throw new RangeError(`no position between "${low}" and "${after}"`);
  }
  return midpoint(low, after);
}

function midpoint(low: string, high: string | null): string {
  if (high !== null) {
    // A shared prefix stays; the answer differs only after it. `low` is padded
    // with zeros, which is what its missing digits mean.
    let common = 0;
    while ((low[common] ?? '0') === high[common]) common += 1;
    if (common > 0) return high.slice(0, common) + midpoint(low.slice(common), high.slice(common));
  }

  const lowDigit = low === '' ? 0 : DIGITS.indexOf(low[0] as string);
  const highDigit = high === null ? DIGITS.length : DIGITS.indexOf(high[0] as string);

  if (highDigit - lowDigit > 1) {
    return DIGITS[Math.round((lowDigit + highDigit) / 2)] as string;
  }
  // Adjacent first digits. If `high` goes on past its first digit, that digit
  // alone already lies between the two; otherwise keep `low`'s digit and find
  // room after it.
  if (high !== null && high.length > 1) return high.slice(0, 1);
  return (DIGITS[lowDigit] as string) + midpoint(low.slice(1), null);
}
