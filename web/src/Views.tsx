/**
 * The librarian surfaces: overview, tidy-up and search results.
 *
 * Denser than the writing surface and monospaced wherever data appears — paths,
 * counts, tags. Two registers in one application, told apart by typography
 * rather than by colour.
 */

import type { LinkRow, NoteRow, Overview, SearchHit, TaskRow, Tidy } from './api';

const RELATIVE = new Intl.RelativeTimeFormat('de', { numeric: 'auto' });

export function ago(mtimeMs: number, now = Date.now()): string {
  const minutes = Math.round((mtimeMs - now) / 60_000);
  if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return RELATIVE.format(hours, 'hour');
  return RELATIVE.format(Math.round(hours / 24), 'day');
}

export function OverviewView({
  data,
  onOpen,
}: {
  data: Overview;
  onOpen: (path: string) => void;
}): React.JSX.Element {
  const { counts } = data;
  const attention = counts.orphans + counts.untagged + counts.deadLinks + counts.stale;

  return (
    <div className="pane padded">
      <h2 className="h-big">Übersicht</h2>
      <p className="h-sub">
        {counts.notes} {counts.notes === 1 ? 'Notiz' : 'Notizen'} ·{' '}
        {attention === 0 ? 'nichts zu tun' : `${attention} brauchen Aufmerksamkeit`}
      </p>

      <div className="grid2">
        <div>
          <p className="cap">Zuletzt bearbeitet</p>
          <div className="list">
            {data.recent.length === 0 && <p className="empty">Noch nichts.</p>}
            {data.recent.map((note) => (
              <button type="button" className="item" key={note.path} onClick={() => onOpen(note.path)}>
                <span className="t">{note.title}</span>
                <span className="r">{ago(note.mtimeMs)}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="cap">Braucht Aufmerksamkeit</p>
          <div className="list">
            <Finding label="verwaist" kind="crit" count={counts.orphans} />
            <Finding label="ins Leere" kind="crit" count={counts.deadLinks} />
            <Finding label="ungetaggt" kind="warn" count={counts.untagged} />
            <Finding label="still" kind="warn" count={counts.stale} />
          </div>
        </div>

        <div>
          <p className="cap">Offene Aufgaben</p>
          <div className="list">
            {data.tasks.length === 0 && <p className="empty">Keine offenen Aufgaben.</p>}
            {data.tasks.slice(0, 12).map((task: TaskRow) => (
              <button
                type="button"
                className="item"
                key={`${task.path}:${task.line}`}
                onClick={() => onOpen(task.path)}
              >
                <span className="t">{task.text}</span>
                <span className="r">{task.path.split('/').slice(0, -1).join('/') || '—'}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="cap">Tags</p>
          <div className="list">
            {data.tags.length === 0 && <p className="empty">Noch keine Tags.</p>}
            {data.tags.slice(0, 12).map((tag) => (
              <div className="item" key={tag.tag}>
                <span className="pill p-tag">#{tag.tag}</span>
                <span className="r">{tag.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Finding({
  label,
  kind,
  count,
}: {
  label: string;
  kind: 'crit' | 'warn';
  count: number;
}): React.JSX.Element {
  return (
    <div className="item">
      <span className={`pill p-${kind}`}>{label}</span>
      <span className="t">{count === 0 ? 'nichts' : count}</span>
    </div>
  );
}

export function TidyView({
  data,
  onOpen,
}: {
  data: Tidy;
  onOpen: (path: string) => void;
}): React.JSX.Element {
  type Row = { path: string; title: string; finding: string; kind: 'crit' | 'warn'; when: string };

  const rows: Row[] = [
    ...data.orphans.map((n: NoteRow) => ({
      path: n.path,
      title: n.title,
      finding: 'verwaist',
      kind: 'crit' as const,
      when: ago(n.mtimeMs),
    })),
    ...data.deadLinks.map((l: LinkRow) => ({
      path: l.source,
      title: l.targetRaw,
      finding: 'ins Leere',
      kind: 'crit' as const,
      when: '—',
    })),
    ...data.untagged.map((n: NoteRow) => ({
      path: n.path,
      title: n.title,
      finding: 'ungetaggt',
      kind: 'warn' as const,
      when: ago(n.mtimeMs),
    })),
    ...data.stale.map((n: NoteRow) => ({
      path: n.path,
      title: n.title,
      finding: 'still',
      kind: 'warn' as const,
      when: ago(n.mtimeMs),
    })),
  ];

  return (
    <div className="pane padded">
      <h2 className="h-big">Aufräumen</h2>
      <p className="h-sub">
        {rows.length === 0
          ? 'Nichts zu tun — der Vault ist sauber.'
          : `${rows.length} Befunde · struktur-unabhängig, gilt für jeden Ordner`}
      </p>

      {rows.length > 0 && (
        <div className="tablewrap">
          <div className="tablescroll">
            <table>
              <thead>
                <tr>
                  <th>Notiz</th>
                  <th>Pfad</th>
                  <th>Befund</th>
                  <th className="n">Zuletzt</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${row.finding}:${row.path}:${index}`} onClick={() => onOpen(row.path)}>
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
    </div>
  );
}

export interface SearchFilters {
  tag?: string;
  dir?: string;
  days?: number;
}

export function SearchView({
  query,
  hits,
  filters,
  tags,
  dirs,
  onToggleFilter,
  onClearFilters,
  onOpen,
}: {
  query: string;
  hits: SearchHit[];
  filters: SearchFilters;
  tags: Array<{ tag: string; count: number }>;
  dirs: string[];
  onToggleFilter: (patch: SearchFilters) => void;
  onClearFilters: () => void;
  onOpen: (path: string) => void;
}): React.JSX.Element {
  const active = filters.tag !== undefined || filters.dir !== undefined || filters.days !== undefined;

  const describe = (): string => {
    const parts: string[] = [];
    if (query.trim() !== '') parts.push(`„${query.trim()}"`);
    if (filters.tag !== undefined) parts.push(`#${filters.tag}`);
    if (filters.dir !== undefined) parts.push(`in ${filters.dir}`);
    if (filters.days !== undefined) parts.push(`aus ${filters.days} Tagen`);
    return parts.join(' · ');
  };

  return (
    <div className="pane padded">
      <h2 className="h-big">Suche</h2>
      <p className="h-sub">
        {hits.length === 0 ? 'Nichts gefunden' : `${hits.length} Treffer`}
        {describe() !== '' && ` — ${describe()}`}
      </p>

      <div className="filters">
        <span className="filter-label">Zeitraum</span>
        {[7, 30, 90].map((days) => (
          <button
            type="button"
            key={days}
            className="filter"
            aria-pressed={filters.days === days}
            onClick={() => onToggleFilter({ days })}
          >
            {days} Tage
          </button>
        ))}

        {dirs.length > 0 && <span className="filter-label">Ordner</span>}
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

        {tags.length > 0 && <span className="filter-label">Tag</span>}
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
            zurücksetzen
          </button>
        )}
      </div>

      {hits.map((hit) => (
        <button type="button" className="hit" key={hit.path} onClick={() => onOpen(hit.path)}>
          <span className="title">{hit.title}</span>
          <span className="path">{hit.path}</span>
          {hit.snippet !== '' && <span className="snip">{hit.snippet}</span>}
        </button>
      ))}
    </div>
  );
}
