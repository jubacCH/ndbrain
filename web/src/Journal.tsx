/**
 * The journal: a month of daily notes at a glance.
 *
 * A calendar rather than a list, because the question it answers is "which days
 * did I write", and gaps are exactly what a list hides. Days with a note carry a
 * mark, today is ringed, and a click opens the day — or, for a day with nothing
 * yet, asks before creating one, since a stray click should not leave an empty
 * note behind in the vault.
 *
 * Built for the keyboard as a grid: one cell takes Tab, the arrow keys move a
 * day or a week, Home and End go to the ends of the week, Page Up and Page Down
 * change the month, and Enter or Space opens. Moving past the edge of the month
 * turns the page with it.
 *
 * Which days exist comes from the note list the shell already holds, so the
 * calendar needs no request of its own. What is due on each day comes from the
 * task lists, which the shell asks for up to the last day on screen — the
 * calendar says which day that is whenever the month changes. Below the
 * calendar, the same tasks as a list: what is overdue, then what falls in the
 * month on screen.
 *
 * Beside the calendar sit the open tasks, handed in by the shell: the page is
 * where somebody plans the day, and a day is planned against what is still
 * open. On a narrow screen they wrap below the calendar instead.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { taskListName, type DueTask } from '../../shared/tasklist';
import { copy } from './copy';
import { ChevronIcon, ChevronLeftIcon } from './icons';
import {
  addDays,
  isoDate,
  localDate,
  monthGrid,
  sameDate,
  shiftMonth,
  weekdayIndex,
  type JournalDate,
} from './daily';

const MONTH_FORMAT = new Intl.DateTimeFormat(copy.locale, { month: 'long', year: 'numeric' });
const DAY_FORMAT = new Intl.DateTimeFormat(copy.locale, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const WEEKDAY_FORMAT = new Intl.DateTimeFormat(copy.locale, { weekday: 'short' });
const WEEKDAY_LONG = new Intl.DateTimeFormat(copy.locale, { weekday: 'long' });
const SHORT_DAY = new Intl.DateTimeFormat(copy.locale, { day: 'numeric', month: 'short' });

/** Noon, so no time zone or daylight saving change can move the date. */
const asDate = (date: JournalDate): Date => new Date(date.year, date.month - 1, date.day, 12);

/** A day named for a person, in the interface's language. */
export function dayName(date: JournalDate): string {
  return DAY_FORMAT.format(asDate(date));
}

export interface JournalViewProps {
  /** ISO dates of the days that have a note in the caller's own vault. */
  days: ReadonlySet<string>;
  /** Fixed in tests; the clock otherwise. */
  now?: number;
  onOpenDay: (date: JournalDate) => void;
  /** Shown to the right of the calendar, or below it where there is no room. */
  aside?: ReactNode;
  /** Open tasks from task lists, due up to the last day on screen. Absent: not shown. */
  due?: DueTask[];
  /** More were due than `due` carries. */
  dueTruncated?: boolean;
  /** Told the last day on screen whenever the month changes, so the shell can ask for it. */
  onRange?: (to: string) => void;
  onOpenTask?: (owner: string, path: string, id: string) => void;
}

