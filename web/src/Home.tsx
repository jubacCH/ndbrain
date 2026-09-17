/**
 * The start page: where to pick up, what happened today, how the vault is doing.
 *
 * It replaces the overview and keeps everything that stood there — the finding
 * counts now live in the health card, "recently edited" in Continue, "since
 * yesterday", open tasks and tags in tiles of their own.
 *
 * Only what actually happened is shown. "Today" is counted by the server from
 * the edit and access logs of the caller's own vault; a count that the data
 * cannot back — "new connections", say, since links carry no timestamp — is
 * left out rather than estimated. The two-week trace appears only when there is
 * something in it.
 *
 * No second canvas. The network is one click away, and a live simulation here
 * would spend a laptop's battery on a thumbnail.
 */

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { api, refKey, type ActivityDay, type NoteRow, type Overview, type TaskRow } from './api';
import { copy } from './copy';
import { HealthCard } from './Health';
import type { HealthKey } from './healthScore';
import { ChevronIcon, ChevronLeftIcon, NetworkIcon, TodayIcon } from './icons';
import { dayName } from './Journal';
import { addDays, isoDate, journalPath, localDate, notesPreview, type JournalDate } from './daily';
import { relativeTime } from './network/relativeTime';
import { displayPath } from './Tree';

/** How many days the trace covers, today included. */
export const TRACE_DAYS = 14;

/**
 * Local midnights: `days` days ending with today, as `days + 1` boundaries.
 *
 * Built from calendar fields rather than by subtracting 24 hours, so a day
 * that is 23 or 25 hours long because of daylight saving is still one day.
 */
export function localDayBounds(now: number, days = TRACE_DAYS): number[] {
  const today = new Date(now);
  const bounds: number[] = [];
  for (let offset = days - 1; offset >= -1; offset -= 1) {
    bounds.push(new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset).getTime());
  }
  return bounds;
}

/** The folder part of a path, as the tree names it, or "top level". */
function folderOf(path: string, hidePrefixes: boolean): string {
  return displayPath(path, hidePrefixes) || copy.home.topLevel;
}

export interface HomeProps {
  overview: Overview;
  /** The signed-in account. */
  self: string;
  /** Notes in the caller's own vault — what the health score divides by. */
  ownNotes: number;
  /** Recently opened notes, already resolved against the tree. */
  recents: NoteRow[];
  hidePrefixes: boolean;
  /** Fixed in tests; the clock otherwise. */
  now?: number;
  onOpen: (owner: string, path: string) => void;
  onTasks: () => void;
  onTidy: (focus?: HealthKey | 'stale') => void;
  onNetwork: () => void;
  /** ISO dates of the days with a daily note in the caller's own vault. */
  journalDays: ReadonlySet<string>;
  /** Opens a day's note, creating it if it is not there. */
  onOpenDay: (date: JournalDate) => void;
}

export function HomeView(props: HomeProps): React.JSX.Element {
  const now = props.now ?? Date.now();
  const bounds = useMemo(() => localDayBounds(now), [
    // Recomputed once a day, not on every render: keyed by today's midnight.
    new Date(now).toDateString(),
  ]);

  // Under the overview's key, so every write that marks the overview stale
  // marks these counts stale too.
  const daysQuery = useQuery({
    queryKey: ['overview', 'days', bounds[0], bounds.length],
    queryFn: () => api.activityDays(bounds),
    staleTime: 30_000,
    retry: false,
  });

  const { overview, self } = props;
  const { counts } = overview;

  return (
    <div className="pane padded home">
      <h2 className="h-big">{copy.overview.title}</h2>
      {/* No count line here. The header above already reads "N notes · N
          folders · N need attention", on every screen width, and the health
          card below names the same attention count with what it is made of.
          A third copy of the numbers only pushed the cards down. */}

      {/* Two stacks on a wide screen, so a tall list on the left never leaves a
          hole under a short card on the right; one column on a phone, where
          the stacks dissolve and `order` in the stylesheet interleaves them. */}
      <div className="home-grid">
        <div className="home-stack home-main">
        <DailyCard self={self} days={props.journalDays} now={now} onOpenDay={props.onOpenDay} />

        <Continue
          recents={props.recents}
          edited={overview.recent}
          self={self}
          hidePrefixes={props.hidePrefixes}
          now={now}
          onOpen={props.onOpen}
        />

        <Today
          days={daysQuery.data?.days ?? null}
          activity={overview.activity}
          now={now}
          onOpen={props.onOpen}
        />

        {overview.tags.length > 0 && (
          <section className="tile home-tags">
            <p className="cap">{copy.overview.tags}</p>
            <div className="tagcloud">
              {overview.tags.slice(0, 14).map((tag) => (
                <span className="pill p-tag" key={tag.tag}>
                  #{tag.tag} <span style={{ opacity: 0.6 }}>{tag.count}</span>
                </span>
              ))}
            </div>
          </section>
        )}
        </div>

        <div className="home-stack home-side">
        <HealthCard
          input={{
            notes: props.ownNotes,
            orphans: counts.orphans,
            broken: counts.deadLinks,
            untagged: counts.tagsInUse ? counts.untagged : null,
            conflicts: counts.conflicts,
          }}
          stale={counts.stale}
          attention={counts.attention}
          onPick={(key) => props.onTidy(key)}
          onOpen={() => props.onTidy()}
        />

        <Tasks tasks={overview.tasks} self={self} hidePrefixes={props.hidePrefixes} onOpen={props.onOpen} onTasks={props.onTasks} />

        <BrainEntry notes={counts.notes} onNetwork={props.onNetwork} />
        </div>
      </div>
    </div>
  );
}

