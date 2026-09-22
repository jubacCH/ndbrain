/**
 * The librarian surfaces: tidy-up, tasks, search results and sharing.
 *
 * The start page lives in `Home.tsx`.
 *
 * Denser than the writing surface and monospaced wherever data appears — paths,
 * counts, tags. Two registers in one application, told apart by typography
 * rather than by colour.
 */

import { Fragment, useEffect, useRef, useState } from 'react';
import { copy } from './copy';
import { ownerLabel, useOwners } from './owners';
import { HealthHeader, healthLabel } from './Health';
import type { HealthKey } from './healthScore';

import { ShareKindIcon } from './ShareDialog';
import { refKey, type ConflictRow, type LinkRow, type MissingNote, type NoteRow, type SearchHit, type Share, type TaskRow, type Tasks, type Tidy } from './api';

const RELATIVE = new Intl.RelativeTimeFormat(copy.locale, { numeric: 'auto' });

export function ago(mtimeMs: number, now = Date.now()): string {
  const minutes = Math.round((mtimeMs - now) / 60_000);
  if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return RELATIVE.format(hours, 'hour');
  return RELATIVE.format(Math.round(hours / 24), 'day');
}

/**
 * The tidy-up view — the thing no other notes tool does.
 *
 * Findings are listed as rows in a table because the point is comparison: which
 * of these matters, which can go. Selection and bulk actions live here rather
 * than in the tree, since tidying is a deliberate session, not something that
 * happens while writing.
 *
 * Your own vault only — the server answers this one without the shares, so the
 * paths here need no owner. That is a product judgement rather than a permission
 * limit: "orphaned", "untagged" and "stale" are verdicts on how somebody keeps
 * their notes, and handing a guest a checkbox list to bulk-delete another
 * person's notes by that verdict is the wrong default.
 */
