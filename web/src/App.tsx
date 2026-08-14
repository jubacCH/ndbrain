/**
 * The application shell: tree on the left, one of several views on the right.
 *
 * Saving is the part worth reading carefully. The editor holds the text, a
 * debounce turns a burst of typing into one write, and the header shows the real
 * state of that write at all times. With data that lives only on the server, a
 * silent save is not trustworthy — you have to be able to see that it arrived.
 *
 * Since sharing, an open note is a (vault, path) pair rather than a path, and
 * that pair is carried through every call here. The two things it changes:
 * a note may be read-only, which locks the editor; and a note may be written by
 * somebody else between opening and saving, which the server answers with a
 * conflict copy rather than a lost paragraph — so this layer has to say that
 * out loud, or the copy is just a strange file somebody finds months later.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ApiError,
  api,
  refKey,
  type NoteRow,
  type OpenNote,
  type Overview,
  type SearchHit,
  type Share,
  type Tidy,
  type User,
} from './api';
import { ContextPanel } from './Context';
import { Editor } from './Editor';
import { Login } from './Login';
import { Palette } from './Palette';
import { Tree, type Finding } from './Tree';
import { OverviewView, SearchView, SharesView, TidyView } from './Views';

export interface Filters {
  tag?: string;
  dir?: string;
  days?: number;
  /** A frontmatter key, optionally pinned to one of its values. */
  prop?: string;
  propValue?: string;
}

