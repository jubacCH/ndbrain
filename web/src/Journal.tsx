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
 * calendar needs no request of its own.
 *
 * Beside the calendar sit the open tasks, handed in by the shell: the page is
 * where somebody plans the day, and a day is planned against what is still
 * open. On a narrow screen they wrap below the calendar instead.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

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
}

export function JournalView({ days, now, onOpenDay, aside }: JournalViewProps): React.JSX.Element {
  const today = localDate(new Date(now ?? Date.now()));
  const [cursor, setCursor] = useState<JournalDate>(today);
  /** Only a key press moves focus; a month button must keep its own. */
  const moveFocus = useRef(false);
  const grid = useRef<HTMLDivElement>(null);

  const weeks = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor.year, cursor.month]);
  const inMonth = weeks.flat().filter((cell) => cell.inMonth && days.has(isoDate(cell.date))).length;
  const monthLabel = MONTH_FORMAT.format(asDate({ ...cursor, day: 1 }));

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
                        aria-label={copy.journal.dayLabel(
                          dayName(cell.date),
                          has ? copy.journal.hasNote : copy.journal.noNote,
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
        </div>
        {aside}
      </div>
    </div>
  );
}
