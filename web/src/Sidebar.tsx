/**
 * The sidebar: where you are in the vault, and the way to everywhere else.
 *
 * Top to bottom it answers questions in the order they come up. Who and what
 * this is. Which view. Where is the note I am thinking of — by name, among the
 * ones I just had open, or in its folder. And, at the foot, how the vault is
 * doing: the orphaned, untagged and broken counts as coloured points, a door
 * into the tidy view each.
 *
 * It folds down to its icons. Folded, every control keeps its name — as its
 * accessible name, which a screen reader reads, and as a tooltip, which a mouse
 * finds — so nothing that was reachable open becomes a guessing game closed.
 * The recents and the tree have no icon form and step aside; unfolding is one
 * click, and ⌘K reaches any note from either state.
 *
 * On a phone the sidebar is a drawer instead, and folding does not apply: the
 * drawer is already out of the way until it is asked for.
 */

import { useRef, type ReactNode } from 'react';

import { refKey, type NoteRow } from './api';
import { copy } from './copy';
import {
  BrainIcon,
  CalendarIcon,
  CloseIcon,
  CollapseIcon,
  FileIcon,
  GearIcon,
  HomeIcon,
  NetworkIcon,
  NewFolderIcon,
  NewNoteIcon,
  SearchIcon,
  SparkleIcon,
  TodayIcon,
} from './icons';

/** The views the sidebar navigates between. */
export type NavView = 'overview' | 'journal' | 'brain' | 'tidy' | 'search' | 'files';

/**
 * Files is not among them: attachments are looked after now and then, not
 * reached for all day, so it sits in the account menu under Settings. Nor are
 * tasks: they sit beside the calendar in the journal.
 */
const ENTRIES: Array<{ view: NavView; label: string; icon: ReactNode }> = [
  { view: 'overview', label: copy.nav.overview, icon: <HomeIcon /> },
  { view: 'journal', label: copy.nav.journal, icon: <CalendarIcon /> },
  { view: 'brain', label: copy.nav.network, icon: <NetworkIcon /> },
  { view: 'tidy', label: copy.nav.tidy, icon: <SparkleIcon /> },
  { view: 'search', label: copy.nav.search, icon: <SearchIcon /> },
];

export interface Health {
  orphans: number;
  /** Null where nothing in the vault is tagged, which makes the count meaningless. */
  untagged: number | null;
  broken: number;
}

export interface SidebarProps {
  name: string;
  /** The view on screen; `note` and the account pages match no entry. */
  view: string;
  /** A view that was asked for and is still loading; its entry says so. */
  arriving?: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onShowView: (view: NavView) => void;
  /** Closes the drawer on a phone. */
  onClose: () => void;
  filter: string;
  onFilter: (value: string) => void;
  /** Opens the ⌘K palette. */
  onJump: () => void;
  recents: NoteRow[];
  /** The note on screen, marked in the recents list. */
  current: { owner: string; path: string } | null;
  onOpen: (owner: string, path: string) => void;
  /** The folder tree, rendered by the shell, which owns its state. */
  tree: ReactNode;
  health: Health | null;
  onHealth: () => void;
  onNewNote: () => void;
  onNewFolder: () => void;
  onSettings: () => void;
  /** Opens today's daily note, creating it if needed. */
  onToday: () => void;
  /** Whether the note on screen is today's daily note. */
  onTodayNote: boolean;
}