type View = 'note' | 'overview' | 'tidy' | 'search' | 'shares';
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
  const [open, setOpen] = useState<OpenNote | null>(null);
  const [granted, setGranted] = useState<Share[]>([]);
  const [received, setReceived] = useState<Share[]>([]);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [tidy, setTidy] = useState<Tidy | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Filters>({});
  const [tags, setTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [props, setProps] = useState<Array<{ key: string; count: number }>>([]);
  const [propValues, setPropValues] = useState<Array<{ value: string; count: number }>>([]);
  const [contextOpen, setContextOpen] = useState(true);
  // Bumped after every successful save so the context panel re-reads the links.
  const [linksVersion, setLinksVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [mobileTree, setMobileTree] = useState(false);

  const saveTimer = useRef<number | null>(null);
  const pending = useRef<{ owner: string; path: string; content: string } | null>(null);
  /**
   * The version the editor started from, sent with every write.
   *
   * Kept in a ref rather than state because it has to be right at the moment the
   * debounce fires, not at the next render — and it is updated from each save's
   * response, so a run of autosaves does not report the first one's version and
   * make every later save look like a conflict.
   */
  const baseMtime = useRef<number | null>(null);

  const refreshTree = useCallback(async (): Promise<void> => {
    const [tree, tidyData] = await Promise.all([api.tree(), api.tidy()]);
    setNotes(tree.notes);
    setTidy(tidyData);

    // The tree's state markers come from the same findings the tidy view lists,
    // so the two can never disagree. Tidy answers for the caller's own vault
    // only, so every key here carries the caller as the owner — a marker keyed
    // by path alone would light up a note of the same name in a shared vault.
    const map = new Map<string, Finding>();
    // `untagged` steht bewusst nicht im Baum. Es trifft in einem Vault, in dem
    // Tags keine Gewohnheit sind, auf praktisch jede Notiz — und eine Marke, die
    // an jeder Zeile steht, zeigt nirgends mehr etwas an. Sie bleibt in der
    // Aufräum-Ansicht und in der Leiste unten, wo eine Zahl das Richtige ist.
    for (const row of tidyData.stale) map.set(refKey(user.id, row.path), 'warn');
    for (const row of tidyData.orphans) map.set(refKey(user.id, row.path), 'crit');
    for (const row of tidyData.deadLinks) map.set(refKey(user.id, row.source), 'crit');
    setFindings(map);
  }, [user.id]);

  const refreshShares = useCallback(async (): Promise<void> => {
    const data = await api.shares();
    setGranted(data.granted);
    setReceived(data.received);
  }, []);

  const refreshOverview = useCallback(async (): Promise<void> => {
    setOverview(await api.overview());
  }, []);

  useEffect(() => {
    void refreshTree().catch(() => setError('Der Server antwortet gerade nicht.'));
    void refreshOverview().catch(() => undefined);
    void refreshShares().catch(() => undefined);
  }, [refreshTree, refreshOverview, refreshShares]);

  /** Writes whatever is pending right now. */
  const flush = useCallback(async (): Promise<void> => {
    const outstanding = pending.current;
    if (outstanding === null) return;
    pending.current = null;
    setSaveState('saving');

    try {
      const result = await api.putNote(
        outstanding.owner,
        outstanding.path,
        outstanding.content,
        baseMtime.current ?? undefined,
      );
      // This write is now the version to compare the next one against.
      baseMtime.current = result.note.mtimeMs;
      setSaveState(pending.current === null ? 'saved' : 'dirty');

      // Somebody else's version was displaced and kept. Reported plainly and
      // left on screen: the text on this screen won, and the other one is only
      // recoverable if the person is told the file exists.
      if (result.conflictCopy !== undefined) {
        setError(
          `Jemand anderes hat diese Notiz inzwischen geändert. Deine Fassung steht drin, ` +
            `die andere liegt als „${result.conflictCopy}" daneben.`,
        );
      }

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
    (owner: string, path: string, content: string): void => {
      pending.current = { owner, path, content };
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
    async (owner: string, path: string): Promise<void> => {
      // Never switch away from unsaved text without writing it first.
      if (pending.current !== null) await flush();

      try {
        const opened = await api.getNote(owner, path);
        setOpen(opened);
        baseMtime.current = opened.note.mtimeMs;
        setView('note');
        setSaveState('saved');
        setMobileTree(false);
        setError(null);
      } catch {
        // A note in a share that has just been withdrawn is gone in exactly the
        // same way as a deleted one, and is told so in the same words. There is
        // nothing to distinguish here — that is the point of the design.
        setError('Diese Notiz gibt es nicht mehr.');
        void refreshTree();
      }
    },
    [flush, refreshTree],
  );

  const createNoteAt = useCallback(
    async (owner: string, rawName: string): Promise<void> => {
      const name = rawName.trim();
      if (name === '') return;

      const path = name.endsWith('.md') ? name : `${name}.md`;
      const title = path.split('/').pop()?.replace(/\.md$/i, '') ?? '';

      try {
        await api.putNote(owner, path, `# ${title}\n\n`);
        await refreshTree();
        await openNote(owner, path);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'Anlegen fehlgeschlagen.');
      }
    },
    [openNote, refreshTree],
  );

  // Always in your own vault. Creating into somebody else's shared folder is
  // possible through the dead-link button below, where the folder is implied by
  // the note you are standing in; offering it here would mean a vault picker on
  // the most-used button in the application.
  const createNote = async (): Promise<void> => {
    const name = window.prompt('Name der neuen Notiz (Ordner mit / möglich)');
    if (name === null) return;
    await createNoteAt(user.id, name);
  };

  const createFolder = async (): Promise<void> => {
    const name = window.prompt('Name des neuen Ordners (Unterordner mit / möglich)');
    if (name === null || name.trim() === '') return;

    try {
      await api.createFolder(name.trim());
      await refreshTree();
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Ordner anlegen fehlgeschlagen.');
    }
  };

  /**
   * Renaming a folder moves every note inside it, which is what carries the
   * links along. Reported afterwards rather than silently: moving forty notes
   * and rewriting a dozen files is a big thing to have happen without a word.
   */
  const renameFolder = async (from: string): Promise<void> => {
    const to = window.prompt('Ordner umbenennen oder verschieben (neuer Pfad)', from);
    if (to === null || to.trim() === '' || to.trim() === from) return;

    try {
      const result = await api.renameFolder(from, to.trim());
      await refreshTree();
      setError(
        `„${from}" → „${result.folder}": ${result.movedNotes.length} Notizen verschoben` +
          (result.updatedLinks.length > 0
            ? `, Verweise in ${result.updatedLinks.length} Notizen mitgezogen.`
            : '.'),
      );
      // The open note may have moved with the folder.
      if (open !== null && open.owner === user.id && open.note.path.startsWith(`${from}/`)) {
        await openNote(user.id, `${result.folder}${open.note.path.slice(from.length)}`);
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Umbenennen fehlgeschlagen.');
    }
  };

  /**
   * Creates the note a dead link points at, next to the note that links to it.
   *
   * Putting it in the same folder is the guess that is right most of the time and
   * cheap to undo — the alternative is another dialogue at the moment somebody
   * just wanted the gap filled.
   */
  const createFromDeadLink = async (target: string): Promise<void> => {
    if (open === null) return;
    // Same vault as the note that links to it, not the caller's own: a link
    // inside somebody's shared folder means a note in *their* vault, and filling
    // the gap in yours would leave the link just as broken as before.
    const folder = open.note.path.split('/').slice(0, -1).join('/');
    await createNoteAt(open.owner, folder === '' ? target : `${folder}/${target}`);
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
    // A value only means something under its key. Dropping the key has to drop
    // the value with it, or the next search filters on a pair that is no longer
    // on screen.
    if (next.prop === undefined) delete next.propValue;
    setFilters(next);
    void runSearch(query, next).catch(() => setError('Suche fehlgeschlagen.'));

    if (next.prop !== undefined && next.prop !== filters.prop) {
      api
        .propValues(next.prop)
        .then(({ values }) => setPropValues(values))
        .catch(() => setPropValues([]));
    } else if (next.prop === undefined) {
      setPropValues([]);
    }
  };

  const clearFilters = (): void => {
    setFilters({});
    setPropValues([]);
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
    // The vault's own vocabulary, re-read whenever its notes changed: a key
    // exists exactly as long as some note declares it.
    api
      .propKeys()
      .then(({ props: list }) => setProps(list))
      .catch(() => undefined);
  }, [notes]);

  // Only your own folders can be shared out, so the suggestions on that form
  // come from your own notes rather than from everything you can see.
  const ownDirs = useMemo(
    () => topLevelDirs(notes.filter((row) => row.owner === user.id)),
    [notes, user.id],
  );

  /**
   * Runs a bulk action over the current selection and reports honestly.
   *
   * Partial success is the normal outcome, not an exception: the server does
   * what it can and names what it could not, and hiding that behind a generic
   * "some items failed" would leave somebody to find out which ones by hand.
   */
  const runBulk = async (action: 'move' | 'tag' | 'delete'): Promise<void> => {
    const paths = [...selection];
    if (paths.length === 0) return;

    let extra: { tag?: string; dir?: string } = {};

    if (action === 'move') {
      const dir = window.prompt(`${paths.length} Notizen verschieben nach (leer = Vault-Wurzel)`, 'Archiv');
      if (dir === null) return;
      extra = { dir };
    } else if (action === 'tag') {
      const tag = window.prompt(`${paths.length} Notizen taggen mit`);
      if (tag === null || tag.trim() === '') return;
      extra = { tag };
    } else if (!window.confirm(`${paths.length} Notizen wirklich löschen? Das lässt sich nicht rückgängig machen.`)) {
      return;
    }

    setBulkBusy(true);
    try {
      // The caller's own vault: the tidy view that feeds this selection never
      // shows anybody else's notes.
      const result = await api.bulk(user.id, action, paths, extra);
      setSelection(new Set());
      await refreshTree();
      await refreshOverview();

      if (result.failed.length === 0) {
        setError(null);
      } else {
        const names = result.failed.slice(0, 3).map((entry) => entry.path).join(', ');
        const more = result.failed.length > 3 ? ` und ${result.failed.length - 3} weitere` : '';
        setError(
          `${result.ok.length} erledigt, ${result.failed.length} nicht: ${names}${more} — ` +
            `${result.failed[0]?.reason ?? ''}`,
        );
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Sammelaktion fehlgeschlagen.');
    } finally {
      setBulkBusy(false);
    }
  };

  const showView = async (next: View): Promise<void> => {
    if (pending.current !== null) await flush();
    if (next === 'overview') await refreshOverview();
    if (next === 'tidy') await refreshTree();
    if (next === 'shares') await refreshShares();
    setView(next);
  };

  const grantShare = async (grantee: string, prefix: string, canWrite: boolean): Promise<void> => {
    setShareBusy(true);
    try {
      await api.grantShare(grantee, prefix, canWrite);
      await refreshShares();
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Freigeben fehlgeschlagen.');
    } finally {
      setShareBusy(false);
    }
  };

  const revokeShare = async (share: Share): Promise<void> => {
    const own = share.owner === user.id;
    const what = share.prefix === '' ? 'den ganzen Vault' : `„${share.prefix}"`;
    const question = own
      ? `${share.grantee} den Zugriff auf ${what} entziehen?`
      : `Zugriff auf ${what} von ${share.owner} aufgeben?`;
    if (!window.confirm(question)) return;

    setShareBusy(true);
    try {
      await api.revokeShare(share.id);
      await refreshShares();
      // A withdrawn share can take the open note with it, and the tree still
      // shows the vault until it is re-read.
      await refreshTree();
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Zurückziehen fehlgeschlagen.');
    } finally {
      setShareBusy(false);
    }
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
          <button type="button" aria-current={view === 'shares'} onClick={() => void showView('shares')}>
            Freigaben
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
        {/* A folder you can make before you have anything to put in it — the
            structure is something you prepare, not only something that accretes. */}
        <button type="button" className="btn" onClick={() => void createFolder()} title="Ordner anlegen">
          Ordner
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
              self={user.id}
              received={received}
              selected={open === null ? null : { owner: open.owner, path: open.note.path }}
              findings={findings}
              onSelect={(owner, path) => void openNote(owner, path)}
              onRenameFolder={(path) => void renameFolder(path)}
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
            <span className="cur">{open?.note.path ?? '—'}</span>
            {/*
              Whose note this is, and whether it can be changed — next to the
              path rather than in a panel, because it answers "am I about to
              edit somebody else's file" at the moment that matters.
            */}
            {open !== null && open.owner !== user.id && (
              <span className="pill p-info">
                {open.owner} · {open.canWrite ? 'schreiben' : 'nur lesen'}
              </span>
            )}
            <SaveIndicator state={saveState} />
          </div>

          {error !== null && (
            <div className="error" style={{ margin: '.6rem .9rem' }}>
              {error}
            </div>
          )}

          {view === 'note' &&
            (open === null ? (
              <p className="empty" style={{ padding: '2rem' }}>
                Wähle links eine Notiz oder leg mit „Neu" eine an.
              </p>
            ) : (
              <Editor
                owner={open.owner}
                path={open.note.path}
                initialContent={open.note.content}
                readOnly={!open.canWrite}
                onChange={(content) => scheduleSave(open.owner, open.note.path, content)}
              />
            ))}

          {view === 'overview' && overview !== null && (
            <OverviewView data={overview} onOpen={(owner, path) => void openNote(owner, path)} />
          )}
          {view === 'tidy' && tidy !== null && (
            <TidyView
              data={tidy}
              selected={selection}
              busy={bulkBusy}
              tags={tags}
              dirs={topLevelDirs(notes)}
              onToggle={(path) =>
                setSelection((current) => {
                  const next = new Set(current);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return next;
                })
              }
              onToggleAll={(paths) =>
                // All-or-nothing rather than a tri-state: the second click after
                // "select all" should clear, which is what people expect.
                setSelection((current) => (current.size === paths.length ? new Set() : new Set(paths)))
              }
              onOpen={(path) => void openNote(user.id, path)}
              onBulk={(action) => void runBulk(action)}
            />
          )}
          {view === 'search' && (
            <SearchView
              query={query}
              hits={hits}
              filters={filters}
              tags={tags}
              dirs={topLevelDirs(notes)}
              self={user.id}
              props={props}
              propValues={propValues}
              onToggleFilter={toggleFilter}
              onClearFilters={clearFilters}
              onOpen={(owner, path) => void openNote(owner, path)}
            />
          )}
          {view === 'shares' && (
            <SharesView
              granted={granted}
              received={received}
              dirs={ownDirs}
              busy={shareBusy}
              onGrant={(grantee, prefix, canWrite) => void grantShare(grantee, prefix, canWrite)}
              onRevoke={(share) => void revokeShare(share)}
            />
          )}
        </main>

        {view === 'note' && (
          <ContextPanel
            note={open === null ? null : { owner: open.owner, path: open.note.path }}
            self={user.id}
            canCreate={open?.canWrite ?? false}
            open={contextOpen}
            onToggle={() => setContextOpen((isOpen) => !isOpen)}
            onOpen={(owner, path) => void openNote(owner, path)}
            onCreate={(target) => void createFromDeadLink(target)}
            reloadKey={linksVersion}
          />
        )}
      </div>

      <Palette
        open={paletteOpen}
        self={user.id}
        onClose={() => setPaletteOpen(false)}
        onOpenNote={(owner, path) => void openNote(owner, path)}
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
