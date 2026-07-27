/**
 * The application shell: tree on the left, one of three views on the right.
 *
 * Saving is the part worth reading carefully. The editor holds the text, a
 * debounce turns a burst of typing into one write, and the header shows the real
 * state of that write at all times. With data that lives only on the server, a
 * silent save is not trustworthy — you have to be able to see that it arrived.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, api, type Note, type NoteRow, type Overview, type SearchHit, type Tidy, type User } from './api';
import { ContextPanel } from './Context';
import { Editor } from './Editor';
import { Login } from './Login';
import { Palette } from './Palette';
import { Tree, type Finding } from './Tree';
import { OverviewView, SearchView, TidyView } from './Views';

export interface Filters {
  tag?: string;
  dir?: string;
  days?: number;
}

type View = 'note' | 'overview' | 'tidy' | 'search';
type SaveState = 'saved' | 'dirty' | 'saving' | 'failed';

const SAVE_DEBOUNCE_MS = 500;

export function App(): React.JSX.Element {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api
      .me()
      .then(({ user: me }) => setUser(me))
      .catch(() => setUser(null))
      .finally(() => setReady(true));
  }, []);

  if (!ready) return <div className="login" />;
  if (user === null) return <Login onSignedIn={setUser} />;
  return <Shell user={user} onSignedOut={() => setUser(null)} />;
}

function Shell({ user, onSignedOut }: { user: User; onSignedOut: () => void }): React.JSX.Element {
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [findings, setFindings] = useState<Map<string, Finding>>(new Map());
  const [view, setView] = useState<View>('overview');
  const [note, setNote] = useState<Note | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [tidy, setTidy] = useState<Tidy | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Filters>({});
  const [tags, setTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(true);
  // Bumped after every successful save so the context panel re-reads the links.
  const [linksVersion, setLinksVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [mobileTree, setMobileTree] = useState(false);

  const saveTimer = useRef<number | null>(null);
  const pending = useRef<{ path: string; content: string } | null>(null);

  const refreshTree = useCallback(async (): Promise<void> => {
    const [tree, tidyData] = await Promise.all([api.tree(), api.tidy()]);
    setNotes(tree.notes);
    setTidy(tidyData);

    // The tree's state markers come from the same findings the tidy view lists,
    // so the two can never disagree.
    const map = new Map<string, Finding>();
    for (const row of tidyData.untagged) map.set(row.path, 'warn');
    for (const row of tidyData.stale) map.set(row.path, 'warn');
    for (const row of tidyData.orphans) map.set(row.path, 'crit');
    for (const row of tidyData.deadLinks) map.set(row.source, 'crit');
    setFindings(map);
  }, []);

  const refreshOverview = useCallback(async (): Promise<void> => {
    setOverview(await api.overview());
  }, []);

  useEffect(() => {
    void refreshTree().catch(() => setError('Der Server antwortet gerade nicht.'));
    void refreshOverview().catch(() => undefined);
  }, [refreshTree, refreshOverview]);

  /** Writes whatever is pending right now. */
  const flush = useCallback(async (): Promise<void> => {
    const outstanding = pending.current;
    if (outstanding === null) return;
    pending.current = null;
    setSaveState('saving');

    try {
      await api.putNote(outstanding.path, outstanding.content);
      setSaveState(pending.current === null ? 'saved' : 'dirty');
      // Links may have appeared or broken with this edit, so the panel and the
      // tree markers are re-read rather than left showing the previous state.
      setLinksVersion((version) => version + 1);
      void refreshTree();
    } catch (caught) {
      setSaveState('failed');
      setError(
        caught instanceof ApiError ? caught.message : 'Speichern fehlgeschlagen. Text bleibt im Editor.',
      );
    }
  }, [refreshTree]);

  const scheduleSave = useCallback(
    (path: string, content: string): void => {
      pending.current = { path, content };
      setSaveState('dirty');
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  // A closing tab must not take the last sentence with it.
  useEffect(() => {
    const onHide = (): void => {
      if (pending.current !== null) void flush();
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [flush]);

  const openNote = useCallback(
    async (path: string): Promise<void> => {
      // Never switch away from unsaved text without writing it first.
      if (pending.current !== null) await flush();

      try {
        const { note: opened } = await api.getNote(path);
        setNote(opened);
        setView('note');
        setSaveState('saved');
        setMobileTree(false);
        setError(null);
      } catch {
        setError('Diese Notiz gibt es nicht mehr.');
        void refreshTree();
      }
    },
    [flush, refreshTree],
  );

  const createNoteAt = useCallback(
    async (rawName: string): Promise<void> => {
      const name = rawName.trim();
      if (name === '') return;

      const path = name.endsWith('.md') ? name : `${name}.md`;
      const title = path.split('/').pop()?.replace(/\.md$/i, '') ?? '';

      try {
        await api.putNote(path, `# ${title}\n\n`);
        await refreshTree();
        await openNote(path);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'Anlegen fehlgeschlagen.');
      }
    },
    [openNote, refreshTree],
  );

  const createNote = async (): Promise<void> => {
    const name = window.prompt('Name der neuen Notiz (Ordner mit / möglich)');
    if (name === null) return;
    await createNoteAt(name);
  };

  /**
   * Creates the note a dead link points at, next to the note that links to it.
   *
   * Putting it in the same folder is the guess that is right most of the time and
   * cheap to undo — the alternative is another dialogue at the moment somebody
   * just wanted the gap filled.
   */
  const createFromDeadLink = async (target: string): Promise<void> => {
    const folder = note?.path.split('/').slice(0, -1).join('/') ?? '';
    await createNoteAt(folder === '' ? target : `${folder}/${target}`);
  };

  const runSearch = useCallback(
    async (value: string, active: Filters): Promise<void> => {
      // A query with only filters is legitimate — "everything tagged #homelab" —
      // so the search runs whenever either part is present.
      const hasFilter = active.tag !== undefined || active.dir !== undefined || active.days !== undefined;
      if (value.trim() === '' && !hasFilter) {
        setHits([]);
        return;
      }

      setView('search');
      const { hits: found } = await api.search(value.trim(), active);
      setHits(found);
    },
    [],
  );

  const onQueryChange = (value: string): void => {
    setQuery(value);
    void runSearch(value, filters).catch(() => setError('Suche fehlgeschlagen.'));
  };

  const toggleFilter = (patch: Filters): void => {
    const next: Filters = { ...filters };
    for (const [key, value] of Object.entries(patch) as Array<[keyof Filters, unknown]>) {
      if (next[key] === value) delete next[key];
      else Object.assign(next, { [key]: value });
    }
    setFilters(next);
    void runSearch(query, next).catch(() => setError('Suche fehlgeschlagen.'));
  };

  const clearFilters = (): void => {
    setFilters({});
    void runSearch(query, {}).catch(() => undefined);
  };

  // ⌘K on a Mac, Ctrl-K elsewhere. Registered on the window so it works while
  // the editor has focus, which is where it will usually be pressed.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    api
      .tags()
      .then(({ tags: list }) => setTags(list))
      .catch(() => undefined);
  }, [notes]);

  const showView = async (next: View): Promise<void> => {
    if (pending.current !== null) await flush();
    if (next === 'overview') await refreshOverview();
    if (next === 'tidy') await refreshTree();
    setView(next);
  };

  const signOut = async (): Promise<void> => {
    if (pending.current !== null) await flush();
    await api.logout();
    onSignedOut();
  };

  return (
    <div className="app" data-mobile-tree={mobileTree}>
      <header className="top">
        <div className="logo">
          <span className="mark" />
          ndBrain
        </div>

        <div className="segs" role="group" aria-label="Ansicht">
          <button type="button" aria-current={view === 'note'} onClick={() => void showView('note')}>
            Notiz
          </button>
          <button type="button" aria-current={view === 'overview'} onClick={() => void showView('overview')}>
            Übersicht
          </button>
          <button type="button" aria-current={view === 'tidy'} onClick={() => void showView('tidy')}>
            Aufräumen
          </button>
        </div>

        <div className="omni">
          <input
            type="search"
            placeholder="Volltext durchsuchen…"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            aria-label="Notizen durchsuchen"
          />
          <kbd
            style={{
              fontFamily: 'var(--mono)',
              fontSize: '.68rem',
              border: '1px solid var(--line-2)',
              borderRadius: 3,
              padding: '0 .25rem',
            }}
            title="Schnell zu einer Notiz springen"
          >
            ⌘K
          </kbd>
        </div>

        <button type="button" className="btn" onClick={() => void createNote()}>
          Neu
        </button>
        <span className="who">{user.displayName}</span>
        <button type="button" className="btn" onClick={() => void signOut()}>
          Abmelden
        </button>
      </header>

      <div className="body">
        <nav className="rail" aria-label="Vault">
          <div className="rail-scroll">
            <Tree
              notes={notes}
              selected={note?.path ?? null}
              findings={findings}
              onSelect={(path) => void openNote(path)}
            />
          </div>
          {tidy !== null && (
            <div className="rail-foot">
              <button type="button" className="fbtn" onClick={() => void showView('tidy')}>
                <span className="tick" style={{ background: 'var(--crit)' }} />
                Verwaist <span className="n">{tidy.orphans.length}</span>
              </button>
              <button type="button" className="fbtn" onClick={() => void showView('tidy')}>
                <span className="tick" style={{ background: 'var(--warn)' }} />
                Ungetaggt <span className="n">{tidy.untagged.length}</span>
              </button>
              <button type="button" className="fbtn" onClick={() => void showView('tidy')}>
                <span className="tick" style={{ background: 'var(--crit)' }} />
                Links ins Leere <span className="n">{tidy.deadLinks.length}</span>
              </button>
            </div>
          )}
        </nav>

        <main className="main">
          <div className="bar">
            <button
              type="button"
              className="btn"
              style={{ padding: '0 .4rem' }}
              onClick={() => setMobileTree((open) => !open)}
              aria-label="Ordner anzeigen"
            >
              ☰
            </button>
            <span className="cur">{note?.path ?? '—'}</span>
            <SaveIndicator state={saveState} />
          </div>

          {error !== null && (
            <div className="error" style={{ margin: '.6rem .9rem' }}>
              {error}
            </div>
          )}

          {view === 'note' &&
            (note === null ? (
              <p className="empty" style={{ padding: '2rem' }}>
                Wähle links eine Notiz oder leg mit „Neu" eine an.
              </p>
            ) : (
              <Editor
                path={note.path}
                initialContent={note.content}
                onChange={(content) => scheduleSave(note.path, content)}
              />
            ))}

          {view === 'overview' && overview !== null && (
            <OverviewView data={overview} onOpen={(path) => void openNote(path)} />
          )}
          {view === 'tidy' && tidy !== null && (
            <TidyView data={tidy} onOpen={(path) => void openNote(path)} />
          )}
          {view === 'search' && (
            <SearchView
              query={query}
              hits={hits}
              filters={filters}
              tags={tags}
              dirs={topLevelDirs(notes)}
              onToggleFilter={toggleFilter}
              onClearFilters={clearFilters}
              onOpen={(path) => void openNote(path)}
            />
          )}
        </main>

        {view === 'note' && (
          <ContextPanel
            notePath={note?.path ?? null}
            open={contextOpen}
            onToggle={() => setContextOpen((isOpen) => !isOpen)}
            onOpen={(path) => void openNote(path)}
            onCreate={(target) => void createFromDeadLink(target)}
            reloadKey={linksVersion}
          />
        )}
      </div>

      <Palette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenNote={(path) => void openNote(path)}
      />
    </div>
  );
}

/** Top-level folders, for the folder filter. Derived, never hardcoded. */
function topLevelDirs(notes: NoteRow[]): string[] {
  const dirs = new Set<string>();
  for (const note of notes) {
    const first = note.path.split('/')[0];
    if (first !== undefined && first !== note.path) dirs.add(first);
  }
  return [...dirs].sort((a, b) => a.localeCompare(b));
}

function SaveIndicator({ state }: { state: SaveState }): React.JSX.Element {
  const label = {
    saved: 'Gespeichert',
    dirty: 'Nicht gespeichert',
    saving: 'Speichert…',
    failed: 'Speichern fehlgeschlagen',
  }[state];

  return (
    <span className={`saved ${state === 'saved' ? '' : state}`} role="status">
      <i />
      {label}
    </span>
  );
}
