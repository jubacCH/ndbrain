/**
 * The task lists: every list the caller can see, and one list as a table.
 *
 * Presentational, like the other views: the shell fetches and writes, these
 * draw and report. What a filter, a grouping or a sort *means* lives in
 * `tasklists.ts`; this file decides only how the controls look.
 *
 * A change is sent the moment it is made — a status picked, a date set, a
 * title left — and never batched behind a save button. Each one is a patch of
 * the fields it touches, so the server can merge it with whatever somebody
 * else changed in the meantime.
 */

import { Fragment, useId, useMemo, useState } from 'react';

import {
  taskListName,
  type AddTaskInput,
  type Priority,
  type TaskListFile,
  type TaskListItem,
  type TaskListRow,
  type TaskPatch,
} from '../../shared/tasklist';
import { copy } from './copy';
import { TaskBoard } from './TaskBoard';
import type { Person } from './editor/mentions';
import { ownerLabel, useOwners } from './owners';
import { refKey } from './refkey';
import {
  NO_FILTER,
  groupTasks,
  isDone,
  listPathFor,
  toggledStatus,
  type Grouping,
  type Sorting,
  type TaskFilter,
} from './taskListModel';

const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'normal', 'low'];
const GROUPINGS: readonly Grouping[] = ['status', 'priority', 'due', 'none'];
const SORTINGS: readonly Sorting[] = ['order', 'due', 'priority', 'title', 'updated'];

/* ---- every list ------------------------------------------------------------ */