export function TidyView({
  data,
  selected,
  onToggle,
  onToggleAll,
  onKeepSelected,
  onOpen,
  onBulk,
  busy,
  tags,
  dirs,
  health,
  initialFocus = null,
  after,
}: {
  data: Tidy;
  selected: Set<string>;
  onToggle: (path: string) => void;
  onToggleAll: (paths: string[]) => void;
  /**
   * Narrows the selection to these paths. Called when the view is narrowed to
   * one finding: a row selected under "all" and then filtered out of sight
   * must not be reached by the bulk action.
   */
  onKeepSelected?: (paths: string[]) => void;
  onOpen: (path: string) => void;
  onBulk: (action: 'move' | 'tag' | 'delete') => void;
  busy: boolean;
  tags: Array<{ tag: string; count: number }>;
  dirs: string[];
  /**
   * What the health head needs beyond the findings: the own-vault note count,
   * and whether tagging is a convention here. Without it there is no head.
   */
  health?: { notes: number; tagsInUse: boolean };
  /** A finding to narrow the list to on arrival — a click on the home view's card. */
  initialFocus?: HealthKey | 'stale' | null;
  /** Rendered at the end of the pane, below the findings: Recently deleted. */
  after?: React.ReactNode;
}): React.JSX.Element {
  type Row = { path: string; title: string; finding: string; kind: 'crit' | 'warn'; when: string; key: HealthKey | 'stale' };

  /**
   * One finding at a time, or all of them.
   *
   * Narrowing rather than scrolling to a section: the findings share one table,
   * sorted by kind, and "the 29 broken links" is easier to work through as a
   * table of 29 than as rows somewhere in a table of 60. Select-all follows what
   * is shown, so a bulk action never reaches a row that is out of sight.
   */
  const [focus, setFocus] = useState<HealthKey | 'stale' | null>(initialFocus);
  const findingsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus === null) return;
    findingsRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [focus]);

  void tags;
  void dirs;

  const rows: Row[] = [
    ...data.orphans.map((n: NoteRow) => ({
      path: n.path,
      title: n.title,
      finding: copy.tidy.findingOrphaned,
      key: 'orphans' as const,
      kind: 'crit' as const,
      when: ago(n.mtimeMs),
    })),
    ...data.deadLinks.map((l: LinkRow) => ({
      path: l.source,
      title: l.targetRaw,
      finding: copy.tidy.findingBroken,
      key: 'broken' as const,
      kind: 'crit' as const,
      when: '—',
    })),
    ...data.untagged.map((n: NoteRow) => ({
      path: n.path,
      title: n.title,
      finding: copy.tidy.findingUntagged,
      key: 'untagged' as const,
      kind: 'warn' as const,
      when: ago(n.mtimeMs),
    })),
    ...data.stale.map((n: NoteRow) => ({
      path: n.path,
      title: n.title,
      finding: copy.tidy.findingUntouched,
      key: 'stale' as const,
      kind: 'warn' as const,
      when: ago(n.mtimeMs),
    })),
  ];

  // Conflict copies are listed as their own section below — a copy and its
  // original are two paths, and the shared `rows` shape above only carries one.
  // They still count toward "how many findings", "select all" and the bulk
  // bar, so every one of those stays honest about them rather than only about
  // the four findings that happen to fit the shared row shape.
  const total = rows.length + data.conflicts.length;
  const shownRows = focus === null ? rows : rows.filter((r) => r.key === focus);
  const shownConflicts = focus === null || focus === 'conflicts' ? data.conflicts : [];
  // The missing names are the broken links regrouped, so they follow the broken
  // links when the view is narrowed. Narrowed to the orphans, they would be a
  // second subject on a screen that is meant to hold one.
  const shownMissing = focus === null || focus === 'broken' ? data.missing : [];
  const allPaths = [...new Set([...shownRows.map((r) => r.path), ...shownConflicts.map((c) => c.path)])];
  const allSelected = allPaths.length > 0 && selected.size === allPaths.length;
  const selectAll = (): void => onToggleAll(allPaths);

  // The latest shown paths, read by the effect below, which runs on a change of
  // focus only — not on every render, where it would fight a checkbox click.
  const shownPaths = useRef(allPaths);
  shownPaths.current = allPaths;
  const keep = useRef(onKeepSelected);
  keep.current = onKeepSelected;
  useEffect(() => {
    keep.current?.(shownPaths.current);
  }, [focus]);

  return (
    <div className="pane padded">
      <h2 className="h-big">{copy.tidy.title}</h2>
      {data.truncated && (
        <p className="warnline" role="status">
          More findings than fit in one answer — showing the first {data.orphans.length} of{' '}
          {data.totals.orphans} orphaned, {data.untagged.length} of {data.totals.untagged} untagged,{' '}
          {data.conflicts.length} of {data.totals.conflicts} conflict copies. Work through these and
          the rest will appear.
        </p>
      )}
      <p className="h-sub">
        {total === 0
          ? copy.tidy.clean
          : copy.tidy.found(total)}
      </p>

      {health !== undefined && (
        <HealthHeader
          input={{
            notes: health.notes,
            orphans: data.totals.orphans,
            broken: data.totals.deadLinks,
            untagged: health.tagsInUse ? data.totals.untagged : null,
            conflicts: data.totals.conflicts,
          }}
          stale={data.totals.stale}
          active={focus}
          onPick={(key) => setFocus((current) => (current === key ? null : key))}
          onClear={() => setFocus(null)}
        />
      )}

      {/*
        The action bar sits above both tables and stays visible whenever there
        is anything to select — a conflict copy is deleted through this same
        bar, not a second one, so it must not depend on the four findings
        below it having found anything.
      */}
      {total > 0 && (
        <div className="bulkbar" data-active={selected.size > 0}>
          <span className="bulkcount">
            {selected.size === 0 ? copy.tidy.nothingSelected : copy.tidy.selected(selected.size)}
          </span>
          <button type="button" className="btn" disabled={selected.size === 0 || busy} onClick={() => onBulk('move')}>
            {copy.tidy.move}
          </button>
          <button type="button" className="btn" disabled={selected.size === 0 || busy} onClick={() => onBulk('tag')}>
            {copy.tidy.tag}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={selected.size === 0 || busy}
            onClick={() => onBulk('delete')}
          >
            {copy.tidy.delete}
          </button>
          <span className="bulkhint">{copy.tidy.linksFollow}</span>
        </div>
      )}

      <div ref={findingsRef} className="tidy-findings">
      {focus !== null && (
        <p className="tidy-focus" role="status">
          {copy.health.showing(focus === 'stale' ? copy.tidy.findingUntouched : healthLabel(focus, 2))}
        </p>
      )}

      {shownRows.length > 0 && (
        <div className="tablewrap">
          <div className="tablescroll">
            <table>
              <thead>
                <tr>
                  <th className="pick">
                    <input
                      type="checkbox"
                      aria-label={copy.tidy.selectAll}
                      checked={allSelected}
                      onChange={selectAll}
                    />
                  </th>
                  <th>{copy.tidy.note}</th>
                  <th>{copy.tidy.path}</th>
                  <th>{copy.tidy.finding}</th>
                  <th className="n">{copy.tidy.lastTouched}</th>
                </tr>
              </thead>
              <tbody>
                {shownRows.map((row, index) => (
                  <tr
                    key={`${row.finding}:${row.path}:${index}`}
                    data-selected={selected.has(row.path)}
                    onClick={() => onOpen(row.path)}
                  >
                    <td className="pick" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(row.path)}
                        onChange={() => onToggle(row.path)}
                        aria-label={copy.tidy.select(row.title)}
                      />
                    </td>
                    <td className="nm">{row.title}</td>
                    <td className="pth">{row.path.split('/').slice(0, -1).join('/') || '/'}</td>
                    <td>
                      <span className={`pill p-${row.kind}`}>{row.finding}</span>
                    </td>
                    <td className="n">{row.when}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {shownConflicts.length > 0 && (
        <ConflictSection
          conflicts={shownConflicts}
          selected={selected}
          allSelected={allSelected}
          onToggle={onToggle}
          onSelectAll={selectAll}
          onOpen={onOpen}
        />
      )}

      {shownMissing.length > 0 && <MissingSection missing={shownMissing} onOpen={onOpen} />}
      </div>
      {after}
    </div>
  );
}

/**
 * The full task list: every `- [ ]` the caller may read, grouped by the note
 * it lives in.
 *
 * Grouped by note rather than shown as a flat list, on the same reasoning the
 * search hits and the tidy findings already follow — a task read on its own is
 * routinely meaningless ("Run step 3"), and the note it sits in is
 * the cheapest context that fixes that. The list arrives from the server
 * already ordered by owner, then path, then line, so grouping is one pass over
 * it rather than a second request per note.
 *
 * A table with aligned columns, like the tidy view — not another bento tile.
 * The overview tile is the teaser; this is the whole list, with the folder
 * filter `search` already has and the same "capped, and says so" honesty
 * `tidy` uses for a truncated answer.
 */
export function TasksView({
  data,
  dirs,
  dir,
  includeDone,
  self,
  busy,
  onDir,
  onIncludeDone,
  onToggle,
  onOpen,
  embedded = false,
}: {
  data: Tasks;
  /** Top-level folders, for the folder filter — the same pattern `search` uses. */
  dirs: string[];
  dir: string | undefined;
  includeDone: boolean;
  /** The signed-in account; a task from elsewhere is marked with its vault. */
  self: string;
  /** A toggle is in flight — checkboxes are inert until it lands. */
  busy: boolean;
  onDir: (dir?: string) => void;
  onIncludeDone: (value: boolean) => void;
  onToggle: (task: TaskRow) => void;
  onOpen: (owner: string, path: string, line: number) => void;
  /**
   * Drawn as a section of the page around it rather than as a pane of its own
   * — the journal sets it beside the calendar.
   */
  embedded?: boolean;
}): React.JSX.Element {
  const groups: Array<{ owner: string; path: string; tasks: TaskRow[] }> = [];
  for (const task of data.tasks) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.owner === task.owner && last.path === task.path) {
      last.tasks.push(task);
    } else {
      groups.push({ owner: task.owner, path: task.path, tasks: [task] });
    }
  }

  const Frame = embedded ? 'section' : 'div';
  return (
    <Frame
      className={embedded ? 'journal-tasks' : 'pane padded'}
      aria-labelledby={embedded ? 'journal-tasks-title' : undefined}
    >
      <h2 className="h-big" id={embedded ? 'journal-tasks-title' : undefined}>
        {copy.tasks.title}
      </h2>

      {data.truncated && (
        <p className="warnline" role="status">
          {copy.tasks.truncated(data.tasks.length, data.total)}
        </p>
      )}

      <p className="h-sub">
        {data.tasks.length === 0
          ? dir !== undefined || includeDone
            ? copy.tasks.emptyFiltered
            : copy.tasks.empty
          : includeDone
            ? copy.tasks.foundIncludingDone(data.tasks.length)
            : copy.tasks.found(data.tasks.length)}
      </p>

      <div className="filters">
        <button type="button" className="filter" aria-pressed={includeDone} onClick={() => onIncludeDone(!includeDone)}>
          {copy.tasks.includeDone}
        </button>

        {dirs.length > 0 && <span className="filter-label">{copy.tasks.folder}</span>}
        {dirs.slice(0, 12).map((d) => (
          <button
            type="button"
            key={d}
            className="filter"
            aria-pressed={dir === d}
            onClick={() => onDir(dir === d ? undefined : d)}
          >
            {d}
          </button>
        ))}

        {dir !== undefined && (
          <button type="button" className="filter" onClick={() => onDir(undefined)}>
            {copy.tasks.clear}
          </button>
        )}
      </div>

      {groups.length > 0 && (
        <div className="tablewrap">
          <div className="tablescroll">
            <table>
              <tbody>
                {groups.map((group) => (
                  <Fragment key={refKey(group.owner, group.path)}>
                    <tr
                      className="task-group"
                      onClick={() => onOpen(group.owner, group.path, group.tasks[0]?.line ?? 1)}
                    >
                      <td className="nm" colSpan={2}>
                        {group.owner !== self && <span className="pill p-info">{group.owner}</span>}
                        {group.path.split('/').slice(0, -1).join('/') || '/'}
                        <span className="pth"> · {group.path.split('/').pop()}</span>
                      </td>
                    </tr>
                    {group.tasks.map((task) => (
                      <tr key={`${refKey(task.owner, task.path)}:${task.line}`}>
                        <td className="pick" onClick={(event) => event.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={task.done}
                            disabled={busy}
                            onChange={() => onToggle(task)}
                            aria-label={task.done ? copy.tasks.uncheck(task.text) : copy.tasks.check(task.text)}
                          />
                        </td>
                        <td
                          onClick={() => onOpen(task.owner, task.path, task.line)}
                          style={task.done ? { textDecoration: 'line-through', opacity: 0.65 } : undefined}
                        >
                          {task.text}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Frame>
  );
}

/**
 * One row per conflict copy, copy and original side by side.
 *
 * Its own table rather than more rows in the one above: a finding there is one
 * path with one action, and a conflict is two — the note that needs a decision
 * and the note it was measured against. Deleting the copy goes through the same
 * selection and the same bulk-delete action as everything else; there is no
 * merge tool and no second write path here, only a way to see these and get to
 * both notes in one click.
 */
function ConflictSection({
  conflicts,
  selected,
  allSelected,
  onToggle,
  onSelectAll,
  onOpen,
}: {
  conflicts: ConflictRow[];
  selected: Set<string>;
  /** Mirrors the main table's own "select all" — one selection, two tables. */
  allSelected: boolean;
  onToggle: (path: string) => void;
  onSelectAll: () => void;
  onOpen: (path: string) => void;
}): React.JSX.Element {
  const linkStyle = { textDecoration: 'underline', textUnderlineOffset: 2 } as const;

  return (
    <section style={{ marginTop: 'var(--s-6)' }}>
      <h3 className="h-big" style={{ fontSize: 'var(--t-md)' }}>{copy.tidy.conflicts}</h3>
      <p className="h-sub">{copy.tidy.conflictHint}</p>
      <div className="tablewrap">
        <div className="tablescroll">
          <table>
            <thead>
              <tr>
                <th className="pick">
                  <input
                    type="checkbox"
                    aria-label={copy.tidy.selectAll}
                    checked={allSelected}
                    onChange={onSelectAll}
                  />
                </th>
                <th>{copy.tidy.conflictCopy}</th>
                <th>{copy.tidy.conflictOriginal}</th>
                <th className="n">{copy.tidy.lastTouched}</th>
              </tr>
            </thead>
            <tbody>
              {conflicts.map((c) => (
                <tr key={c.path} data-selected={selected.has(c.path)}>
                  <td className="pick">
                    <input
                      type="checkbox"
                      checked={selected.has(c.path)}
                      onChange={() => onToggle(c.path)}
                      aria-label={copy.tidy.select(c.title)}
                    />
                  </td>
                  <td>
                    <button type="button" style={linkStyle} onClick={() => onOpen(c.path)}>
                      {c.title}
                    </button>
                  </td>
                  <td>
                    {c.originalExists ? (
                      <button type="button" style={linkStyle} onClick={() => onOpen(c.originalPath)}>
                        {c.originalTitle ?? c.originalPath}
                      </button>
                    ) : (
                      <span className="pill p-warn">{copy.tidy.conflictNoOriginal}</span>
                    )}
                  </td>
                  <td className="n">{ago(c.mtimeMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/**
 * "Asked for, never written" — the briefing's "What's missing?" (point 21),
 * answered from the index and from nothing else.
 *
 * The briefing wants to be told where the knowledge gaps are, and its example
 * of an answer — "you have extensive information about technical services, but
 * comparatively little about pricing" — is a judgement about subject matter
 * that nothing here could make. What the data does carry is narrower and, for
 * once, harder: a name somebody wrote inside a wikilink, more than once, from
 * more than one note, with no note of that name at the other end. That is the
 * vault stating a gap itself, in its own words, rather than an opinion about
 * what it ought to contain.
 *
 * So the wording stays at what was counted. "4 notes link to this name" is the
 * claim; "you know too little about pricing" is not, and there is no phrasing
 * of it this section is allowed to reach for — see the rule at the head of
 * `Home.tsx`.
 *
 * Every line leads back to its sources (briefing point 28): the notes that ask
 * are listed, and each opens.
 *
 * **Why here and not in a view of its own.** The finding is the dead links this
 * view already lists, grouped — the same rows, counted by name instead of one
 * by one. It belongs beside them, on the one screen that already states what
 * the vault's own structure says about itself. The three signals that were
 * *not* built would have needed a home too: a region with few notes (the brain's
 * layout merges anything under eight into its neighbour, so "the smallest
 * region" reports the layout, not the vault), a region without an entry note
 * (map-of-content notes live in their own folder and so in their own region,
 * which would flag nearly every other one), and a region that has been quiet
 * (a note nobody has edited in a year may be finished — the same reasoning that
 * keeps "untouched" out of the health score).
 *
 * Nothing here is selectable and nothing is bulk-acted on. The notes that ask
 * are ordinary notes and there is nothing wrong with them; the thing that is
 * missing has no path to tick.
 */
function MissingSection({
  missing,
  onOpen,
}: {
  missing: MissingNote[];
  onOpen: (path: string) => void;
}): React.JSX.Element {
  return (
    <section className="missing" aria-label={copy.tidy.missing.title}>
      <h3 className="h-big" style={{ fontSize: 'var(--t-md)' }}>{copy.tidy.missing.title}</h3>
      <p className="h-sub">{copy.tidy.missing.hint}</p>
      <ul className="missing-list">
        {missing.map((row) => (
          <li key={`${row.owner}:${row.name}`} className="missing-row">
            <p className="missing-name">{row.name}</p>
            <p className="missing-asked">{copy.tidy.missing.asked(row.asked.length)}</p>
            <p className="missing-from">{copy.tidy.missing.from}</p>
            <ul className="missing-sources">
              {row.asked.map((path) => (
                <li key={path}>
                  <button
                    type="button"
                    className="missing-source"
                    aria-label={copy.tidy.missing.openNamed(path)}
                    onClick={() => onOpen(path)}
                  >
                    {path}
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface SearchFilters {
  tag?: string;
  dir?: string;
  days?: number;
  /** A frontmatter key, optionally pinned to one of its values. */
  prop?: string;
  propValue?: string;
}

export function SearchView({
  query,
  hits,
  filters,
  tags,
  dirs,
  self,
  props,
  propValues,
  onToggleFilter,
  onClearFilters,
  onOpen,
  onQuery,
}: {
  query: string;
  hits: SearchHit[];
  filters: SearchFilters;
  tags: Array<{ tag: string; count: number }>;
  dirs: string[];
  /** Frontmatter keys the vault declares, most used first. */
  props: Array<{ key: string; count: number }>;
  /** Values for the key currently selected, if any. */
  propValues: Array<{ value: string; count: number }>;
  /** The signed-in account; hits from elsewhere are marked with their vault. */
  self: string;
  onToggleFilter: (patch: SearchFilters) => void;
  onClearFilters: () => void;
  onOpen: (owner: string, path: string) => void;
  /** The field belongs to this view, since the header no longer carries one. */
  onQuery: (value: string) => void;
}): React.JSX.Element {
  const owners = useOwners();
  const active =
    filters.tag !== undefined ||
    filters.dir !== undefined ||
    filters.days !== undefined ||
    filters.prop !== undefined;

  // The line itself is written in `copy.search.describeFilters`; this only says
  // which filters are in force.
  const described = copy.search.describeFilters({
    query: query.trim(),
    tag: filters.tag,
    folder: filters.dir,
    days: filters.days,
    prop: filters.prop,
    propValue: filters.propValue,
  });

  return (
    <div className="pane padded">
      <h2 className="h-big">{copy.search.title}</h2>
      <div className="searchbox">
        <input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder={copy.search.placeholder}
          aria-label={copy.search.label}
          autoFocus
        />
      </div>
      <p className="h-sub">
        {hits.length === 0 ? copy.search.nothingFound : copy.search.results(hits.length)}
        {described !== '' && ` — ${described}`}
      </p>

      <div className="filters">
        <span className="filter-label">{copy.search.period}</span>
        {[7, 30, 90].map((days) => (
          <button
            type="button"
            key={days}
            className="filter"
            aria-pressed={filters.days === days}
            onClick={() => onToggleFilter({ days })}
          >
            {copy.search.days(days)}
          </button>
        ))}

        {dirs.length > 0 && <span className="filter-label">{copy.search.folder}</span>}
        {dirs.slice(0, 8).map((dir) => (
          <button
            type="button"
            key={dir}
            className="filter"
            aria-pressed={filters.dir === dir}
            onClick={() => onToggleFilter({ dir })}
          >
            {dir}
          </button>
        ))}

        {/*
          The vault's own vocabulary, read out of the frontmatter rather than
          prescribed. Picking a key shows its values, so the second click is
          "status: active" instead of a text field somebody has to guess into.
        */}
        {props.length > 0 && <span className="filter-label">{copy.search.property}</span>}
        {props.slice(0, 8).map((p) => (
          <button
            type="button"
            key={p.key}
            className="filter"
            aria-pressed={filters.prop === p.key}
            onClick={() => onToggleFilter({ prop: p.key })}
          >
            {p.key} <span style={{ opacity: 0.6 }}>{p.count}</span>
          </button>
        ))}

        {propValues.length > 0 && filters.prop !== undefined && (
          <span className="filter-label">{copy.search.propertyIs(filters.prop)}</span>
        )}
        {propValues.slice(0, 10).map((v) => (
          <button
            type="button"
            key={v.value}
            className="filter"
            aria-pressed={filters.propValue === v.value}
            onClick={() => onToggleFilter({ propValue: v.value })}
          >
            {v.value} <span style={{ opacity: 0.6 }}>{v.count}</span>
          </button>
        ))}

        {tags.length > 0 && <span className="filter-label">{copy.search.tag}</span>}
        {tags.slice(0, 10).map((tag) => (
          <button
            type="button"
            key={tag.tag}
            className="filter"
            aria-pressed={filters.tag === tag.tag}
            onClick={() => onToggleFilter({ tag: tag.tag })}
          >
            #{tag.tag} <span style={{ opacity: 0.6 }}>{tag.count}</span>
          </button>
        ))}

        {active && (
          <button type="button" className="filter" onClick={onClearFilters}>
            {copy.search.clear}
          </button>
        )}
      </div>

      {hits.map((hit) => (
        <button
          type="button"
          className="hit"
          key={refKey(hit.owner, hit.path)}
          onClick={() => onOpen(hit.owner, hit.path)}
        >
          <span className="title">{hit.title}</span>
          <span className="path">
            {/* Search spans the shares, so a result can come from a vault that is
                not yours. Without the label, the path alone reads as your own. */}
            {hit.owner !== self && <span className="pill p-info">{ownerLabel(owners, hit.owner)}</span>}
            {hit.path}
          </span>
          {hit.snippet !== '' && <span className="snip">{hit.snippet}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * Sharing: what you have opened up, and what has been opened to you.
 *
 * Both directions on one page, because they are the same question asked from
 * two sides and somebody checking "who can see my notes" should not have to
 * know which list to look in.
 *
 * The screen is deliberately plain — a table of grants and a form. Sharing in a
 * self-hosted tool is a security boundary, and a boundary is easier to trust
 * when it is legible: every row says who, which folder, and whether they can
 * write, in that order, with no state hidden behind a toggle.
 */
export function SharesView({
  granted,
  received,
  dirs,
  busy,
  onGrant,
  onRevoke,
}: {
  granted: Share[];
  received: Share[];
  /** Top-level folders of the caller's own vault, offered as prefixes. */
  dirs: string[];
  busy: boolean;
  onGrant: (grantee: string, prefix: string, canWrite: boolean) => void;
  onRevoke: (share: Share) => void;
}): React.JSX.Element {
  const owners = useOwners();
  const [grantee, setGrantee] = useState('');
  const [prefix, setPrefix] = useState('');
  const [canWrite, setCanWrite] = useState(false);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (grantee.trim() === '' || busy) return;
    onGrant(grantee.trim(), prefix.trim(), canWrite);
    setGrantee('');
    setPrefix('');
    setCanWrite(false);
  };

  return (
    <div className="pane padded">
      <h2 className="h-big">{copy.shares.title}</h2>
      <p className="h-sub">
        {copy.shares.explain}
      </p>

      <section className="shares-block">
        <h3 className="cap">{copy.shares.newShare}</h3>
        <form className="share-form" onSubmit={submit}>
          <label>
            <span>{copy.shares.account}</span>
            <input
              value={grantee}
              onChange={(event) => setGrantee(event.target.value)}
              placeholder={copy.shares.accountPlaceholder}
              aria-label={copy.shares.accountLabel}
              autoComplete="off"
            />
          </label>

          <label>
            <span>{copy.shares.folder}</span>
            <input
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
              placeholder={copy.shares.folderPlaceholder}
              aria-label={copy.shares.folderLabel}
              list="share-dirs"
              autoComplete="off"
            />
            <datalist id="share-dirs">
              {dirs.map((dir) => (
                <option value={dir} key={dir} />
              ))}
            </datalist>
          </label>

          <label className="share-check">
            <input type="checkbox" checked={canWrite} onChange={(event) => setCanWrite(event.target.checked)} />
            <span>{copy.shares.mayWrite}</span>
          </label>

          <button type="submit" className="btn btn-solid" disabled={grantee.trim() === '' || busy}>
            {copy.shares.grant}
          </button>
        </form>

        {/*
          Said before the click, not after. An empty folder field is the one
          input on this screen that quietly means something much larger than it
          looks, and it is a legitimate thing to want.
        */}
        <p className="share-note">
          {prefix.trim() === ''
            ? copy.shares.wholeVaultWarning
            : copy.shares.folderWarning(prefix.trim())}
        </p>
      </section>

      <section className="shares-block">
        <h3 className="cap">{copy.shares.byYou(granted.length)}</h3>
        {granted.length === 0 ? (
          <p className="empty">{copy.shares.nobodySeesYours}</p>
        ) : (
          <ShareTable shares={granted} column={copy.shares.account} nameOf={(share) => share.grantee} busy={busy} onRevoke={onRevoke} verb={copy.shares.withdraw} />
        )}
      </section>

      <section className="shares-block">
        <h3 className="cap">{copy.shares.withYou(received.length)}</h3>
        {received.length === 0 ? (
          <p className="empty">{copy.shares.nobodySharesWithYou}</p>
        ) : (
          // The grantee may end it too. A share you cannot get out of is a folder
          // somebody else can put things in your view forever.
          <ShareTable
            shares={received}
            column={copy.shares.vaultOf}
            nameOf={(share) => ownerLabel(owners, share.owner)}
            busy={busy}
            onRevoke={onRevoke}
            verb={copy.shares.decline}
          />
        )}
      </section>
    </div>
  );
}

function ShareTable({
  shares,
  column,
  nameOf,
  busy,
  verb,
  onRevoke,
}: {
  shares: Share[];
  column: string;
  nameOf: (share: Share) => string;
  busy: boolean;
  verb: string;
  onRevoke: (share: Share) => void;
}): React.JSX.Element {
  return (
    <div className="tablewrap">
      <div className="tablescroll">
        <table>
          <thead>
            <tr>
              <th>{column}</th>
              <th>{copy.shares.what}</th>
              <th>{copy.shares.right}</th>
              <th className="n" />
            </tr>
          </thead>
          <tbody>
            {shares.map((share) => (
              <tr key={share.id}>
                <td className="nm">{nameOf(share)}</td>
                <td className="pth">
                  {/* What the share opens, said three ways at once: an icon, the
                      word, and the path. A note share and a folder share can
                      carry near-identical paths, and only one of them reaches
                      everything underneath. */}
                  <span className="share-kind" data-kind={share.kind}>
                    <ShareKindIcon kind={share.kind} size={14} />
                    <span className="share-kind-word">{copy.shares.kind[share.kind]}</span>
                  </span>
                  {share.kind === 'vault' ? copy.shares.wholeVault : share.prefix}
                </td>
                <td>
                  {/* Neutral either way. Half the rows in a colour would read as
                      a warning about those grants specifically, and this table
                      is a list of facts, not of findings. */}
                  <span className="pill p-tag">{share.canWrite ? copy.shares.readWrite : copy.shares.readOnly}</span>
                </td>
                <td className="n">
                  <button type="button" className="btn" disabled={busy} onClick={() => onRevoke(share)}>
                    {verb}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
