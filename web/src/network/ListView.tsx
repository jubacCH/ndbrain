/**
 * The network as a table: every note in the graph, one row each.
 *
 * Where the graph and the map show shape, this shows facts — the same reason
 * a spreadsheet sits next to a chart. Sortable by any column, filterable by
 * title or tag, opened the same way as everywhere else: click, or focus a row
 * and press Enter.
 *
 * **Paginated, not virtualized, past ~500 rows.** A hand-rolled virtual
 * scroller has to assume a fixed row height to compute which rows are
 * offscreen; this table's rows do not have one (a tag list wraps to a second
 * line as often as not), so a virtualizer here would either measure every row
 * anyway — most of the complexity, none of the benefit — or mismeasure and
 * jump under the cursor. Pagination avoids the assumption entirely, keeps
 * arrow-key navigation inside one small, fully-rendered page, and a few
 * thousand rows split across pages of `PAGE_SIZE` is not a rendering cost
 * jsdom or a fanless laptop needs to be protected from.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { GraphData } from '../api';
import { copy } from '../copy';
import { ownerLabel, useOwners } from '../owners';
import { displayName } from '../Tree';
import { absoluteTime, relativeTime } from './relativeTime';
import './network.css';

type Node = GraphData['nodes'][number];

interface Row {
  key: string;
  owner: string;
  /** What the owner is called on screen: a space's display name, a person's account. */
  ownerLabel: string;
  path: string;
  title: string;
  folder: string;
  folderLabel: string;
  links: number;
  tags: readonly string[];
  updatedAt: number;
}

type SortKey = 'title' | 'owner' | 'folder' | 'links' | 'tags' | 'updatedAt';
type SortDir = 'asc' | 'desc';

interface Column {
  key: SortKey;
  label: string;
  defaultDir: SortDir;
  numeric?: true;
}

const COLUMNS: readonly Column[] = [
  { key: 'title', label: copy.network.list.title, defaultDir: 'asc' },
  { key: 'owner', label: copy.network.list.owner, defaultDir: 'asc' },
  { key: 'folder', label: copy.network.list.folder, defaultDir: 'asc' },
  { key: 'links', label: copy.network.list.links, defaultDir: 'desc', numeric: true },
  { key: 'tags', label: copy.network.list.tags, defaultDir: 'desc' },
  { key: 'updatedAt', label: copy.network.list.updated, defaultDir: 'desc' },
];

/** Rows past this count are paged rather than all rendered at once. */
const VIRTUALIZE_ABOVE = 500;
const PAGE_SIZE = 200;

function folderLabel(folder: string, hidePrefixes: boolean): string {
  if (folder === '') return copy.network.list.root;
  return folder
    .split('/')
    .map((segment) => displayName(segment, hidePrefixes))
    .join(' › ');
}

function compare(a: Row, b: Row, key: SortKey): number {
  switch (key) {
    case 'title':
      return a.title.localeCompare(b.title);
    case 'owner':
      return a.ownerLabel.localeCompare(b.ownerLabel);
    case 'folder':
      return a.folderLabel.localeCompare(b.folderLabel);
    case 'links':
      return a.links - b.links;
    case 'tags':
      return a.tags.length - b.tags.length || a.tags.join(',').localeCompare(b.tags.join(','));
    case 'updatedAt':
      return a.updatedAt - b.updatedAt;
    default:
      return 0;
  }
}

