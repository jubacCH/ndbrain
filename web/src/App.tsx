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
  type GraphData,
  type PulseEvent,
  type Share,
  type Tidy,
  type User,
} from './api';
import { Brain } from './Brain';
import { ContextPanel } from './Context';
import { Editor } from './Editor';
import { Login } from './Login';
import { Palette } from './Palette';
import { Tree, displayPath, type Finding } from './Tree';
import { OverviewView, SearchView, SharesView, TidyView } from './Views';

export interface Filters {
  tag?: string;
  dir?: string;
  days?: number;
  /** A frontmatter key, optionally pinned to one of its values. */
  prop?: string;
  propValue?: string;
}

type View = 'note' | 'overview' | 'brain' | 'tidy' | 'search' | 'shares';
type SaveState = 'saved' | 'dirty' | 'saving' | 'failed';

const SAVE_DEBOUNCE_MS = 500;

/**
 * Recently opened notes.
 *
 * Most navigation is return traffic rather than discovery, and the tree is the
 * slowest possible way to reach a note you had open ten minutes ago. Kept in the
 * browser, not on the server: it is a property of this screen, and syncing it
 * would make two people sharing a vault steer each other's sidebar.
 */
const RECENTS_KEY = 'ndbrain.recents';
const RECENTS_SHOWN = 5;

interface Recent {
  owner: string;
  path: string;
}

function loadRecents(): Recent[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    return raw === null ? [] : (JSON.parse(raw) as Recent[]);
  } catch {
    return [];
  }
}

