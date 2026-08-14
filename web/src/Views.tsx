/**
 * The librarian surfaces: overview, tidy-up and search results.
 *
 * Denser than the writing surface and monospaced wherever data appears — paths,
 * counts, tags. Two registers in one application, told apart by typography
 * rather than by colour.
 */

import { useState } from 'react';

import { refKey, type LinkRow, type NoteRow, type Overview, type SearchHit, type Share, type TaskRow, type Tidy } from './api';

const RELATIVE = new Intl.RelativeTimeFormat('de', { numeric: 'auto' });

export function ago(mtimeMs: number, now = Date.now()): string {
  const minutes = Math.round((mtimeMs - now) / 60_000);
  if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return RELATIVE.format(hours, 'hour');
  return RELATIVE.format(Math.round(hours / 24), 'day');
}

/**
 * The overview, as a bento grid.
 *
 * The unequal tile sizes are the point and also the justification: findings are
 * what this product is for, so that tile is the largest; tags are a lookup aid,
 * so theirs is the smallest. A bento whose tiles are all the same importance is
 * just a grid with extra steps.
 *
 * It stops here. The editor needs a continuous column, the tree is a hierarchy,
 * and the tidy table lives on aligned columns — tiling those would trade the
 * tool for a shop window.
 */
export function OverviewView({
  data,
  onOpen,
}: {
  data: Overview;
  onOpen: (owner: string, path: string) => void;
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

      <div className="bento">
        <section className="tile tile-wide">
          <p className="cap">Braucht Aufmerksamkeit</p>
          {attention === 0 ? (
            <p className="empty">Nichts offen — der Vault ist sauber.</p>
          ) : (
            <div className="findings">
              <Finding label="verwaist" kind="crit" count={counts.orphans} />
              <Finding label="ins Leere" kind="crit" count={counts.deadLinks} />
              <Finding label="ungetaggt" kind="warn" count={counts.untagged} />
              <Finding label="still" kind="warn" count={counts.stale} />
            </div>
          )}
        </section>

        <section className="tile">
          <p className="cap">Seit gestern</p>
          <div className="list">
            {data.activity.length === 0 && <p className="empty">Nichts passiert.</p>}
            {data.activity.slice(0, 8).map((row) => (
              <button
                type="button"
                className="item"
                key={refKey(row.owner, row.path)}
                disabled={row.deleted}
                onClick={() => !row.deleted && onOpen(row.owner, row.path)}
              >
                {/* The actor only earns a badge when it is not you — otherwise
                    every row would carry the same label and say nothing. */}
                {row.actor !== '' && row.action === 'delete' && <span className="pill p-crit">gelöscht</span>}
                <span className="t" style={row.deleted ? { textDecoration: 'line-through' } : undefined}>
                  {row.title}
                </span>
                <span className="r">
                  {row.edits > 1 && `${row.edits}× · `}
                  {ago(row.at)}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="tile">
          <p className="cap">Offene Aufgaben</p>
          <div className="list">
            {data.tasks.length === 0 && <p className="empty">Keine offenen Aufgaben.</p>}
            {data.tasks.slice(0, 8).map((task: TaskRow) => (
              <button
                type="button"
                className="item"
                key={`${refKey(task.owner, task.path)}:${task.line}`}
                onClick={() => onOpen(task.owner, task.path)}
              >
                <span className="t">{task.text}</span>
                <span className="r">{task.path.split('/').slice(0, -1).join('/') || '—'}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="tile">
          <p className="cap">Zuletzt bearbeitet</p>
          <div className="list">
            {data.recent.length === 0 && <p className="empty">Noch nichts.</p>}
            {data.recent.slice(0, 8).map((note) => (
              <button
                type="button"
                className="item"
                key={refKey(note.owner, note.path)}
                onClick={() => onOpen(note.owner, note.path)}
              >
                <span className="t">{note.title}</span>
                <span className="r">{ago(note.mtimeMs)}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="tile tile-short">
          <p className="cap">Tags</p>
          <div className="tagcloud">
            {data.tags.length === 0 && <p className="empty">Noch keine Tags.</p>}
            {data.tags.slice(0, 14).map((tag) => (
              <span className="pill p-tag" key={tag.tag}>
                #{tag.tag} <span style={{ opacity: 0.6 }}>{tag.count}</span>
              </span>
            ))}
          </div>
        </section>
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
    <div className="finding" data-empty={count === 0}>
      <span className="finding-n">{count}</span>
      <span className={`pill p-${kind}`}>{label}</span>
    </div>
  );
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
  onOpen,
  onBulk,
  busy,
  tags,
  dirs,
}: {
  data: Tidy;
  selected: Set<string>;
  onToggle: (path: string) => void;
  onToggleAll: (paths: string[]) => void;
  onOpen: (path: string) => void;
  onBulk: (action: 'move' | 'tag' | 'delete') => void;
  busy: boolean;
  tags: Array<{ tag: string; count: number }>;
  dirs: string[];
}): React.JSX.Element {
  type Row = { path: string; title: string; finding: string; kind: 'crit' | 'warn'; when: string };

  void tags;
  void dirs;

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
        <>
          {/*
            The action bar sits above the table and stays visible, so the number
            of selected notes is in view while choosing what to do to them.
          */}
          <div className="bulkbar" data-active={selected.size > 0}>
            <span className="bulkcount">
              {selected.size === 0 ? 'Nichts ausgewählt' : `${selected.size} ausgewählt`}
            </span>
            <button type="button" className="btn" disabled={selected.size === 0 || busy} onClick={() => onBulk('move')}>
              Verschieben…
            </button>
            <button type="button" className="btn" disabled={selected.size === 0 || busy} onClick={() => onBulk('tag')}>
              Taggen…
            </button>
            <button
              type="button"
              className="btn btn-solid"
              disabled={selected.size === 0 || busy}
              onClick={() => onBulk('delete')}
            >
              Löschen…
            </button>
            <span className="bulkhint">Verweise ziehen beim Verschieben mit</span>
          </div>

          <div className="tablewrap">
            <div className="tablescroll">
              <table>
                <thead>
                  <tr>
                    <th className="pick">
                      <input
                        type="checkbox"
                        aria-label="Alle auswählen"
                        checked={selected.size > 0 && selected.size === new Set(rows.map((r) => r.path)).size}
                        onChange={() => onToggleAll([...new Set(rows.map((r) => r.path))])}
                      />
                    </th>
                    <th>Notiz</th>
                    <th>Pfad</th>
                    <th>Befund</th>
                    <th className="n">Zuletzt</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
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
                          aria-label={`${row.title} auswählen`}
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
        </>
      )}
    </div>
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
}): React.JSX.Element {
  const active =
    filters.tag !== undefined ||
    filters.dir !== undefined ||
    filters.days !== undefined ||
    filters.prop !== undefined;

  const describe = (): string => {
    const parts: string[] = [];
    if (query.trim() !== '') parts.push(`„${query.trim()}"`);
    if (filters.tag !== undefined) parts.push(`#${filters.tag}`);
    if (filters.dir !== undefined) parts.push(`in ${filters.dir}`);
    if (filters.days !== undefined) parts.push(`aus ${filters.days} Tagen`);
    if (filters.prop !== undefined) {
      parts.push(filters.propValue === undefined ? `mit ${filters.prop}` : `${filters.prop}: ${filters.propValue}`);
    }
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

        {/*
          The vault's own vocabulary, read out of the frontmatter rather than
          prescribed. Picking a key shows its values, so the second click is
          "status: aktiv" instead of a text field somebody has to guess into.
        */}
        {props.length > 0 && <span className="filter-label">Eigenschaft</span>}
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

        {propValues.length > 0 && <span className="filter-label">{filters.prop} ist</span>}
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
            {hit.owner !== self && <span className="pill p-info">{hit.owner}</span>}
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
      <h2 className="h-big">Freigaben</h2>
      <p className="h-sub">
        Jeder Vault gehört einer Person. Eine Freigabe öffnet einen Ordner daraus — und nur den.
      </p>

      <section className="shares-block">
        <h3 className="cap">Neu freigeben</h3>
        <form className="share-form" onSubmit={submit}>
          <label>
            <span>Konto</span>
            <input
              value={grantee}
              onChange={(event) => setGrantee(event.target.value)}
              placeholder="benutzername"
              aria-label="Konto, für das freigegeben wird"
              autoComplete="off"
            />
          </label>

          <label>
            <span>Ordner</span>
            <input
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
              placeholder="leer = ganzer Vault"
              aria-label="Ordner, der freigegeben wird"
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
            <span>darf auch schreiben</span>
          </label>

          <button type="submit" className="btn btn-solid" disabled={grantee.trim() === '' || busy}>
            Freigeben
          </button>
        </form>

        {/*
          Said before the click, not after. An empty folder field is the one
          input on this screen that quietly means something much larger than it
          looks, and it is a legitimate thing to want.
        */}
        <p className="share-note">
          {prefix.trim() === ''
            ? 'Ohne Ordner wird der ganze Vault freigegeben — inklusive allem, was später dazukommt.'
            : `Freigegeben wird „${prefix.trim()}" mit allen Unterordnern.`}
        </p>
      </section>

      <section className="shares-block">
        <h3 className="cap">Von dir freigegeben · {granted.length}</h3>
        {granted.length === 0 ? (
          <p className="empty">Niemand sieht in deinen Vault.</p>
        ) : (
          <ShareTable shares={granted} column="Konto" nameOf={(share) => share.grantee} busy={busy} onRevoke={onRevoke} verb="Zurückziehen" />
        )}
      </section>

      <section className="shares-block">
        <h3 className="cap">Mit dir geteilt · {received.length}</h3>
        {received.length === 0 ? (
          <p className="empty">Niemand teilt etwas mit dir.</p>
        ) : (
          // The grantee may end it too. A share you cannot get out of is a folder
          // somebody else can put things in your view forever.
          <ShareTable shares={received} column="Vault von" nameOf={(share) => share.owner} busy={busy} onRevoke={onRevoke} verb="Ablehnen" />
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
              <th>Ordner</th>
              <th>Recht</th>
              <th className="n" />
            </tr>
          </thead>
          <tbody>
            {shares.map((share) => (
              <tr key={share.id}>
                <td className="nm">{nameOf(share)}</td>
                <td className="pth">{share.prefix === '' ? 'ganzer Vault' : share.prefix}</td>
                <td>
                  {/* Neutral either way. Half the rows in a colour would read as
                      a warning about those grants specifically, and this table
                      is a list of facts, not of findings. */}
                  <span className="pill p-tag">{share.canWrite ? 'lesen + schreiben' : 'nur lesen'}</span>
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