export function ListView(props: {
  graph: GraphData;
  onOpen: (owner: string, path: string) => void;
  /** Show folder names without their sort prefixes, as the tree does. */
  hidePrefixes?: boolean;
}): React.JSX.Element {
  const { graph, onOpen, hidePrefixes = true } = props;
  const owners = useOwners();

  const rows = useMemo<Row[]>(
    () =>
      graph.nodes.map((n: Node) => ({
        // Owner and path together are the unique identity — two owners in a
        // shared vault can otherwise have the exact same path. JSON.stringify
        // of the pair avoids picking a separator character that might, in
        // theory, appear in either string.
        key: JSON.stringify([n.owner, n.path]),
        owner: n.owner,
        ownerLabel: ownerLabel(owners, n.owner),
        path: n.path,
        title: n.title,
        folder: n.folder,
        folderLabel: folderLabel(n.folder, hidePrefixes),
        links: n.links,
        tags: n.tags,
        updatedAt: n.updatedAt,
      })),
    [graph.nodes, hidePrefixes, owners],
  );

  // Whose note a row is only needs saying once there is more than one answer.
  const columns = useMemo(
    () => (new Set(rows.map((r) => r.owner)).size > 1 ? COLUMNS : COLUMNS.filter((c) => c.key !== 'owner')),
    [rows],
  );

  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('updatedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(1);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (q === '') return rows;
    return rows.filter(
      (r) => r.title.toLowerCase().includes(q) || r.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [rows, filter]);

  const sorted = useMemo(() => {
    const copyRows = [...filtered];
    copyRows.sort((a, b) => {
      const base = compare(a, b, sortKey);
      return sortDir === 'asc' ? base : -base;
    });
    return copyRows;
  }, [filtered, sortKey, sortDir]);

  const paginate = sorted.length > VIRTUALIZE_ABOVE;
  const pageCount = paginate ? Math.max(1, Math.ceil(sorted.length / PAGE_SIZE)) : 1;
  const clampedPage = Math.min(page, pageCount);
  const visible = paginate ? sorted.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE) : sorted;

  // Filtering, sorting or paging out from under the current selection would
  // otherwise leave a stale index pointing at a row that is no longer there.
  useEffect(() => {
    setFocusedIndex((i) => Math.min(i, Math.max(0, visible.length - 1)));
  }, [visible.length]);
  useEffect(() => {
    setPage(1);
  }, [filter, sortKey, sortDir]);
  // The graph can shrink under the pager (a refetch, notes deleted elsewhere).
  // The stored page is pulled back with it, or "previous" would step down from
  // a page that no longer exists and seem to do nothing.
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const setSort = (key: SortKey): void => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      const col = COLUMNS.find((c) => c.key === key);
      setSortDir(col?.defaultDir ?? 'asc');
    }
  };

  const openRow = (row: Row): void => onOpen(row.owner, row.path);

  const onRowKeyDown = (event: React.KeyboardEvent<HTMLTableRowElement>, index: number): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = Math.min(index + 1, visible.length - 1);
      setFocusedIndex(next);
      rowRefs.current.get(next)?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const prev = Math.max(index - 1, 0);
      setFocusedIndex(prev);
      rowRefs.current.get(prev)?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const row = visible[index];
      if (row) openRow(row);
    }
  };

  if (rows.length === 0) {
    return (
      <div className="network-view list-view">
        <p className="nv-empty">{copy.network.list.emptyVault}</p>
      </div>
    );
  }

  return (
    <div className="network-view list-view">
      <div className="nv-toolbar">
        <input
          type="text"
          className="nv-filter"
          placeholder={copy.network.list.filterPlaceholder}
          aria-label={copy.network.list.filterLabel}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="nv-count">{copy.network.list.resultCount(sorted.length, rows.length)}</span>
      </div>

      {sorted.length === 0 ? (
        <p className="nv-empty">{copy.network.list.empty}</p>
      ) : (
        <>
          <div className="nv-tablewrap">
            <table className="nv-table">
              <thead>
                <tr>
                  {columns.map((col) => {
                    const active = col.key === sortKey;
                    const ariaSort = active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
                    return (
                      <th key={col.key} scope="col" aria-sort={ariaSort} className={col.numeric ? 'n' : undefined}>
                        <button
                          type="button"
                          onClick={() => setSort(col.key)}
                          aria-label={
                            active
                              ? sortDir === 'asc'
                                ? copy.network.list.sortAscending(col.label)
                                : copy.network.list.sortDescending(col.label)
                              : col.label
                          }
                        >
                          {col.label}
                          {active && <span className="nv-sort-arrow" aria-hidden>{sortDir === 'asc' ? '▲' : '▼'}</span>}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {visible.map((row, index) => (
                  <tr
                    key={row.key}
                    ref={(el) => {
                      if (el) rowRefs.current.set(index, el);
                      else rowRefs.current.delete(index);
                    }}
                    className="nv-row"
                    tabIndex={index === focusedIndex ? 0 : -1}
                    onFocus={() => setFocusedIndex(index)}
                    onKeyDown={(e) => onRowKeyDown(e, index)}
                    onClick={() => openRow(row)}
                  >
                    <td className="nv-title">{row.title}</td>
                    {columns.some((c) => c.key === 'owner') && <td className="nv-owner">{row.ownerLabel}</td>}
                    <td className="nv-folder">{row.folderLabel}</td>
                    <td className="nv-num">{row.links}</td>
                    <td>
                      <span className="nv-tags">
                        {row.tags.length === 0
                          ? copy.network.list.noTags
                          : row.tags.map((t) => (
                              <span key={t} className="nv-tag">
                                {t}
                              </span>
                            ))}
                      </span>
                    </td>
                    <td className="nv-time" title={absoluteTime(row.updatedAt)}>
                      {relativeTime(row.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {paginate && (
            <nav className="nv-pager" aria-label={copy.network.list.pageOf(clampedPage, pageCount)}>
              <button type="button" disabled={clampedPage <= 1} onClick={() => setPage(clampedPage - 1)}>
                {copy.network.list.prevPage}
              </button>
              <span>{copy.network.list.pageOf(clampedPage, pageCount)}</span>
              <button type="button" disabled={clampedPage >= pageCount} onClick={() => setPage(clampedPage + 1)}>
                {copy.network.list.nextPage}
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