function pushRecent(owner: string, path: string): void {
  try {
    const next = [{ owner, path }, ...loadRecents().filter((r) => !(r.owner === owner && r.path === path))];
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next.slice(0, 12)));
  } catch {
    // Private browsing, a full quota — none of it is worth an error message.
  }
}

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
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [pulse, setPulse] = useState<PulseEvent[]>([]);
  /** The server's timestamp to ask from next time. */
  const pulseSince = useRef<number | undefined>(undefined);
  // Bumped after every successful save so the context panel re-reads the links.
  const [linksVersion, setLinksVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** On a narrow screen the tree overlays the page rather than keeping a column. */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [treeFilter, setTreeFilter] = useState('');
  const [recents, setRecents] = useState<Recent[]>(loadRecents);

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
    // `untagged` is deliberately absent from the tree. In a vault where tagging
    // is not a habit it matches nearly every note, and a marker on every row
    // points at nothing. It stays in the tidy view and in the strip below, where
    // a number is the right shape for it.
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
    void refreshTree().catch(() => setError('The server is not answering right now.'));
    void refreshOverview().catch(() => undefined);
    void refreshShares().catch(() => undefined);
    // Der Graph wird gleich zu Beginn gebraucht: die Nachbarschaft rechts unten
    // steht neben jeder offenen Notiz, nicht erst in der grossen Ansicht.
    void api
      .graph()
      .then(setGraph)
      .catch(() => undefined);
    void api
      .pulse()
      .then(({ now }) => {
        pulseSince.current = now;
      })
      .catch(() => undefined);
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
          `Somebody else changed this note in the meantime. Your version is the one in ` +
            `place; theirs was kept alongside it as “${result.conflictCopy}”.`,
        );
      }

      // Links may have appeared or broken with this edit, so the panel and the
      // tree markers are re-read rather than left showing the previous state.
      setLinksVersion((version) => version + 1);
      void refreshTree();
      // A new [[link]] is a new edge — otherwise the neighbourhood shows the
      // state from a moment ago.
      void api.graph().then(setGraph).catch(() => undefined);
    } catch (caught) {
      setSaveState('failed');
      setError(
        caught instanceof ApiError ? caught.message : 'Could not save. Your text stays in the editor.',
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
        setDrawerOpen(false);
        setError(null);
        pushRecent(owner, path);
        setRecents(loadRecents());
      } catch {
        // A note in a share that has just been withdrawn is gone in exactly the
        // same way as a deleted one, and is told so in the same words. There is
        // nothing to distinguish here — that is the point of the design.
        setError('That note is gone.');
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
        setError(caught instanceof ApiError ? caught.message : 'Could not create that.');
      }
    },
    [openNote, refreshTree],
  );

  // Always in your own vault. Creating into somebody else's shared folder is
  // possible through the dead-link button below, where the folder is implied by
  // the note you are standing in; offering it here would mean a vault picker on
  // the most-used button in the application.
  const createNote = async (): Promise<void> => {
    const name = window.prompt('Name for the new note (use / for a folder)');
    if (name === null) return;
    await createNoteAt(user.id, name);
  };

  const createFolder = async (): Promise<void> => {
    const name = window.prompt('Name for the new folder (use / to nest)');
    if (name === null || name.trim() === '') return;

    try {
      await api.createFolder(name.trim());
      await refreshTree();
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create that folder.');
    }
  };

  /**
   * Renaming a folder moves every note inside it, which is what carries the
   * links along. Reported afterwards rather than silently: moving forty notes
   * and rewriting a dozen files is a big thing to have happen without a word.
   */
  const renameFolder = async (from: string): Promise<void> => {
    const to = window.prompt('Rename or move this folder (new path)', from);
    if (to === null || to.trim() === '' || to.trim() === from) return;

    try {
      const result = await api.renameFolder(from, to.trim());
      await refreshTree();
      setError(
        `“${from}” → “${result.folder}”: ${result.movedNotes.length} notes moved` +
          (result.updatedLinks.length > 0
            ? `, links updated in ${result.updatedLinks.length} notes.`
            : '.'),
      );
      // The open note may have moved with the folder.
      if (open !== null && open.owner === user.id && open.note.path.startsWith(`${from}/`)) {
        await openNote(user.id, `${result.folder}${open.note.path.slice(from.length)}`);
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not rename that.');
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
    void runSearch(value, filters).catch(() => setError('Search failed.'));
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
    void runSearch(query, next).catch(() => setError('Search failed.'));

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

  /**
   * The pulse: ask every two seconds what happened.
   *
   * Only while a network view is on screen. Polling in the background would keep
   * the server busy for something nobody is looking at, and the events would be
   * missed on return anyway — they run through as a pulse rather than piling up
   * as a list.
   */
  useEffect(() => {
    // Auch beim Schreiben: rechts unten leuchtet die Nachbarschaft mit.
    if (view !== 'brain' && view !== 'note') return;

    let alive = true;
    const tick = (): void => {
      api
        .pulse(pulseSince.current)
        .then(({ now, events: fresh }) => {
          if (!alive) return;
          pulseSince.current = now;
          if (fresh.length > 0) {
            setPulse(fresh.map((e) => ({ ...e, owner: user.id })));
          }
        })
        .catch(() => undefined);
    };

    tick();
    const timer = window.setInterval(tick, 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [view, user.id]);

  /**
   * The open note's neighbourhood: itself and whatever links to or from it.
   *
   * Deliberately not the whole network. Sixty nodes in a panel this size are a
   * knot, and the question while writing is a different one anyway — not "what
   * does my vault look like" but "what does this hang on".
   */
  /**
   * The recents list resolved against the notes that actually exist.
   *
   * Resolving rather than trusting what was stored: a note that has been
   * deleted, renamed, or un-shared since it was last opened simply drops out of
   * the list instead of sitting there as a row that errors when clicked.
   */
  const recentRows = useMemo((): NoteRow[] => {
    const byKey = new Map(notes.map((note) => [refKey(note.owner, note.path), note]));
    const out: NoteRow[] = [];
    for (const recent of recents) {
      const note = byKey.get(refKey(recent.owner, recent.path));
      // The note you are looking at does not need a shortcut to itself.
      if (note === undefined) continue;
      if (open !== null && open.owner === note.owner && open.note.path === note.path) continue;
      out.push(note);
      if (out.length === RECENTS_SHOWN) break;
    }
    return out;
  }, [recents, notes, open]);

  const local = useMemo((): GraphData | null => {
    if (graph === null || open === null) return null;

    const me = `${open.owner} ${open.note.path}`;
    const nachbarn = new Set<string>([me]);
    for (const e of graph.edges) {
      const from = `${e.owner} ${e.from}`;
      const to = `${e.owner} ${e.to}`;
      if (from === me) nachbarn.add(to);
      if (to === me) nachbarn.add(from);
    }

    return {
      nodes: graph.nodes.filter((n) => nachbarn.has(`${n.owner} ${n.path}`)),
      // Auch Kanten *zwischen* den Nachbarn: sie zeigen, ob die Umgebung ein
      // Geflecht ist oder nur ein Stern um diese eine Notiz.
      edges: graph.edges.filter(
        (e) => nachbarn.has(`${e.owner} ${e.from}`) && nachbarn.has(`${e.owner} ${e.to}`),
      ),
    };
  }, [graph, open]);

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
      const dir = window.prompt(`Move ${paths.length} notes to (empty = top of the vault)`, 'Archive');
      if (dir === null) return;
      extra = { dir };
    } else if (action === 'tag') {
      const tag = window.prompt(`Tag ${paths.length} notes with`);
      if (tag === null || tag.trim() === '') return;
      extra = { tag };
    } else if (!window.confirm(`Delete ${paths.length} notes? This cannot be undone.`)) {
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
      setError(caught instanceof ApiError ? caught.message : 'That bulk action failed.');
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
      setError(caught instanceof ApiError ? caught.message : 'Could not share that.');
    } finally {
      setShareBusy(false);
    }
  };

  const revokeShare = async (share: Share): Promise<void> => {
    const own = share.owner === user.id;
    const what = share.prefix === '' ? 'the whole vault' : `“${share.prefix}”`;
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
      setError(caught instanceof ApiError ? caught.message : 'Could not withdraw that.');
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
    <div className="app" data-drawer={drawerOpen} data-wide={view !== 'note'}>
      {/*
        Everything at once rather than one thing at a time. Tabs are a mode
        switch: they hide most of the tool behind a click. Something that stays
        open all day would rather show it all — on the left where, in the middle
        what, on the right what it connects to.
      */}
      <nav className="nav" aria-label="Navigation">
        <div className="nav-head">
          <span className="nav-who">{user.displayName}</span>
          <button type="button" className="nav-x" onClick={() => setDrawerOpen(false)} aria-label="Close menu">
            ✕
          </button>
        </div>

        <div className="nav-actions">
          <button type="button" onClick={() => void createNote()}>New note</button>
          <button type="button" onClick={() => void createFolder()}>Folder</button>
        </div>

        <div className="nav-views" role="group" aria-label="View">
          <button type="button" aria-current={view === 'note'} onClick={() => void showView('note')}>
            Write
          </button>
          <button type="button" aria-current={view === 'overview'} onClick={() => void showView('overview')}>
            Overview
          </button>
          <button type="button" aria-current={view === 'brain'} onClick={() => void showView('brain')}>
            Whole network
          </button>
          <button type="button" aria-current={view === 'tidy'} onClick={() => void showView('tidy')}>
            Tidy up
          </button>
          <button type="button" aria-current={view === 'search'} onClick={() => void showView('search')}>
            Search
          </button>
        </div>

        {/*
          Filtering the tree, not searching the text — this only ever looks at
          names, answers on every keystroke, and never leaves the sidebar. Full
          text search is its own view, and ⌘K is for jumping. Three ways to find
          something sounds like two too many, but they answer different
          questions: where is it filed, where have I read this word, and take me
          to the one I am already thinking of.
        */}
        <div className="nav-find">
          <input
            type="search"
            value={treeFilter}
            placeholder="Filter by name…"
            aria-label="Filter the tree by name"
            onChange={(event) => setTreeFilter(event.target.value)}
          />
          {treeFilter !== '' && (
            <button type="button" onClick={() => setTreeFilter('')} aria-label="Clear filter">
              ✕
            </button>
          )}
        </div>

        {/* Return traffic, not discovery — hidden while filtering, when the
            answer on screen is the one you just typed for. */}
        {treeFilter === '' && recentRows.length > 0 && (
          <div className="nav-recent">
            <p className="cap">Recent</p>
            <ul>
              {recentRows.map((note) => (
                <li key={refKey(note.owner, note.path)}>
                  <button
                    type="button"
                    className="node"
                    aria-current={open !== null && open.owner === note.owner && open.note.path === note.path}
                    onClick={() => void openNote(note.owner, note.path)}
                  >
                    <span className="nm">{note.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="nav-tree">
          <Tree
            notes={notes}
            self={user.id}
            received={received}
            selected={open === null ? null : { owner: open.owner, path: open.note.path }}
            findings={findings}
            filter={treeFilter.trim().toLowerCase()}
            onSelect={(owner, path) => {
              void openNote(owner, path);
              setDrawerOpen(false);
            }}
            onRenameFolder={(path) => void renameFolder(path)}
          />
        </div>

        {tidy !== null && (
          <div className="nav-health">
            <button type="button" onClick={() => void showView('tidy')}>
              <i style={{ background: 'var(--crit)' }} />
              orphaned <b>{tidy.orphans.length}</b>
            </button>
            {/* Withheld while nothing is tagged — see Queries.tagsInUse. */}
            {overview?.counts.tagsInUse === true && (
              <button type="button" onClick={() => void showView('tidy')}>
                <i style={{ background: 'var(--warn)' }} />
                untagged <b>{tidy.untagged.length}</b>
              </button>
            )}
            {tidy.deadLinks.length > 0 && (
              <button type="button" onClick={() => void showView('tidy')}>
                <i style={{ background: 'var(--crit)' }} />
                broken <b>{tidy.deadLinks.length}</b>
              </button>
            )}
          </div>
        )}

        <div className="nav-foot">
          <button type="button" onClick={() => void showView('shares')}>Sharing</button>
          <button type="button" onClick={() => void signOut()}>Sign out</button>
        </div>
      </nav>

      <main className="main">
        <div className="main-bar">
          <button
            type="button"
            className="bar-menu"
            onClick={() => setDrawerOpen((o) => !o)}
            aria-label="Menu"
          >
            ☰
          </button>
          {/* The same de-prefixed reading as the tree, and no longer marked
              `mono`: a path here is a name, not code. The literal path is not
              lost — it is shown in full under "File" in the right column, which
              is the one place that is *about* the file on disk. */}
          <span className="cur">
            {view === 'note'
              ? open === null
                ? 'No note open'
                : [displayPath(open.note.path), open.note.title].filter((part) => part !== '').join(' › ')
              : titleOfView(view)}
          </span>
          {view === 'note' && open !== null && open.owner !== user.id && (
            <span className="pill p-info">
              {open.owner} · {open.canWrite ? 'schreiben' : 'nur lesen'}
            </span>
          )}
          <button type="button" className="bar-k" onClick={() => setPaletteOpen(true)} title="Springen oder anlegen">
            ⌘K
          </button>
          {view === 'note' && <SaveIndicator state={saveState} />}
        </div>

        {error !== null && (
          <div className="floaterror" role="status">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="Meldung schliessen">
              ✕
            </button>
          </div>
        )}

        <div className="main-body">
          {view === 'note' &&
            (open === null ? (
              <p className="empty" style={{ padding: '2rem' }}>
                Pick a note on the left, or press <kbd>⌘K</kbd> and type a title.
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

          {view === 'brain' &&
            (graph === null ? (
              <p className="empty" style={{ padding: '2rem' }}>Beziehungen werden geladen…</p>
            ) : (
              <div className="brainwrap">
                <Brain data={graph} events={pulse} onOpen={(owner, path) => void openNote(owner, path)} />
                <div className="brainlegend">
                  <span><i style={{ background: '#7fe9f0' }} />read</span>
                  <span><i style={{ background: '#ffb86b' }} />written</span>
                </div>
                <div className="brainfoot">
                  {graph.nodes.length} notes · {graph.edges.length} links ·{' '}
                  {graph.nodes.filter((n) => n.links === 0).length} ohne Verbindung
                  <span className="sep" />
                  Double-click opens the note
                </div>
              </div>
            ))}

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
              onQuery={onQueryChange}
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
        </div>
      </main>

      {/*
        The right column belongs to the open note and appears only with it.
        Above, what this note is and what it hangs on; below, its neighbourhood
        as a picture — not the whole network, which at this size would be a knot.
      */}
      {view === 'note' && open !== null && (
        <aside className="side" aria-label="About the open note">
          <div className="side-info">
            <ContextPanel
              note={{ owner: open.owner, path: open.note.path }}
              self={user.id}
              canCreate={open.canWrite}
              onOpen={(owner, path) => void openNote(owner, path)}
              onCreate={(target) => void createFromDeadLink(target)}
              reloadKey={linksVersion}
            />
          </div>

          <div className="side-graph">
            <div className="side-graph-head">
              <span>Neighbourhood</span>
              <button type="button" onClick={() => void showView('brain')} title="Show the whole network">
                whole network
              </button>
            </div>
            {local === null ? (
              <p className="empty small">Wird geladen…</p>
            ) : local.nodes.length <= 1 ? (
              <p className="empty small">
                No links yet. Type <code>[[</code> in the text to connect this note.
              </p>
            ) : (
              <Brain data={local} events={pulse} onOpen={(owner, path) => void openNote(owner, path)} />
            )}
          </div>
        </aside>
      )}

      <Palette
        open={paletteOpen}
        self={user.id}
        onClose={() => setPaletteOpen(false)}
        onOpenNote={(owner, path) => void openNote(owner, path)}
      />
    </div>
  );
}

/** Was in der Kopfzeile steht, wenn keine Notiz offen ist. */
function titleOfView(view: string): string {
  return (
    {
      overview: 'Overview',
      brain: 'Whole network',
      tidy: 'Tidy up',
      search: 'Suche',
      shares: 'Freigaben',
    }[view] ?? ''
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
    saved: 'Saved',
    dirty: 'Unsaved',
    saving: 'Saving…',
    failed: 'Save failed',
  }[state];

  return (
    <span className={`saved ${state === 'saved' ? '' : state}`} role="status">
      <i />
      {label}
    </span>
  );
}
