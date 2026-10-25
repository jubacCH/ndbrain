/**
 * A task list as a board: one column per status, a card per task.
 *
 * Dragging is built on pointer events rather than the HTML drag and drop API.
 * That API does not start from a touch on iOS, and a board on the phone that
 * can only be looked at would be half a board. The drag is followed on the
 * window, not through pointer capture: the card under the finger is made
 * transparent to the pointer while it moves, so that `elementFromPoint` finds
 * the column beneath it, and a captured pointer on an element that no longer
 * takes pointer events is a pointer the browser may hand back at any moment.
 *
 * A drop changes one task: its `status` when the column changed, and its
 * `order`, computed between the two cards it landed between. Every other card
 * keeps its place, which is what fractional positions are for.
 *
 * The keyboard way to move a card is the status menu on it. Reordering within
 * a column is the pointer's alone for now.
 */

import { useEffect, useRef, useState } from 'react';

import type { TaskListFile, TaskPatch } from '../../shared/tasklist';
import { copy } from './copy';
import { boardColumns, isDone, orderForDrop, type TaskFilter } from './taskListModel';

/** How far a pointer travels before a press on a card becomes a drag. */
const DRAG_THRESHOLD_PX = 5;

interface Drag {
  id: string;
  /** Where the press started, to offset the card by how far it has come. */
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  /** Whether it has passed the threshold; until then it may still be a click. */
  moving: boolean;
  /** The column and the place in it the card would land in. */
  over: { status: string; index: number } | null;
}

/** The column and position under a point, counted without the card being moved. */
function dropTargetAt(x: number, y: number, moving: string): { status: string; index: number } | null {
  const column = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-column]');
  const status = column?.dataset['column'];
  if (column == null || status === undefined) return null;
  const cards = [...column.querySelectorAll<HTMLElement>('[data-card]')].filter(
    (card) => card.dataset['card'] !== moving,
  );
  const index = cards.findIndex((card) => {
    const box = card.getBoundingClientRect();
    return y < box.top + box.height / 2;
  });
  return { status, index: index === -1 ? cards.length : index };
}

