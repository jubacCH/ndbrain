/**
 * Daily notes on the app's side: which days exist, the month on screen, and the
 * few lines the home card shows of a day.
 *
 * The pattern itself — where a day lives, what a new one says — is in
 * `shared/journal.ts`, which the server reads as well. This file only adds what
 * a screen needs on top of it.
 */

import type { NoteRow } from './api';
import {
  addDays,
  daysInMonth,
  isoDate,
  parseJournalPath,
  weekdayIndex,
  type JournalDate,
} from '../../shared/journal';

export {
  addDays,
  dailyNoteTemplate,
  isoDate,
  journalPath,
  localDate,
  parseIsoDate,
  parseJournalLinkTarget,
  parseJournalPath,
  sameDate,
  weekdayIndex,
  type JournalDate,
} from '../../shared/journal';

/**
 * The days that have a daily note, as ISO dates.
 *
 * Only the caller's own vault. Somebody else's journal shared into view is
 * theirs to keep; marking their days here would offer to open — or, for a day
 * they have not written, to create — a note in a vault this calendar never
 * writes to.
 */
export function journalDays(notes: readonly NoteRow[], self: string): Set<string> {
  const days = new Set<string>();
  for (const note of notes) {
    if (note.owner !== self) continue;
    const date = parseJournalPath(note.path);
    if (date !== null) days.add(isoDate(date));
  }
  return days;
}

/** One cell of the month grid. */
export interface GridDay {
  date: JournalDate;
  /** False for the days of the neighbouring months that fill the first and last week. */
  inMonth: boolean;
}

/**
 * The weeks of a month, Monday first, padded with the neighbouring months'
 * days so every row has seven cells.
 *
 * Monday first because that is how a Swiss calendar reads. Always whole weeks,
 * so the arrow keys move through a regular grid rather than falling off the end
 * of a ragged last row.
 */
export function monthGrid(year: number, month: number): GridDay[][] {
  const first: JournalDate = { year, month, day: 1 };
  const lead = weekdayIndex(first);
  const length = daysInMonth(year, month);
  const cells = Math.ceil((lead + length) / 7) * 7;

  const weeks: GridDay[][] = [];
  for (let i = 0; i < cells; i += 1) {
    const date = addDays(first, i - lead);
    if (i % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1]!.push({ date, inMonth: date.month === month });
  }
  return weeks;
}

/** The month `offset` months away, day kept where the month has it. */
export function shiftMonth(date: JournalDate, offset: number): JournalDate {
  const index = date.year * 12 + (date.month - 1) + offset;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
}

/**
 * The first lines a person wrote under "Notizen", as plain text.
 *
 * Plain on purpose: the card is a glance, and markdown punctuation or a link's
 * brackets there would read as noise. Stops at the next heading, so the task
 * list and the links below never leak into the preview, and gives nothing at
 * all for a day whose notes section is still empty — the card then says so
 * instead of showing the template back.
 */
export function notesPreview(content: string, maxLines = 3): string[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^##\s+Notizen\s*$/.test(line.trim()));
  if (start === -1) return [];

  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    const text = plain(line);
    if (text === '') continue;
    out.push(text);
    if (out.length >= maxLines) break;
  }
  return out;
}

function plain(line: string): string {
  return line
    .replace(/!\[\[[^\]]*\]\]/g, '')
    .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, target: string, label?: string) =>
      (label ?? target.split('/').pop() ?? '').trim(),
    )
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-*+]\s+\[[ xX]\]|[-*+]|\d+[.)]|>)\s*/, '')
    .replace(/(\*\*|__|~~|`|\*)/g, '')
    .trim();
}