export function JournalView({
  days,
  now,
  onOpenDay,
  aside,
  due,
  dueTruncated = false,
  onRange,
  onOpenTask,
}: JournalViewProps): React.JSX.Element {
  const today = localDate(new Date(now ?? Date.now()));
  const [cursor, setCursor] = useState<JournalDate>(today);
  /** Only a key press moves focus; a month button must keep its own. */
  const moveFocus = useRef(false);
  const grid = useRef<HTMLDivElement>(null);

  const weeks = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor.year, cursor.month]);
  const inMonth = weeks.flat().filter((cell) => cell.inMonth && days.has(isoDate(cell.date))).length;
  const monthLabel = MONTH_FORMAT.format(asDate({ ...cursor, day: 1 }));
  const last = weeks.at(-1)?.at(-1);
  const lastIso = last === undefined ? null : isoDate(last.date);

  useEffect(() => {
    if (lastIso !== null) onRange?.(lastIso);
  }, [lastIso, onRange]);

  const dueByDay = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of due ?? []) counts.set(task.due, (counts.get(task.due) ?? 0) + 1);
    return counts;
  }, [due]);
  const todayIso = isoDate(today);
  const monthPrefix = isoDate({ ...cursor, day: 1 }).slice(0, 8);
  const overdue = (due ?? []).filter((task) => task.due < todayIso);
  const inThisMonth = (due ?? []).filter((task) => task.due >= todayIso && task.due.startsWith(monthPrefix));

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    grid.current?.querySelector<HTMLButtonElement>(`[data-date="${isoDate(cursor)}"]`)?.focus();
  }, [cursor]);

  const open = (date: JournalDate): void => {
    if (!days.has(isoDate(date)) && !window.confirm(copy.journal.askCreate(dayName(date)))) return;
    onOpenDay(date);
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const step: Record<string, () => JournalDate> = {
      ArrowLeft: () => addDays(cursor, -1),
      ArrowRight: () => addDays(cursor, 1),
      ArrowUp: () => addDays(cursor, -7),
      ArrowDown: () => addDays(cursor, 7),
      Home: () => addDays(cursor, -weekdayIndex(cursor)),
      End: () => addDays(cursor, 6 - weekdayIndex(cursor)),
      PageUp: () => shiftMonth(cursor, -1),
      PageDown: () => shiftMonth(cursor, 1),
    };
    const next = step[event.key];
    if (next === undefined) return;
    event.preventDefault();
    moveFocus.current = true;
    setCursor(next());
  };

  // The first seven cells are always Monday to Sunday.
  const headers = weeks[0] ?? [];

  return (
    <div className="pane padded journal-page">
      <div className="journal-layout">
        <div className="journal">
          <div className="journal-head">
            <h2 className="h-big" id="journal-month" aria-live="polite">
              {monthLabel}
            </h2>
            <p className="journal-count">{copy.journal.count(inMonth)}</p>
            <div className="journal-nav">
              <button
                type="button"
                className="iconbtn"
                aria-label={copy.journal.previousMonth}
                title={copy.journal.previousMonth}
                onClick={() => setCursor((c) => shiftMonth(c, -1))}
              >
                <ChevronLeftIcon size={16} />
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setCursor(today)}
                disabled={cursor.year === today.year && cursor.month === today.month}
              >
                {copy.journal.thisMonth}
              </button>
              <button
                type="button"
                className="iconbtn"
                aria-label={copy.journal.nextMonth}
                title={copy.journal.nextMonth}
                onClick={() => setCursor((c) => shiftMonth(c, 1))}
              >
                <ChevronIcon size={16} />
              </button>
            </div>
          </div>

          <div
            className="journal-grid"
            role="grid"
            aria-labelledby="journal-month"
            aria-describedby="journal-hint"
            ref={grid}
            onKeyDown={onKeyDown}
          >
            <div className="journal-row journal-weekdays" role="row">
              {headers.map((cell) => (
                <span key={isoDate(cell.date)} role="columnheader" aria-label={WEEKDAY_LONG.format(asDate(cell.date))}>
                  {WEEKDAY_FORMAT.format(asDate(cell.date))}
                </span>
              ))}
            </div>
            {weeks.map((week) => (
              <div className="journal-row" role="row" key={isoDate(week[0]!.date)}>
                {week.map((cell) => {
                  const iso = isoDate(cell.date);
                  const has = days.has(iso);
                  const dueCount = dueByDay.get(iso) ?? 0;
                  const isToday = sameDate(cell.date, today);
                  const focused = sameDate(cell.date, cursor);
                  return (
                    <span role="gridcell" key={iso} aria-selected={focused}>
                      <button
                        type="button"
                        className="journal-day"
                        data-date={iso}
                        data-has={has}
                        data-today={isToday}
                        data-outside={!cell.inMonth}
                        tabIndex={focused ? 0 : -1}
                        aria-current={isToday ? 'date' : undefined}
                        data-due={dueCount > 0}
                        aria-label={copy.journal.dayLabel(
                          dayName(cell.date),
                          copy.journal.withDue(has ? copy.journal.hasNote : copy.journal.noNote, dueCount),
                          isToday,
                        )}
                        onFocus={() => {
                          // Not for a neighbouring month's day: turning the page
                          // under a pointer that is still pressed would swallow its click.
                          if (!focused && cell.inMonth) setCursor(cell.date);
                        }}
                        onClick={() => open(cell.date)}
                      >
                        <span className="journal-num">{cell.date.day}</span>
                        {has && <i className="journal-mark" aria-hidden="true" />}
                        {dueCount > 0 && (
                          <span className="journal-due" aria-hidden="true">
                            {dueCount}
                          </span>
                        )}
                      </button>
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
          <p className="journal-hint" id="journal-hint">
            {copy.journal.hint}
          </p>

          {due !== undefined && (
            <section className="journal-due-list" aria-labelledby="journal-due-title">
              <h3 className="filter-label" id="journal-due-title">
                {copy.journal.dueTitle}
              </h3>
              {overdue.length === 0 && inThisMonth.length === 0 ? (
                <p className="h-sub">{copy.journal.dueEmpty}</p>
              ) : (
                <>
                  {overdue.length > 0 && (
                    <DueGroup label={copy.journal.overdue} tasks={overdue} onOpenTask={onOpenTask} />
                  )}
                  {inThisMonth.length > 0 && (
                    <DueGroup label={monthLabel} tasks={inThisMonth} onOpenTask={onOpenTask} />
                  )}
                </>
              )}
              {dueTruncated && <p className="h-sub">{copy.journal.dueTruncated}</p>}
            </section>
          )}
        </div>
        {aside}
      </div>
    </div>
  );
}

function DueGroup({
  label,
  tasks,
  onOpenTask,
}: {
  label: string;
  tasks: DueTask[];
  onOpenTask: ((owner: string, path: string, id: string) => void) | undefined;
}): React.JSX.Element {
  return (
    <div className="journal-due-group">
      <p className="journal-due-label">{label}</p>
      <ul>
        {tasks.map((task) => {
          const [year, month, day] = task.due.split('-').map(Number) as [number, number, number];
          const list = taskListName(task.path);
          return (
            <li key={`${task.owner}:${task.path}:${task.id}`}>
              <button
                type="button"
                className="linky"
                aria-label={copy.journal.openDue(task.title, list)}
                onClick={() => onOpenTask?.(task.owner, task.path, task.id)}
              >
                <span className="journal-due-date">{SHORT_DAY.format(asDate({ year, month, day }))}</span>
                {task.title}
                <span className="pth"> · {list}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