export function TaskBoard({
  list,
  filter,
  self,
  canWrite,
  names,
  selected,
  onSelect,
  onPatch,
}: {
  list: TaskListFile;
  filter: TaskFilter;
  self: string;
  canWrite: boolean;
  names: ReadonlyMap<string, string>;
  selected: string | null;
  onSelect: (id: string) => void;
  onPatch: (id: string, set: TaskPatch) => void;
}): React.JSX.Element {
  const columns = boardColumns(list, filter, self);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  /** Set when a drag ends, so the click that may follow does not open the card. */
  const justDragged = useRef(false);
  // The drag outlives the render it started in: a poll can bring a newer list
  // while the card is in the air, and the drop has to be computed against it.
  const latest = useRef({ columns, list, onPatch });
  latest.current = { columns, list, onPatch };

  useEffect(() => {
    if (drag === null) return undefined;

    const move = (event: PointerEvent): void => {
      const current = dragRef.current;
      if (current === null) return;
      const dx = event.clientX - current.startX;
      const dy = event.clientY - current.startY;
      const moving = current.moving || Math.hypot(dx, dy) > DRAG_THRESHOLD_PX;
      setDrag({
        ...current,
        dx,
        dy,
        moving,
        over: moving ? dropTargetAt(event.clientX, event.clientY, current.id) : null,
      });
    };

    const end = (event: PointerEvent): void => {
      const current = dragRef.current;
      setDrag(null);
      if (current === null || !current.moving) return;
      justDragged.current = true;
      if (event.type === 'pointercancel' || current.over === null) return;

      const { columns: now, list: newest, onPatch: patch } = latest.current;
      const task = newest.tasks.find((item) => item.id === current.id);
      const column = now.find((item) => item.status === current.over!.status);
      if (task === undefined || column === undefined) return;

      // Dropped back where it was. The drop index counts the cards without
      // this one, so its own old index is exactly "between the same two".
      const was = column.tasks.findIndex((item) => item.id === task.id);
      if (task.status === column.status && was === current.over.index) return;
      const set: TaskPatch = { order: orderForDrop(column.tasks, current.over.index, task.id) };
      if (task.status !== column.status) set.status = column.status;
      patch(task.id, set);
    };

    const cancelOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDrag(null);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('keydown', cancelOnEscape);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('keydown', cancelOnEscape);
    };
    // Re-armed only when a drag starts or stops; the moves read the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag === null]);

  const statusName = (id: string): string =>
    list.statuses.find((status) => status.id === id)?.name ?? copy.taskLists.unknownStatus(id);

  return (
    <div className={`tb-board${drag?.moving === true ? ' is-dragging' : ''}`}>
      {columns.map((column) => {
        const marker = drag?.moving === true && drag.over?.status === column.status ? drag.over.index : null;
        let visibleIndex = 0;
        return (
          <section
            key={column.status}
            className="tb-column"
            data-column={column.status}
            aria-label={statusName(column.status)}
          >
            <h3 className="tb-column-head">
              {statusName(column.status)}
              <span className="pth"> · {column.tasks.length}</span>
            </h3>
            <ol className="tb-cards">
              {column.tasks.map((task) => {
                const dragged = drag?.moving === true && drag.id === task.id;
                const showMarker = !dragged && marker === visibleIndex;
                if (!dragged) visibleIndex += 1;
                const subtasks = list.tasks.filter((item) => item.parent === task.id);
                const doneBelow = subtasks.filter((item) => isDone(list, item)).length;
                return (
                  <li key={task.id} className="tb-slot">
                    {showMarker && <div className="tb-marker" aria-hidden="true" />}
                    <article
                      className={[
                        'tb-card',
                        dragged ? 'is-dragged' : '',
                        task.id === selected ? 'is-selected' : '',
                        isDone(list, task) ? 'is-done' : '',
                      ].filter((name) => name !== '').join(' ')}
                      data-card={task.id}
                      style={dragged ? { transform: `translate(${drag.dx}px, ${drag.dy}px)` } : undefined}
                      onPointerDown={(event) => {
                        if (!canWrite || event.button !== 0) return;
                        // A press on a control in the card is that control's.
                        if ((event.target as HTMLElement).closest('select, input') !== null) return;
                        justDragged.current = false;
                        setDrag({
                          id: task.id,
                          startX: event.clientX,
                          startY: event.clientY,
                          dx: 0,
                          dy: 0,
                          moving: false,
                          over: null,
                        });
                      }}
                    >
                      <button
                        type="button"
                        className="tb-title"
                        aria-label={copy.taskLists.open(task.title)}
                        onClick={() => {
                          if (justDragged.current) {
                            justDragged.current = false;
                            return;
                          }
                          onSelect(task.id);
                        }}
                      >
                        {task.title}
                      </button>
                      <div className="tb-meta">
                        {task.priority !== null && (
                          <span className={`pill tb-priority tb-priority-${task.priority}`}>
                            {copy.taskLists.priority[task.priority]}
                          </span>
                        )}
                        {task.due !== null && <span className="tb-due">{task.due}</span>}
                        {subtasks.length > 0 && (
                          <span className="pth">{copy.taskLists.subtasksDone(doneBelow, subtasks.length)}</span>
                        )}
                      </div>
                      {task.assignees.length > 0 && (
                        <div className="tb-people">{task.assignees.map((id) => names.get(id) ?? id).join(', ')}</div>
                      )}
                      <select
                        className="tb-status"
                        value={task.status}
                        disabled={!canWrite}
                        aria-label={copy.taskLists.moveTo(task.title)}
                        onChange={(event) => onPatch(task.id, { status: event.target.value })}
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
                    </article>
                  </li>
                );
              })}
              {marker !== null && marker >= visibleIndex && (
                <li className="tb-slot">
                  <div className="tb-marker" aria-hidden="true" />
                </li>
              )}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
