/**
 * Daily notes: where a day lives in the vault, and how to recognise one.
 *
 * Shared by the server and the app, because both have to agree on exactly one
 * pattern. The app writes `50_Journal/2026/09/2026-09-17.md`; the findings on
 * the server decide that the links in it to days not written yet are not broken.
 * Two hand-written copies of that pattern would drift, and the drift would show
 * up as every daily note quietly lowering the health score.
 *
 * Dependency free on purpose: the brain's model and the server's queries import
 * this, and neither should pull in a schema library for a regular expression.
 */

/** The folder every daily note lives under. */
export const JOURNAL_ROOT = '50_Journal';

/**
 * The heading a day's prose goes under.
 *
 * German, like everything else a daily note is written with: this is text in
 * the vault, not a label on a screen — see `dayHeading`. Named here rather than
 * spelled out at each of the three places that care, because they have to agree
 * exactly. The template writes it, the start page's preview reads it, and the
 * capture field appends under it; a typo in any one of them would silently make
 * that one look at an empty section.
 */
export const NOTES_SECTION = 'Notizen';

/** A calendar day, without a time or a time zone. `month` is 1–12. */
export interface JournalDate {
  year: number;
  month: number;
  day: number;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** `2026-09-17`. */
export function isoDate(date: JournalDate): string {
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
}

/**
 * Whether the three numbers name a day that exists.
 *
 * Checked by arithmetic rather than through `Date`, which rolls `2026-02-30`
 * over into March instead of refusing it, and which would bring the local time
 * zone into a question that has nothing to do with one.
 */
export function isValidDate(date: JournalDate): boolean {
  const { year, month, day } = date;
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

/** Days in a month of the proleptic Gregorian calendar. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Reads `2026-09-17`; `null` for anything else, including an impossible day. */
export function parseIsoDate(text: string): JournalDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return null;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  return isValidDate(date) ? date : null;
}

/** The vault path of a day's note: `50_Journal/2026/09/2026-09-17.md`. */
export function journalPath(date: JournalDate): string {
  return `${journalStem(date)}.md`;
}

/** The same path without its extension — the form a wikilink addresses it by. */
export function journalStem(date: JournalDate): string {
  return `${JOURNAL_ROOT}/${pad(date.year, 4)}/${pad(date.month)}/${isoDate(date)}`;
}

/**
 * The day a path is the daily note of, or `null`.
 *
 * Exact: the year and month folders have to agree with the file name. A
 * `2026-09-17.md` filed under `2026/10` is a note somebody put there, not the
 * note the calendar would open for that day, and treating it as one would give
 * a day two notes.
 */
export function parseJournalPath(path: string): JournalDate | null {
  const match = /^50_Journal\/(\d{4})\/(\d{2})\/((\d{4})-(\d{2})-\d{2})\.md$/.exec(path);
  if (match === null) return null;
  if (match[1] !== match[4] || match[2] !== match[5]) return null;
  return parseIsoDate(match[3] ?? '');
}

/**
 * Whether a note is a daily note — the one test every rule about them starts from.
 *
 * A daily note is reached by its date through the calendar, not by links, and
 * it is finished when its day is over. So it is never "orphaned" and never
 * "untouched", on the server's findings and in the panel beside the editor
 * alike; both ask here rather than each keeping a copy of the pattern.
 */
export function isDailyNote(path: string): boolean {
  return parseJournalPath(path) !== null;
}

/**
 * The day a wikilink target names, when it names one in the journal pattern.
 *
 * Accepts the path form the template writes (`50_Journal/2026/09/2026-09-16`,
 * with or without `.md`) and a bare date (`2026-09-16`), which is what a person
 * types by hand.
 */
export function parseJournalLinkTarget(target: string): JournalDate | null {
  const trimmed = target.trim().replace(/\.md$/i, '');
  const bare = parseIsoDate(trimmed);
  if (bare !== null) return bare;
  return parseJournalPath(`${trimmed}.md`);
}

/**
 * Whether a link that resolves to nothing is still not a broken link.
 *
 * Only inside a daily note, and only when it names a valid day: yesterday and
 * tomorrow are linked before either note exists, and they fill in on their own
 * the day somebody writes them. Anywhere else a link into the void stays a
 * finding, whatever it looks like.
 */
export function isPendingDayLink(source: string, target: string): boolean {
  return parseJournalPath(source) !== null && parseJournalLinkTarget(target) !== null;
}

/**
 * The day `offset` days from `date`, by the calendar.
 *
 * Plain day arithmetic in UTC, where every day is 24 hours long, so a daylight
 * saving change cannot turn "tomorrow" into "today at 23:00".
 */
export function addDays(date: JournalDate, offset: number): JournalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + offset));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/**
 * The device's local day at `now`.
 *
 * Local, not UTC: at half past midnight in Zurich it is already tomorrow there,
 * while UTC still says today — and the note somebody expects to open is the one
 * for the date on their own clock.
 */
export function localDate(now: Date): JournalDate {
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/** Monday = 0 … Sunday = 6. */
export function weekdayIndex(date: JournalDate): number {
  const sunday0 = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return (sunday0 + 6) % 7;
}

export function sameDate(a: JournalDate, b: JournalDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

const WEEKDAYS_DE = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const MONTHS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

/**
 * `Mittwoch, 17. September 2026`: the heading a daily note is written with.
 *
 * German regardless of the interface language, because this is text in the
 * vault and not a label on the screen. The interface can be switched; a note
 * written today stays written, and a journal whose headings change language
 * with a setting would read as two journals. The vault is German — its folder
 * sections, its tags and the conflict copies the server names are too.
 *
 * Spelled out rather than asked of `Intl`: which weekday and month names come
 * back depends on the ICU data the browser ships, and a note's text must not.
 */
export function dayHeading(date: JournalDate): string {
  return `${WEEKDAYS_DE[weekdayIndex(date)]}, ${date.day}. ${MONTHS_DE[date.month - 1]} ${date.year}`;
}

/**
 * A wikilink to a day's note, addressed by its full path.
 *
 * By path and not by the bare date, because the resolver matches a bare name
 * against every note of that title and takes the shortest path: a
 * `00_Inbox/2026-09-16.md` would win over the journal's own note. A path match
 * is tried first and is exact. The label keeps the rendered link as short as
 * the bare date would have been.
 */
export function dayLink(date: JournalDate): string {
  return `[[${journalStem(date)}|${isoDate(date)}]]`;
}

/**
 * The text a new daily note starts with.
 *
 * Frontmatter, the header line the vault's writing rules ask for, the heading,
 * the way to yesterday and tomorrow, and three empty sections. The empty task
 * is `- [ ]` without a trailing space, which the task index does not count — an
 * unwritten line must not show up as an open task.
 */
export function dailyNoteTemplate(date: JournalDate): string {
  const iso = isoDate(date);
  return [
    '---',
    `created: ${iso}`,
    `updated: ${iso}`,
    'tags: [journal]',
    '---',
    `> **type:** log · **topic:** journal · **src:** manual · **updated:** ${iso}`,
    '',
    `# ${dayHeading(date)}`,
    '',
    `← ${dayLink(addDays(date, -1))} · ${dayLink(addDays(date, 1))} →`,
    '',
    `## ${NOTES_SECTION}`,
    '',
    '## Aufgaben',
    '- [ ]',
    '',
    '## Links',
    '',
  ].join('\n');
}
