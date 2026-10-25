/**
 * The only code that changes a task list file.
 *
 * What `NoteService` is for notes: every change is a read-modify-write under a
 * per-file lock, so two requests on one list cannot interleave and lose one of
 * them. The lock is also taken by the generic file routes when they touch a
 * list (see `App.writeFile`), so an upload cannot land in the middle of a
 * change either.
 *
 * Changes are per field. A patch names what it sets and the rest of the task
 * is read from the file inside the lock, so two people changing the status and
 * the due date of one task both land. There is no conflict copy: the same
 * field set twice is last-writer-wins, which for a status or a date is what
 * anybody expects.
 */

import { randomInt } from 'node:crypto';

import {
  DEFAULT_STATUSES,
  TASKLIST_FORMAT,
  TaskListFile,
  isTaskListPath,
  orderBetween,
  serializeTaskList,
  type AddTaskInput,
  type TaskListItem,
  type TaskPatch,
  type TaskStatus,
} from '../../../shared/tasklist.js';
import {
  CaseCollisionError,
  InvalidPathError,
  InvalidTaskError,
  NoteExistsError,
  NoteNotFoundError,
  TaskListInvalidError,
  TaskNotFoundError,
} from '../errors.js';
import { KeyedMutex } from '../notes/mutex.js';
import type { Authorized } from '../notes/service.js';
import type { Vault } from '../vault/fs.js';
import { caseKey, normalizeVaultPath } from '../vault/paths.js';

const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Eight characters from 62, about 2^47. Random rather than counted, because a
 * counter would tell anybody who can read one task how many the list has had.
 */
function randomTaskId(): string {
  let id = '';
  for (let i = 0; i < 8; i += 1) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return id;
}

export interface TaskListsOptions {
  /** The clock for `created` and `updated`; a test passes its own. */
  now?: () => Date;
  /** Where new ids come from; a test passes its own to provoke a collision. */
  newId?: () => string;
}

export class TaskLists {
  readonly #vault: Vault;
  readonly #locks = new KeyedMutex();
  readonly #now: () => Date;
  readonly #newId: () => string;

  constructor(vault: Vault, options: TaskListsOptions = {}) {
    this.#vault = vault;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomTaskId;
  }