export function Sidebar({
  name,
  view,
  arriving = null,
  collapsed,
  onToggleCollapsed,
  onShowView,
  onClose,
  filter,
  onFilter,
  onJump,
  recents,
  current,
  onOpen,
  tree,
  health,
  onHealth,
  onNewNote,
  onNewFolder,
  onSettings,
  onToday,
  onTodayNote,
}: SidebarProps): React.JSX.Element {
  const filterInput = useRef<HTMLInputElement>(null);

  /** Folded, the filter is a button that unfolds the sidebar and puts the caret in it. */
  const openFilter = (): void => {
    onToggleCollapsed();
    window.setTimeout(() => filterInput.current?.focus(), 0);
  };

  return (
    <nav className="nav" aria-label={copy.nav.label} data-collapsed={collapsed}>
      {/*
        Everything at once rather than one thing at a time. Tabs are a mode
        switch: they hide most of the tool behind a click. Something that stays
        open all day would rather show it all — on the left where, in the middle
        what, on the right what it connects to.
      */}
      <div className="nav-head">
        <span className="nav-logo" aria-hidden="true">
          <BrainIcon size={30} />
        </span>
        <span className="nav-brand">
          <span className="nav-who">{name}</span>
          <span className="nav-tagline">{copy.nav.tagline}</span>
        </span>
        <button
          type="button"
          className="iconbtn nav-fold"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? copy.nav.expand : copy.nav.collapse}
          title={collapsed ? copy.nav.expand : copy.nav.collapse}
          aria-expanded={!collapsed}
        >
          <CollapseIcon size={16} />
        </button>
        <button type="button" className="iconbtn nav-x" onClick={onClose} aria-label={copy.nav.closeMenu}>
          <CloseIcon size={16} />
        </button>
      </div>

      {/*
        No "Write" entry. Opening a note from the tree, the recents, the
        palette or a search hit already switches to it, so the button only ever
        did one thing nothing else did: show an empty pane telling you to pick
        a note. The way back to a note you stepped away from is the recents
        list below.
      */}
      {/*
        Today's note is an action, not a view: it opens (and if need be starts)
        one note. So it stands above the views rather than among them, and
        stays a single click in the folded sidebar too.
      */}
      <div className="nav-views nav-today">
        <button
          type="button"
          aria-current={onTodayNote}
          title={collapsed ? `${copy.nav.todayHint} (${copy.journal.shortcut})` : copy.nav.todayHint}
          aria-label={copy.nav.todayHint}
          aria-keyshortcuts="Meta+Shift+D Control+Shift+D"
          onClick={onToday}
        >
          <TodayIcon />
          <span className="nav-label">{copy.nav.today}</span>
          <kbd className="nav-label nav-today-kbd" aria-hidden="true">
            {copy.journal.shortcut}
          </kbd>
        </button>
      </div>

      <div className="nav-views" role="group" aria-label={copy.nav.view}>
        {ENTRIES.map((entry) => (
          <button
            key={entry.view}
            type="button"
            aria-current={view === entry.view}
            aria-busy={arriving === entry.view && view !== entry.view ? true : undefined}
            title={collapsed ? entry.label : undefined}
            onClick={() => onShowView(entry.view)}
          >
            {entry.icon}
            <span className="nav-label">{entry.label}</span>
          </button>
        ))}
      </div>

      {/*
        Filtering the tree, not searching the text — this only ever looks at
        names, answers on every keystroke, and never leaves the sidebar. Full
        text search is its own view, and ⌘K is for jumping. Three ways to find
        something sounds like two too many, but they answer different
        questions: where is it filed, where have I read this word, and take me
        to the one I am already thinking of.
      */}
      {collapsed ? (
        <div className="nav-find nav-find-folded">
          <button
            type="button"
            className="iconbtn"
            onClick={openFilter}
            aria-label={copy.nav.filterShortcut}
            title={copy.nav.filterShortcut}
          >
            <SearchIcon size={17} />
          </button>
        </div>
      ) : (
        <div className="nav-find">
          <SearchIcon size={15} className="nav-find-icon" />
          <input
            ref={filterInput}
            type="search"
            value={filter}
            placeholder={copy.nav.filterPlaceholder}
            aria-label={copy.nav.filterLabel}
            onChange={(event) => onFilter(event.target.value)}
          />
          {filter !== '' ? (
            <button type="button" onClick={() => onFilter('')} aria-label={copy.nav.clearFilter}>
              <CloseIcon size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="nav-kbd"
              onClick={onJump}
              aria-label={copy.shell.searchLabel}
              title={copy.shell.searchLabel}
              aria-keyshortcuts="Meta+K Control+K"
            >
              <kbd>⌘ K</kbd>
            </button>
          )}
        </div>
      )}

      {!collapsed && (
        <div className="nav-scroll">
          {/* Return traffic, not discovery — hidden while filtering, when the
              answer on screen is the one you just typed for. */}
          {filter === '' && recents.length > 0 && (
            <div className="nav-recent">
              <p className="cap">{copy.nav.recent}</p>
              <ul>
                {recents.map((note) => {
                  const here =
                    current !== null && current.owner === note.owner && current.path === note.path;
                  return (
                    <li key={refKey(note.owner, note.path)}>
                      <button
                        type="button"
                        className="node"
                        aria-current={here}
                        onClick={() => onOpen(note.owner, note.path)}
                      >
                        <FileIcon size={15} className="node-icon" />
                        <span className="nm">{note.title}</span>
                        {here && (
                          <span className="node-dot" role="img" aria-label={copy.nav.openNow} />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="nav-tree">{tree}</div>
        </div>
      )}
      {collapsed && <div className="nav-spacer" />}

      <div className="nav-foot">
        {health !== null && (
          <div className="nav-health">
            <HealthDot
              kind="crit"
              label={copy.nav.orphaned}
              count={health.orphans}
              full={copy.nav.orphanedCount(health.orphans)}
              collapsed={collapsed}
              onClick={onHealth}
            />
            {/* Withheld while nothing is tagged — see Queries.tagsInUse. */}
            {health.untagged !== null && (
              <HealthDot
                kind="warn"
                label={copy.nav.untagged}
                count={health.untagged}
                full={copy.nav.untaggedCount(health.untagged)}
                collapsed={collapsed}
                onClick={onHealth}
              />
            )}
            <HealthDot
              kind="crit"
              label={copy.nav.broken}
              count={health.broken}
              full={copy.nav.brokenCount(health.broken)}
              collapsed={collapsed}
              onClick={onHealth}
            />
          </div>
        )}

        {/*
          The create actions and the settings. Icons because the row is theirs
          alone; each still carries its name twice over — aria-label for a
          screen reader, title on hover — since both of those are invisible
          and both are needed.
        */}
        <div className="nav-make">
          <button
            type="button"
            className="iconbtn"
            aria-label={copy.nav.newNote}
            title={copy.nav.newNote}
            onClick={onNewNote}
          >
            <NewNoteIcon />
          </button>
          <button
            type="button"
            className="iconbtn"
            aria-label={copy.nav.newFolder}
            title={copy.nav.newFolder}
            onClick={onNewFolder}
          >
            <NewFolderIcon />
          </button>
          <button
            type="button"
            className="iconbtn nav-gear"
            aria-label={copy.nav.settings}
            title={copy.nav.settings}
            aria-current={view === 'settings'}
            onClick={onSettings}
          >
            <GearIcon />
          </button>
        </div>
      </div>
    </nav>
  );
}

function HealthDot({
  kind,
  label,
  count,
  full,
  collapsed,
  onClick,
}: {
  kind: 'crit' | 'warn';
  label: string;
  count: number;
  full: string;
  collapsed: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={full}
      aria-label={full}
      data-zero={count === 0}
    >
      <i className={`dot dot-${kind}`} />
      {!collapsed && (
        <>
          <span className="nav-health-label">{label}</span> <b>{count}</b>
        </>
      )}
    </button>
  );
}