export function TaskListsView({
  lists,
  self,
  vaults,
  busy,
  onOpen,
  onCreate,
}: {
  lists: TaskListRow[];
  self: string;
  /** Where a new list may go: the caller's own vault first, then the others they see. */
  vaults: Array<{ id: string; label: string }>;
  busy: boolean;
  onOpen: (owner: string, path: string) => void;
  onCreate: (owner: string, path: string) => void;
}): React.JSX.Element {
  const owners = useOwners();
  const [name, setName] = useState('');
  const [vault, setVault] = useState(self);
  const fieldId = useId();

  const byOwner = new Map<string, TaskListRow[]>();
  for (const row of [...lists].sort((a, b) => a.path.localeCompare(b.path))) {
    byOwner.set(row.owner, [...(byOwner.get(row.owner) ?? []), row]);
  }
  // The caller's own vault first, the rest by what they are called.
  const order = [...byOwner.keys()].sort((a, b) =>
    a === self ? -1 : b === self ? 1 : ownerLabel(owners, a).localeCompare(ownerLabel(owners, b)),
  );

  const path = listPathFor(name);
  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (path === null || busy) return;
    onCreate(vault, path);
    setName('');
  };

  return (
    <div className="pane padded tasklists">
      <h2 className="h-big">{copy.taskLists.title}</h2>
      <p className="h-sub">{lists.length === 0 ? copy.taskLists.empty : copy.taskLists.count(lists.length)}</p>

      {order.map((owner) => (
        <section key={owner} className="tl-vault">
          {(owner !== self || order.length > 1) && <h3 className="tl-vault-name">{ownerLabel(owners, owner)}</h3>}
          <ul className="tl-lists">
            {(byOwner.get(owner) ?? []).map((row) => {
              const folder = row.path.split('/').slice(0, -1).join('/');
              return (
                <li key={refKey(row.owner, row.path)}>
                  <button type="button" className="tl-list" onClick={() => onOpen(row.owner, row.path)}>
                    <span className="tl-list-name">{taskListName(row.path)}</span>
                    {folder !== '' && <span className="pth">{folder}</span>}
                    {!row.canWrite && <span className="pill p-info">{copy.taskLists.readOnly}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <form className="tl-new" onSubmit={submit}>
        <label htmlFor={fieldId} className="filter-label">
          {copy.taskLists.newLabel}
        </label>
        <div className="tl-new-row">
          {vaults.length > 1 && (
            <select aria-label={copy.taskLists.vault} value={vault} onChange={(event) => setVault(event.target.value)}>
              {vaults.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
          <input
            id={fieldId}
            className="tl-input"
            value={name}
            placeholder={copy.taskLists.newPlaceholder}
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" className="btn btn-solid" disabled={path === null || busy}>
            {copy.taskLists.create}
          </button>
        </div>
        <p className="h-sub">{copy.taskLists.newHint}</p>
      </form>
    </div>
  );
}

/* ---- one list ---------------------------------------------------------------- */

export interface TaskChanges {
  add: (task: AddTaskInput) => Promise<void>;
  patch: (id: string, set: TaskPatch) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export function TaskListView({
  name,
  list,
  canWrite,
  self,
  people,
  today,
  onBack,
  changes,
  initialSelected = null,
}: {
  name: string;
  list: TaskListFile;
  canWrite: boolean;
  self: string;
  /** Who can be assigned: the same people `@` offers. */
  people: Person[];
  /** `YYYY-MM-DD` in the viewer's own time zone, for the due groups. */
  today: string;
  onBack: () => void;
  changes: TaskChanges;
  /** A task to open in the detail at once — one picked in the journal, say. */
  initialSelected?: string | null;
}): React.JSX.Element {
  const [filter, setFilter] = useState<TaskFilter>(NO_FILTER);
  const [grouping, setGrouping] = useState<Grouping>('status');
  const [sorting, setSorting] = useState<Sorting>('order');
  const [layout, setLayout] = useState<'list' | 'board'>('list');
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const [draft, setDraft] = useState('');

  const groups = useMemo(
    () => groupTasks(list, filter, grouping, sorting, self, today),
    [list, filter, grouping, sorting, self, today],
  );
  const shown = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const task = selected === null ? undefined : list.tasks.find((item) => item.id === selected);
  const names = useMemo(() => new Map(people.map((person) => [person.id, person.name])), [people]);

  const groupLabel = (key: string): string => {
    switch (grouping) {
      case 'status':
        return list.statuses.find((status) => status.id === key)?.name ?? copy.taskLists.unknownStatus(key);
      case 'priority':
        return copy.taskLists.priority[key as keyof typeof copy.taskLists.priority];
      case 'due':
        return copy.taskLists.due[key as keyof typeof copy.taskLists.due];
      default:
        return copy.taskLists.all;
    }
  };

  const addTop = (event: React.FormEvent): void => {
    event.preventDefault();
    const title = draft.trim();
    if (title === '') return;
    setDraft('');
    // Added into the group it was typed under would be a guess; a new task
    // starts in the list's first open status, as on the server.
    void changes.add({ title });
  };

  const toggleStatus = (id: string): void => {
    setFilter((current) => ({
      ...current,
      statuses: current.statuses.includes(id)
        ? current.statuses.filter((status) => status !== id)
        : [...current.statuses, id],
    }));
  };

  return (
    <div className={`tasklist-pane${task === undefined ? '' : ' with-detail'}`}>
      <div className="pane padded tasklist" data-readonly={canWrite ? undefined : 'true'}>
        <button type="button" className="linky tl-back" onClick={onBack}>
          {copy.taskLists.back}
        </button>
        <h2 className="h-big">{name}</h2>
        <p className="h-sub">
          {copy.taskLists.tasks(shown, list.tasks.length)}
          {!canWrite && <span className="pill p-info">{copy.taskLists.readOnly}</span>}
        </p>

        <div className="filters">
          <input
            className="tl-input tl-filter"
            value={filter.text}
            aria-label={copy.taskLists.filterLabel}
            placeholder={copy.taskLists.filterPlaceholder}
            onChange={(event) => setFilter({ ...filter, text: event.target.value })}
          />
          <button
            type="button"
            className="filter"
            aria-pressed={filter.hideDone}
            onClick={() => setFilter({ ...filter, hideDone: !filter.hideDone })}
          >
            {copy.taskLists.hideDone}
          </button>
          <button
            type="button"
            className="filter"
            aria-pressed={filter.mine}
            onClick={() => setFilter({ ...filter, mine: !filter.mine })}
          >
            {copy.taskLists.mine}
          </button>
          <span className="filter-label">{copy.taskLists.status}</span>
          {list.statuses.map((status) => (
            <button
              type="button"
              key={status.id}
              className="filter"
              aria-pressed={filter.statuses.includes(status.id)}
              onClick={() => toggleStatus(status.id)}
            >
              {status.name}
            </button>
          ))}
        </div>

        <div className="filters">
          <span className="filter-label">{copy.taskLists.layout}</span>
          {(['list', 'board'] as const).map((key) => (
            <button
              type="button"
              key={key}
              className="filter"
              aria-pressed={layout === key}
              onClick={() => setLayout(key)}
            >
              {copy.taskLists.layouts[key]}
            </button>
          ))}
          {/* A board is grouped by status and ordered by hand, by definition. */}
          {layout === 'list' && (
            <>
              <label className="filter-label">
                {copy.taskLists.groupBy}{' '}
                <select value={grouping} onChange={(event) => setGrouping(event.target.value as Grouping)}>
                  {GROUPINGS.map((key) => (
                    <option key={key} value={key}>
                      {copy.taskLists.grouping[key]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="filter-label">
                {copy.taskLists.sortBy}{' '}
                <select value={sorting} onChange={(event) => setSorting(event.target.value as Sorting)}>
                  {SORTINGS.map((key) => (
                    <option key={key} value={key}>
                      {copy.taskLists.sorting[key]}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </div>

        {canWrite && (
          <form className="tl-add" onSubmit={addTop}>
            <input
              className="tl-input"
              value={draft}
              aria-label={copy.taskLists.addLabel}
              placeholder={copy.taskLists.addPlaceholder}
              onChange={(event) => setDraft(event.target.value)}
            />
          </form>
        )}

        {layout === 'board' ? (
          <TaskBoard
            list={list}
            filter={filter}
            self={self}
            canWrite={canWrite}
            names={names}
            selected={selected}
            onSelect={setSelected}
            onPatch={(id, set) => void changes.patch(id, set)}
          />
        ) : groups.length === 0 ? (
          <p className="empty">{list.tasks.length === 0 ? copy.taskLists.noTasks : copy.taskLists.noMatch}</p>
        ) : (
          <div className="tablewrap">
            <div className="tablescroll">
              <table className="tl-table">
                <thead>
                  <tr>
                    <th aria-hidden="true" />
                    <th>{copy.taskLists.columns.title}</th>
                    <th>{copy.taskLists.columns.status}</th>
                    <th>{copy.taskLists.columns.priority}</th>
                    <th>{copy.taskLists.columns.due}</th>
                    <th>{copy.taskLists.columns.assignees}</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => (
                    <Fragment key={group.key}>
                      {grouping !== 'none' && (
                        <tr className="task-group">
                          <td colSpan={6} className="nm">
                            {groupLabel(group.key)}
                            <span className="pth"> · {group.rows.length}</span>
                          </td>
                        </tr>
                      )}
                      {group.rows.map(({ task: row, depth }) => (
                        <TaskRow
                          key={row.id}
                          list={list}
                          task={row}
                          depth={depth}
                          selected={row.id === selected}
                          canWrite={canWrite}
                          names={names}
                          onSelect={() => setSelected(row.id)}
                          onPatch={(set) => void changes.patch(row.id, set)}
                        />
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {task !== undefined && (
        <TaskDetail
          key={task.id}
          list={list}
          task={task}
          canWrite={canWrite}
          people={people}
          onClose={() => setSelected(null)}
          onSelect={setSelected}
          changes={changes}
        />
      )}
    </div>
  );
}

function TaskRow({
  list,
  task,
  depth,
  selected,
  canWrite,
  names,
  onSelect,
  onPatch,
}: {
  list: TaskListFile;
  task: TaskListItem;
  depth: number;
  selected: boolean;
  canWrite: boolean;
  names: ReadonlyMap<string, string>;
  onSelect: () => void;
  onPatch: (set: TaskPatch) => void;
}): React.JSX.Element {
  const done = isDone(list, task);
  const subtasks = list.tasks.filter((item) => item.parent === task.id).length;
  return (
    <tr className={`tl-row${done ? ' is-done' : ''}`} aria-selected={selected} onClick={onSelect}>
      <td className="pick" onClick={(event) => event.stopPropagation()}>
        <input
          type="checkbox"
          checked={done}
          disabled={!canWrite}
          aria-label={done ? copy.taskLists.markOpen(task.title) : copy.taskLists.markDone(task.title)}
          onChange={() => onPatch({ status: toggledStatus(list, task) })}
        />
      </td>
      <td className="nm">
        <button
          type="button"
          className="rowopen tl-title"
          style={{ paddingLeft: `${depth * 1.25}rem` }}
          aria-label={copy.taskLists.open(task.title)}
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
          }}
        >
          {task.title}
          {subtasks > 0 && <span className="pth"> · {copy.taskLists.subtaskCount(subtasks)}</span>}
        </button>
      </td>
      <td onClick={(event) => event.stopPropagation()}>
        <select
          value={task.status}
          disabled={!canWrite}
          aria-label={copy.taskLists.fields.status}
          onChange={(event) => onPatch({ status: event.target.value })}
        >
          {!list.statuses.some((status) => status.id === task.status) && (
            <option value={task.status}>{copy.taskLists.unknownStatus(task.status)}</option>
          )}
          {list.statuses.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
        </select>
      </td>
      <td onClick={(event) => event.stopPropagation()}>
        <PrioritySelect value={task.priority} disabled={!canWrite} onChange={(priority) => onPatch({ priority })} />
      </td>
      <td onClick={(event) => event.stopPropagation()}>
        <input
          type="date"
          className="tl-date"
          value={task.due ?? ''}
          disabled={!canWrite}
          aria-label={copy.taskLists.fields.due}
          onChange={(event) => onPatch({ due: event.target.value === '' ? null : event.target.value })}
        />
      </td>
      <td className="tl-people">{task.assignees.map((id) => names.get(id) ?? id).join(', ')}</td>
    </tr>
  );
}

function PrioritySelect({
  value,
  disabled,
  onChange,
}: {
  value: Priority | null;
  disabled: boolean;
  onChange: (priority: Priority | null) => void;
}): React.JSX.Element {
  return (
    <select
      value={value ?? ''}
      disabled={disabled}
      aria-label={copy.taskLists.fields.priority}
      onChange={(event) => onChange(event.target.value === '' ? null : (event.target.value as Priority))}
    >
      <option value="">{copy.taskLists.priority.none}</option>
      {PRIORITIES.map((priority) => (
        <option key={priority} value={priority}>
          {copy.taskLists.priority[priority]}
        </option>
      ))}
    </select>
  );
}

/**
 * One task in full, beside the table.
 *
 * Text fields are written when they are left, not on every keystroke: a
 * title is one change, not twenty, and each of those twenty would have been a
 * write to the file and a commit in the history.
 */
function TaskDetail({
  list,
  task,
  canWrite,
  people,
  onClose,
  onSelect,
  changes,
}: {
  list: TaskListFile;
  task: TaskListItem;
  canWrite: boolean;
  people: Person[];
  onClose: () => void;
  onSelect: (id: string) => void;
  changes: TaskChanges;
}): React.JSX.Element {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [tags, setTags] = useState(task.tags.join(', '));
  const [subtask, setSubtask] = useState('');
  const id = useId();
  const subtasks = list.tasks.filter((item) => item.parent === task.id);

  const commitTitle = (): void => {
    const next = title.trim();
    if (next === '') setTitle(task.title);
    else if (next !== task.title) void changes.patch(task.id, { title: next });
  };
  const commitTags = (): void => {
    const next = [...new Set(tags.split(',').map((tag) => tag.trim()).filter((tag) => tag !== ''))];
    if (next.join('\n') !== task.tags.join('\n')) void changes.patch(task.id, { tags: next });
  };
  const toggleAssignee = (person: string): void => {
    const next = task.assignees.includes(person)
      ? task.assignees.filter((assignee) => assignee !== person)
      : [...task.assignees, person];
    void changes.patch(task.id, { assignees: next });
  };
  const addSubtask = (event: React.FormEvent): void => {
    event.preventDefault();
    const next = subtask.trim();
    if (next === '') return;
    setSubtask('');
    void changes.add({ title: next, parent: task.id });
  };
  const remove = (): void => {
    if (!window.confirm(copy.taskLists.askRemove(task.title, countBelow(list, task.id)))) return;
    onClose();
    void changes.remove(task.id);
  };

  return (
    <aside className="pane padded tl-detail" aria-labelledby={`${id}-title`}>
      <div className="tl-detail-head">
        <h3 className="filter-label" id={`${id}-title`}>
          {copy.taskLists.detail}
        </h3>
        <button type="button" className="btn" onClick={onClose}>
          {copy.taskLists.close}
        </button>
      </div>

      <label className="tl-field">
        <span className="filter-label">{copy.taskLists.fields.title}</span>
        <input
          className="tl-input"
          value={title}
          disabled={!canWrite}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={commitTitle}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      </label>

      <div className="tl-field-row">
        <label className="tl-field">
          <span className="filter-label">{copy.taskLists.fields.status}</span>
          <select
            value={task.status}
            disabled={!canWrite}
            onChange={(event) => void changes.patch(task.id, { status: event.target.value })}
          >
            {list.statuses.map((status) => (
              <option key={status.id} value={status.id}>
                {status.name}
              </option>
            ))}
          </select>
        </label>
        <label className="tl-field">
          <span className="filter-label">{copy.taskLists.fields.priority}</span>
          <PrioritySelect
            value={task.priority}
            disabled={!canWrite}
            onChange={(priority) => void changes.patch(task.id, { priority })}
          />
        </label>
      </div>

      <div className="tl-field-row">
        <label className="tl-field">
          <span className="filter-label">{copy.taskLists.fields.start}</span>
          <input
            type="date"
            className="tl-date"
            value={task.start ?? ''}
            disabled={!canWrite}
            onChange={(event) =>
              void changes.patch(task.id, { start: event.target.value === '' ? null : event.target.value })
            }
          />
        </label>
        <label className="tl-field">
          <span className="filter-label">{copy.taskLists.fields.due}</span>
          <input
            type="date"
            className="tl-date"
            value={task.due ?? ''}
            disabled={!canWrite}
            onChange={(event) =>
              void changes.patch(task.id, { due: event.target.value === '' ? null : event.target.value })
            }
          />
        </label>
      </div>

      <fieldset className="tl-field tl-assignees" disabled={!canWrite}>
        <legend className="filter-label">{copy.taskLists.fields.assignees}</legend>
        {people.length === 0 && <p className="h-sub">{copy.taskLists.nobody}</p>}
        {people.map((person) => (
          <label key={person.id} className="tl-check">
            <input
              type="checkbox"
              checked={task.assignees.includes(person.id)}
              onChange={() => toggleAssignee(person.id)}
            />
            {person.self === true ? copy.taskLists.you(person.name) : person.name}
          </label>
        ))}
      </fieldset>

      <label className="tl-field">
        <span className="filter-label">{copy.taskLists.fields.tags}</span>
        <input
          className="tl-input"
          value={tags}
          disabled={!canWrite}
          placeholder={copy.taskLists.fields.tagsHint}
          onChange={(event) => setTags(event.target.value)}
          onBlur={commitTags}
        />
      </label>

      <label className="tl-field">
        <span className="filter-label">{copy.taskLists.fields.description}</span>
        <textarea
          className="tl-input tl-description"
          value={description}
          disabled={!canWrite}
          rows={6}
          onChange={(event) => setDescription(event.target.value)}
          onBlur={() => {
            if (description !== task.description) void changes.patch(task.id, { description });
          }}
        />
      </label>

      <section className="tl-field">
        <span className="filter-label">{copy.taskLists.fields.subtasks}</span>
        <ul className="tl-subtasks">
          {subtasks.map((child) => (
            <li key={child.id}>
              <input
                type="checkbox"
                checked={isDone(list, child)}
                disabled={!canWrite}
                aria-label={isDone(list, child) ? copy.taskLists.markOpen(child.title) : copy.taskLists.markDone(child.title)}
                onChange={() => void changes.patch(child.id, { status: toggledStatus(list, child) })}
              />
              <button type="button" className="linky" onClick={() => onSelect(child.id)}>
                {child.title}
              </button>
            </li>
          ))}
        </ul>
        {canWrite && (
          <form onSubmit={addSubtask}>
            <input
              className="tl-input"
              value={subtask}
              aria-label={copy.taskLists.addSubtaskLabel}
              placeholder={copy.taskLists.addSubtaskPlaceholder}
              onChange={(event) => setSubtask(event.target.value)}
            />
          </form>
        )}
      </section>

      {canWrite && (
        <button type="button" className="btn btn-danger" onClick={remove}>
          {copy.taskLists.remove}
        </button>
      )}
    </aside>
  );
}

/** How many tasks sit below this one, at any depth — what a delete takes along. */
function countBelow(list: TaskListFile, id: string): number {
  const below = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const task of list.tasks) {
      if (task.parent !== null && (task.parent === id || below.has(task.parent)) && !below.has(task.id)) {
        below.add(task.id);
        grew = true;
      }
    }
  }
  return below.size;
}