  /** The canonical path, refused unless it names a list. */
  #canonical(listPath: string): string {
    const canonical = normalizeVaultPath(listPath);
    if (!isTaskListPath(canonical)) {
      throw new InvalidPathError('a task list is a file ending in .tasks.json');
    }
    return canonical;
  }

  /**
   * Runs `fn` holding the list's lock.
   *
   * Public for `App`, whose generic file operations must queue behind a change
   * in progress when they are aimed at a list.
   */
  async withLock<T>(owner: string, listPath: string, fn: () => Promise<T>): Promise<T> {
    return this.#locks.run(`${owner}:${this.#canonical(listPath)}`, fn);
  }

  /** The list as the file holds it. */
  async read(owner: string, listPath: string): Promise<TaskListFile> {
    const canonical = this.#canonical(listPath);
    await this.#assertExactName(owner, canonical);
    return parseTaskList(await this.#vault.readFileBytes(owner, canonical));
  }

  /**
   * A name that only matches in another letter case is not this list.
   *
   * On a filesystem that folds case, `readFileBytes` would open `acme.tasks.json`
   * for `Acme.tasks.json`, and the same file would answer to two paths — which
   * the rest of the vault refuses for notes, and for the same reason.
   */
  async #assertExactName(owner: string, canonical: string): Promise<void> {
    const siblings = await this.#vault.siblingCaseKeys(owner, canonical);
    const name = canonical.slice(canonical.lastIndexOf('/') + 1);
    if (siblings.get(caseKey(name)) !== name) throw new NoteNotFoundError('task list does not exist');
  }

  /** Creates an empty list; refuses one that is already there under any spelling. */
  async create(
    owner: string,
    listPath: string,
    statuses: readonly TaskStatus[] = DEFAULT_STATUSES,
    options: Authorized = {},
  ): Promise<TaskListFile> {
    const canonical = this.#canonical(listPath);
    return this.#locks.run(`${owner}:${canonical}`, async () => {
      // Permission before anything about what is on this path, as for notes:
      // "exists" and "differs only in case" both say something about the file.
      options.authorize?.();

      const siblings = await this.#vault.siblingCaseKeys(owner, canonical);
      const name = canonical.slice(canonical.lastIndexOf('/') + 1);
      const existing = siblings.get(caseKey(name));
      if (existing === name) throw new NoteExistsError('a task list already exists at that path');
      if (existing !== undefined) {
        throw new CaseCollisionError(
          `"${existing}" already exists and differs only in letter case; ` +
            'that pair cannot survive on Windows or macOS',
        );
      }

      const list = TaskListFile.parse({
        ndbrain: TASKLIST_FORMAT,
        statuses: statuses.map((status) => ({ ...status })),
        tasks: [],
      });
      await this.#vault.writeFileBytes(owner, canonical, Buffer.from(serializeTaskList(list), 'utf8'));
      return list;
    });
  }

  async addTask(
    owner: string,
    listPath: string,
    input: AddTaskInput,
    options: Authorized = {},
  ): Promise<TaskListItem> {
    return this.#change(owner, listPath, options, (list) => {
      const status = input.status ?? firstOpenStatus(list);
      assertStatus(list, status);
      if (input.parent !== undefined && input.parent !== null) assertParent(list, null, input.parent);

      const now = this.#now().toISOString();
      const task: TaskListItem = {
        id: this.#freshId(list),
        title: input.title,
        status,
        priority: input.priority ?? null,
        assignees: input.assignees ?? [],
        start: input.start ?? null,
        due: input.due ?? null,
        tags: input.tags ?? [],
        description: input.description ?? '',
        parent: input.parent ?? null,
        // At the end unless told otherwise: a new card goes to the bottom of
        // its column, which is where ClickUp puts it too.
        order: input.order ?? orderBetween(lastOrder(list), null),
        created: now,
        updated: now,
      };
      list.tasks.push(task);
      return task;
    });
  }

  async patchTask(
    owner: string,
    listPath: string,
    id: string,
    set: TaskPatch,
    options: Authorized = {},
  ): Promise<TaskListItem> {
    return this.#change(owner, listPath, options, (list) => {
      const task = assertTask(list, id);
      if (set.status !== undefined) assertStatus(list, set.status);
      if (set.parent !== undefined && set.parent !== null) assertParent(list, id, set.parent);

      for (const [key, value] of Object.entries(set)) {
        if (value !== undefined) (task as Record<string, unknown>)[key] = value;
      }
      task.updated = this.#now().toISOString();
      return task;
    });
  }

  /** Removes a task and everything below it; answers with every id that went. */
  async removeTask(owner: string, listPath: string, id: string, options: Authorized = {}): Promise<string[]> {
    return this.#change(owner, listPath, options, (list) => {
      assertTask(list, id);
      // A subtask without its parent would be an orphan nobody can reach from
      // the list view, which shows subtasks under their parent.
      const removed = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const task of list.tasks) {
          if (task.parent !== null && removed.has(task.parent) && !removed.has(task.id)) {
            removed.add(task.id);
            grew = true;
          }
        }
      }
      list.tasks = list.tasks.filter((task) => !removed.has(task.id));
      return [...removed];
    });
  }

  /**
   * The one shape every change takes: lock, permission, read, change, write.
   *
   * The list is read *inside* the lock, which is what makes the change per
   * field: whatever landed since the caller last looked is the starting point.
   * A file that does not parse is refused here, before anything is written, so
   * a hand edit somebody broke is never replaced by our idea of the list.
   */
  async #change<T>(
    owner: string,
    listPath: string,
    options: Authorized,
    fn: (list: TaskListFile) => T,
  ): Promise<T> {
    const canonical = this.#canonical(listPath);
    return this.#locks.run(`${owner}:${canonical}`, async () => {
      options.authorize?.();
      const list = await this.read(owner, canonical);
      const result = fn(list);
      // Checked again on the way out. Every field was validated on the way in,
      // but the list as a whole has rules no single field does — unique ids —
      // and a file this server wrote must be one it can read back.
      const checked = TaskListFile.parse(list);
      await this.#vault.writeFileBytes(owner, canonical, Buffer.from(serializeTaskList(checked), 'utf8'));
      return result;
    });
  }

  #freshId(list: TaskListFile): string {
    const taken = new Set(list.tasks.map((task) => task.id));
    // Ten tries is far beyond what 2^47 needs; the bound is there so that a
    // broken generator ends in an error rather than a hung request.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = this.#newId();
      if (!taken.has(id)) return id;
    }
    throw new Error('could not find a free task id');
  }
}

/** Reads a list file, or says where it stops being one. */
export function parseTaskList(bytes: Buffer): TaskListFile {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new TaskListInvalidError(
      `the task list is not valid JSON: ${error instanceof Error ? error.message : 'unreadable'}`,
    );
  }
  const parsed = TaskListFile.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined || first.path.length === 0 ? '' : `${first.path.join('.')}: `;
    throw new TaskListInvalidError(`the task list is not in the expected form: ${where}${first?.message ?? ''}`);
  }
  return parsed.data;
}

function firstOpenStatus(list: TaskListFile): string {
  return (list.statuses.find((status) => !status.done) ?? list.statuses[0])?.id as string;
}

function assertStatus(list: TaskListFile, status: string): void {
  if (!list.statuses.some((candidate) => candidate.id === status)) {
    throw new InvalidTaskError(`this list has no status "${status}"`);
  }
}

function assertTask(list: TaskListFile, id: string): TaskListItem {
  const task = list.tasks.find((candidate) => candidate.id === id);
  if (task === undefined) throw new TaskNotFoundError('no such task in this list');
  return task;
}

/**
 * A parent must be there, and must not be the task itself or anything below it.
 * `id` is null for a task that does not exist yet, which cannot be in a cycle.
 */
function assertParent(list: TaskListFile, id: string | null, parent: string): void {
  if (!list.tasks.some((task) => task.id === parent)) {
    throw new InvalidTaskError(`this list has no task "${parent}" to put it under`);
  }
  if (id === null) return;
  const byId = new Map(list.tasks.map((task) => [task.id, task]));
  let cursor: string | null = parent;
  // Bounded by the list's size, so a cycle a hand edit put in the file ends
  // the walk instead of hanging it.
  for (let steps = 0; cursor !== null && steps <= list.tasks.length; steps += 1) {
    if (cursor === id) throw new InvalidTaskError('a task cannot be put under itself or one of its subtasks');
    cursor = byId.get(cursor)?.parent ?? null;
  }
}

function lastOrder(list: TaskListFile): string | null {
  let last: string | null = null;
  for (const task of list.tasks) if (last === null || task.order > last) last = task.order;
  return last;
}