/**
 * Today's daily note, a glance at it, and the days on either side.
 *
 * The arrows page the card, not the app: looking at what yesterday said is a
 * glance, and leaving the start page for it would be a detour. Opening is one
 * click on the day. A day with no note offers to start it — for today in the
 * words the button in the sidebar would use, for any other day by its date.
 *
 * The preview is read under the overview's key, so a save that marks the
 * overview stale refreshes it too, and returning here after writing shows what
 * was written rather than what the note said when it was first opened.
 */
function DailyCard({
  self,
  days,
  now,
  onOpenDay,
}: {
  self: string;
  days: ReadonlySet<string>;
  now: number;
  onOpenDay: (date: JournalDate) => void;
}): React.JSX.Element {
  const [offset, setOffset] = useState(0);
  const today = localDate(new Date(now));
  const date = addDays(today, offset);
  const exists = days.has(isoDate(date));
  const path = journalPath(date);

  const noteQuery = useQuery({
    queryKey: ['overview', 'daily', self, path],
    queryFn: () => api.getNote(self, path),
    enabled: exists,
    staleTime: 0,
    retry: false,
  });
  const preview = exists && noteQuery.data !== undefined ? notesPreview(noteQuery.data.note.content) : null;
  const name = dayName(date);

  return (
    <section className="tile home-daily" aria-labelledby="home-daily-title">
      <div className="home-daily-head">
        <p className="cap" id="home-daily-title">{copy.journal.card}</p>
        <div className="home-daily-nav">
          <button
            type="button"
            className="iconbtn"
            aria-label={copy.journal.previousDay}
            title={copy.journal.previousDay}
            onClick={() => setOffset((o) => o - 1)}
          >
            <ChevronLeftIcon size={16} />
          </button>
          {offset !== 0 && (
            <button type="button" className="btn home-daily-today" onClick={() => setOffset(0)}>
              {copy.journal.backToToday}
            </button>
          )}
          <button
            type="button"
            className="iconbtn"
            aria-label={copy.journal.nextDay}
            title={copy.journal.nextDay}
            onClick={() => setOffset((o) => o + 1)}
          >
            <ChevronIcon size={16} />
          </button>
        </div>
      </div>

      {exists ? (
        <button
          type="button"
          className="home-daily-open"
          aria-label={`${copy.journal.open}: ${name}`}
          onClick={() => onOpenDay(date)}
        >
          <span className="home-daily-date">
            <TodayIcon size={16} />
            {name}
          </span>
          {preview === null && !noteQuery.isError ? (
            <span className="home-daily-lines" aria-hidden="true">
              <span className="skel skel-row" style={{ width: '70%' }} />
            </span>
          ) : preview === null || preview.length === 0 ? (
            <span className="home-daily-empty">{copy.journal.emptyNotes}</span>
          ) : (
            <span className="home-daily-lines">
              {preview.map((line, i) => (
                <span key={i} className="home-daily-line">
                  {line}
                </span>
              ))}
            </span>
          )}
        </button>
      ) : (
        <div className="home-daily-missing">
          <span className="home-daily-date">
            <TodayIcon size={16} />
            {name}
          </span>
          <p className="empty">{copy.journal.cardNoNote}</p>
          <button type="button" className="btn btn-solid" onClick={() => onOpenDay(date)}>
            {offset === 0 ? copy.journal.start : copy.journal.startDay(name)}
          </button>
        </div>
      )}
    </section>
  );
}

function NoteLink({
  note,
  self,
  meta,
  hidePrefixes,
  onOpen,
}: {
  note: NoteRow;
  self: string;
  meta: string;
  hidePrefixes: boolean;
  onOpen: (owner: string, path: string) => void;
}): React.JSX.Element {
  const folder = folderOf(note.path, hidePrefixes);
  return (
    <button
      type="button"
      className="home-note"
      aria-label={copy.home.openNote(note.title, folder)}
      onClick={() => onOpen(note.owner, note.path)}
    >
      <span className="home-note-title">
        {note.owner !== self && <span className="pill p-info">{note.owner}</span>}
        {note.title}
      </span>
      <span className="home-note-meta">
        <span className="home-note-folder">{folder}</span>
        <span className="home-note-when">{meta}</span>
      </span>
    </button>
  );
}

function Continue({
  recents,
  edited,
  self,
  hidePrefixes,
  now,
  onOpen,
}: {
  recents: NoteRow[];
  edited: NoteRow[];
  self: string;
  hidePrefixes: boolean;
  now: number;
  onOpen: (owner: string, path: string) => void;
}): React.JSX.Element {
  return (
    <section className="tile home-continue" aria-labelledby="home-continue-title">
      <p className="cap" id="home-continue-title">{copy.home.continue}</p>
      <div className="home-columns">
        <div>
          <p className="home-sub">{copy.home.opened}</p>
          {recents.length === 0 ? (
            <p className="empty">{copy.home.noOpened}</p>
          ) : (
            <div className="home-notes">
              {recents.slice(0, 6).map((note) => (
                <NoteLink
                  key={refKey(note.owner, note.path)}
                  note={note}
                  self={self}
                  hidePrefixes={hidePrefixes}
                  meta={copy.home.editedAgo(relativeTime(note.mtimeMs, now))}
                  onOpen={onOpen}
                />
              ))}
            </div>
          )}
        </div>
        <div>
          <p className="home-sub">{copy.home.edited}</p>
          {edited.length === 0 ? (
            <p className="empty">{copy.home.noEdited}</p>
          ) : (
            <div className="home-notes">
              {edited.slice(0, 8).map((note) => (
                <NoteLink
                  key={refKey(note.owner, note.path)}
                  note={note}
                  self={self}
                  hidePrefixes={hidePrefixes}
                  meta={relativeTime(note.mtimeMs, now)}
                  onOpen={onOpen}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

const DAY_FORMAT = new Intl.DateTimeFormat(copy.locale, { weekday: 'short', day: 'numeric', month: 'short' });

function Today({
  days,
  activity,
  now,
  onOpen,
}: {
  days: ActivityDay[] | null;
  activity: Overview['activity'];
  now: number;
  onOpen: (owner: string, path: string) => void;
}): React.JSX.Element {
  const today = days === null ? undefined : days[days.length - 1];
  const stats =
    today === undefined
      ? []
      : [
          { n: today.created, label: copy.home.newNotes(today.created) },
          { n: today.edited, label: copy.home.editedNotes(today.edited) },
          { n: today.agentReads, label: copy.home.agentReads(today.agentReads) },
          { n: today.agentWrites, label: copy.home.agentWrites(today.agentWrites) },
        ];
  const quiet = today !== undefined && stats.every((s) => s.n === 0) && today.touched === 0;

  return (
    <section className="tile home-today" aria-labelledby="home-today-title">
      <p className="cap" id="home-today-title">{copy.home.today}</p>

      {today !== undefined &&
        (quiet ? (
          <p className="empty">{copy.home.quietToday}</p>
        ) : (
          <dl className="home-stats">
            {stats.map((s) => (
              <div key={s.label} data-zero={s.n === 0}>
                <dt>{s.label}</dt>
                <dd>{s.n}</dd>
              </div>
            ))}
          </dl>
        ))}
      {today !== undefined && <p className="home-note-small">{copy.home.ownVaultOnly}</p>}

      {days !== null && <Trace days={days} />}

      {activity.length > 0 && (
        <>
          <p className="home-sub">{copy.home.sinceYesterday}</p>
          <div className="list">
            {activity.slice(0, 8).map((row) => (
              <button
                type="button"
                className="item"
                key={refKey(row.owner, row.path)}
                disabled={row.deleted}
                onClick={() => !row.deleted && onOpen(row.owner, row.path)}
              >
                {row.actor !== '' && row.action === 'delete' && <span className="pill p-crit">{copy.overview.deleted}</span>}
                <span className="t" style={row.deleted ? { textDecoration: 'line-through' } : undefined}>
                  {row.title}
                </span>
                <span className="r">
                  {row.edits > 1 && `${row.edits}× · `}
                  {relativeTime(row.at, now)}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Notes changed per day, as fourteen thin bars.
 *
 * Bars rather than a line: these are counts of separate days, not a quantity
 * flowing between them. One series in the accent, today a step brighter, no
 * axis — the exact numbers are in each bar's title and in the list read out to
 * a screen reader. Drawn only when at least one day has something in it: a row
 * of empty slots says nothing a sentence does not.
 */
export function Trace({ days }: { days: ActivityDay[] }): React.JSX.Element | null {
  const total = days.reduce((sum, day) => sum + day.touched, 0);
  if (total === 0) return null;

  const max = Math.max(...days.map((day) => day.touched));
  const width = 14;
  const gap = 4;
  const height = 36;

  return (
    <figure className="home-trace">
      <figcaption className="home-sub">{copy.home.trace}</figcaption>
      <svg
        viewBox={`0 0 ${days.length * (width + gap) - gap} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={copy.home.traceLabel(total, days.length)}
      >
        {days.map((day, i) => {
          const h = day.touched === 0 ? 2 : Math.max(4, (day.touched / max) * height);
          return (
            <rect
              key={day.start}
              x={i * (width + gap)}
              y={height - h}
              width={width}
              height={h}
              rx={2}
              data-today={i === days.length - 1}
              data-zero={day.touched === 0}
            >
              <title>{copy.home.traceDay(DAY_FORMAT.format(new Date(day.start)), day.touched)}</title>
            </rect>
          );
        })}
      </svg>
      <ul className="sr-only">
        {days.map((day) => (
          <li key={day.start}>{copy.home.traceDay(DAY_FORMAT.format(new Date(day.start)), day.touched)}</li>
        ))}
      </ul>
    </figure>
  );
}

function Tasks({
  tasks,
  self,
  hidePrefixes,
  onOpen,
  onTasks,
}: {
  tasks: TaskRow[];
  self: string;
  hidePrefixes: boolean;
  onOpen: (owner: string, path: string) => void;
  onTasks: () => void;
}): React.JSX.Element {
  const shown = tasks.slice(0, 8);
  return (
    <section className="tile home-tasks" aria-labelledby="home-tasks-title">
      <p className="cap" id="home-tasks-title">{copy.home.tasks}</p>
      {tasks.length === 0 ? (
        <p className="empty">{copy.overview.noTasks}</p>
      ) : (
        <div className="list">
          {shown.map((task) => (
            <button
              type="button"
              className="item"
              key={`${refKey(task.owner, task.path)}:${task.line}`}
              onClick={() => onOpen(task.owner, task.path)}
            >
              <span className="t">
                {task.owner !== self && <span className="pill p-info">{task.owner}</span>}
                {task.text}
              </span>
              <span className="r">{folderOf(task.path, hidePrefixes)}</span>
            </button>
          ))}
        </div>
      )}
      <button type="button" className="tile-more" onClick={onTasks}>
        {tasks.length > shown.length ? `${copy.overview.seeAllTasks} · ${copy.home.tasksMore(tasks.length - shown.length)}` : copy.overview.seeAllTasks}
      </button>
    </section>
  );
}

/** Fixed points of a small, still constellation — decoration, not data. */
const PREVIEW_NODES: Array<[number, number, number]> = [
  [38, 30, 2.6], [58, 20, 2], [80, 26, 3.4], [102, 18, 2], [122, 30, 2.4],
  [30, 52, 2], [52, 46, 3], [74, 52, 2.2], [96, 44, 4.2], [118, 52, 2.6], [138, 46, 2],
  [42, 72, 2.4], [64, 70, 2], [88, 74, 2.8], [110, 70, 2.2], [130, 66, 2],
];
const PREVIEW_EDGES: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 6], [5, 6], [6, 7], [7, 8], [2, 8], [8, 9], [9, 10], [4, 9],
  [6, 11], [11, 12], [12, 13], [8, 13], [13, 14], [9, 14], [14, 15], [10, 15], [7, 12],
];

function BrainEntry({ notes, onNetwork }: { notes: number; onNetwork: () => void }): React.JSX.Element {
  return (
    <section className="tile home-brain">
      <p className="cap">{copy.home.brain}</p>
      <button type="button" className="home-brain-open" onClick={onNetwork}>
        <svg className="home-brain-preview" viewBox="0 0 168 92" aria-hidden="true">
          {PREVIEW_EDGES.map(([a, b]) => {
            const [x1, y1] = PREVIEW_NODES[a]!;
            const [x2, y2] = PREVIEW_NODES[b]!;
            return <line key={`${a}-${b}`} x1={x1} y1={y1} x2={x2} y2={y2} />;
          })}
          {PREVIEW_NODES.map(([x, y, r], i) => (
            <circle key={i} cx={x} cy={y} r={r} />
          ))}
        </svg>
        <span className="home-brain-text">
          <span className="home-brain-title">
            <NetworkIcon size={16} />
            {copy.home.openNetwork}
          </span>
          <span className="home-brain-hint">
            {copy.home.brainHint} {copy.overview.notes(notes)}.
          </span>
        </span>
      </button>
    </section>
  );
}
