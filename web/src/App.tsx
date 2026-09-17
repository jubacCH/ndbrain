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
import { createPortal, flushSync } from 'react-dom';

import {
  ApiError,
  api,
  onUnauthenticated,
  refKey,
  type NoteRow,
  type SearchHit,
  type GraphData,
  type PulseEvent,
  type FileRow,
  type Share,
  type TaskRow,
  type User,
} from './api';
import { useQueryClient } from '@tanstack/react-query';

import { Brain } from './Brain';
import { ContextPanel } from './Context';
import { Editor } from './Editor';
import { copy } from './copy';
import { discardLegacy, dropRecent, forgetAccount, loadRecents, pushRecent, type Recent } from './accountStorage';
import { SESSION_SIGNAL_KEY, announceSessionChange, closeSession, openSession } from './session';
import { applyPrefs, loadPrefs, savePrefs, type Prefs, type Theme } from './prefs';
import { GearIcon, MoreIcon, ShareIcon, ShieldIcon, SignOutIcon, TrashIcon } from './icons';
import { NetworkFrame, type FullscreenFrame } from './NetworkFrame';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { MenuButton, type MenuItem } from './Menu';
import { mayChange } from './rights';
import { SettingsView } from './Settings';
import { AdminView } from './Admin';
import { TopicsPanel } from './Topics';
import { FilesView } from './Files';
import { Login } from './Login';
import { Palette } from './Palette';
import { Tree, displayPath, type Finding } from './Tree';
import { SearchView, SharesView, TasksView, TidyView } from './Views';
import { HomeView } from './Home';
import type { HealthKey } from './healthScore';
import {
  invalidate,
  keys,
  useSettings,
  useAdminUsers,
  useAdminKeys,
  useTopics,
  useFiles,
  useGraph,
  useNote,
  useOverview,
  useShares,
  useTagRegistry,
  useTags,
  useTasks,
  useTidy,
  useToggleTask,
  useTree,
} from './queries';

export interface Filters {
  tag?: string;
  dir?: string;
  days?: number;
  /** A frontmatter key, optionally pinned to one of its values. */
  prop?: string;
  propValue?: string;
}

type View =
  | 'note'
  | 'overview'
  | 'brain'
  | 'tidy'
  | 'tasks'
  | 'search'
  | 'shares'
  | 'files'
  | 'settings'
  | 'admin';
type SaveState = 'saved' | 'dirty' | 'saving' | 'failed';


/*
 * Recently opened notes live in `accountStorage.ts`, keyed by account.
 *
 * Most navigation is return traffic rather than discovery, and the tree is the
 * slowest possible way to reach a note you had open ten minutes ago. Kept in the
 * browser, not on the server: it is a property of this screen, and syncing it
 * would make two people sharing a vault steer each other's sidebar.
 */


/**
 * Whether a media query matches, kept current.
 *
 * Read by the shell for two things CSS alone cannot decide: whether the sidebar
 * is a drawer (a phone has no folded sidebar), and which theme is on screen when
 * the choice is "system" — the header's theme button has to know which way to
 * flip.
 */
function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = (): void => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** The same width at which `styles.css` turns the sidebar into a drawer. */
const DRAWER_QUERY = '(max-width: 820px)';

function isDark(theme: Theme, systemDark: boolean): boolean {
  return theme === 'dark' || (theme === 'system' && systemDark);
}

export function App(): React.JSX.Element {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const client = useQueryClient();
  /** The signed-in account as of now, for listeners registered once. */
  const userRef = useRef<User | null>(null);

  const begin = useCallback((next: User): void => {
    openSession(next.id);
    userRef.current = next;
    setUser(next);
  }, []);

  /**
   * Ends the session in this tab, whatever ended it: the sign-out button, an
   * expired session, another tab.
   *
   * The order is the point. The shell is unmounted first and synchronously,
   * so everything that saves on its way out (the brain's arrangement, and
   * whatever comes later) has done so. Only then are the writes closed and
   * the account's entries removed. Forgetting first, as the first version
   * did, let the brain's unmount write its positions straight back.
   */
  const end = useCallback(
    (announce: boolean): void => {
      const previous = userRef.current;
      if (previous === null) return;
      userRef.current = null;
      flushSync(() => setUser(null));
      closeSession();
      forgetAccount(previous.id);
      // Every answer in the cache belongs to the account that just left.
      client.clear();
      if (announce) announceSessionChange();
    },
    [client],
  );

  useEffect(() => {
    api
      .me()
      .then(({ user: me }) => begin(me))
      .catch(() => setUser(null))
      .finally(() => setReady(true));
  }, [begin]);

  // A 401 while signed in means the session is gone. Before sign-in it is the
  // login page's own `/auth/me`, and `end` does nothing without a user.
  useEffect(() => onUnauthenticated(() => end(false)), [end]);

  // Another tab signed out or in. Cookies are shared, so this tab's session is
  // whatever the server says now: nobody, somebody else, or still the same.
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== SESSION_SIGNAL_KEY) return;
      const was = userRef.current?.id ?? null;
      api
        .me()
        .then(({ user: me }) => {
          if (me.id === was) return;
          // On the sign-in page there is nothing to end; this tab simply
          // follows the sign-in that happened in the other one.
          end(false);
          begin(me);
          setReady(true);
        })
        .catch(() => end(false));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [begin, end]);

  if (!ready) return <div className="login" />;
  if (user === null)
    return (
      <Login
        onSignedIn={(next) => {
          begin(next);
          announceSessionChange();
        }}
      />
    );
  return <Shell user={user} onUserChanged={begin} onSignedOut={() => end(true)} />;
}

function Shell({
  user,
  onUserChanged,
  onSignedOut,
}: {
  user: User;
  /** Called when the account itself changed — so far, only its display name. */
  onUserChanged: (user: User) => void;
  onSignedOut: () => void;
}): React.JSX.Element {
  /**
   * Where the application opens.
   *
   * Read from the preferences once, at mount. `note` is special: it means "the
   * one I had open", which needs the recents list, so the view starts on the
   * note pane and the effect below opens the note as soon as the tree arrives.
   */
  const [view, setView] = useState<View>(() => loadPrefs().startView as View);
  /** Which note is open — the identity, not its content. */
  const [openRef, setOpenRef] = useState<{ owner: string; path: string } | null>(null);
  /** Where to place the cursor on the next open — a task's line, or nowhere. */
  const [jumpLine, setJumpLine] = useState<number | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Filters>({});
  const [hits, setHits] = useState<SearchHit[]>([]);
  /**
   * Which search is the current one.
   *
   * Typing fires a request per keystroke and they do not come back in order. The
   * old code had no guard at all, so a slow answer for "prox" could land after a
   * fast one for "proxmox" and leave the wrong results under the right query.
   */
  const searchSeq = useRef(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /**
   * The network frame, while it is in full screen.
   *
   * Nothing outside it is visible then. Messages are drawn inside it, and the
   * palette steps out of full screen first — see `openPalette`.
   */
  const [fullscreen, setFullscreen] = useState<FullscreenFrame | null>(null);
  const fullscreenRef = useRef<FullscreenFrame | null>(null);
  fullscreenRef.current = fullscreen;
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [taskDir, setTaskDir] = useState<string | undefined>(undefined);
  const [taskIncludeDone, setTaskIncludeDone] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const [topicsDone, setTopicsDone] = useState<number | null>(null);
  /** The finding the tidy view opens narrowed to, when it was reached from the home view's health card. */
  const [tidyFocus, setTidyFocus] = useState<HealthKey | 'stale' | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [props, setProps] = useState<Array<{ key: string; count: number }>>([]);
  const [propValues, setPropValues] = useState<Array<{ value: string; count: number }>>([]);
  const [pulse, setPulse] = useState<PulseEvent[]>([]);
  /** The server's timestamp to ask from next time. */
  const pulseSince = useRef<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  /** On a narrow screen the tree overlays the page rather than keeping a column. */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [treeFilter, setTreeFilter] = useState('');
  /**
   * The note the tree is asked to show without opening it — the inspector's
   * "Show in tree". Counted, so asking twice for the same note scrolls to it
   * again; cleared when a note is opened, since the tree then shows that one.
   */
  const [revealed, setRevealed] = useState<{ owner: string; path: string; seq: number } | null>(null);
  const revealSeq = useRef(0);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const narrow = useMedia(DRAWER_QUERY);
  const systemDark = useMedia('(prefers-color-scheme: dark)');
  /** Which theme is on screen, whatever chose it — the header button flips from here. */
  const dark = isDark(prefs.theme, systemDark);
  /**
   * The same preferences, reachable from a callback that must not be rebuilt.
   *
   * `scheduleSave` runs on every keystroke and is handed to the editor once;
   * putting `prefs` in its dependency list would tear down and rebuild the
   * editor's change handler every time a slider moved.
   */
  const prefsRef = useRef(prefs);
  const [filesDir, setFilesDir] = useState('');
  /** Which account's keys the admin view is showing. */
  const [keyOwner, setKeyOwner] = useState(user.id);
  const [adminBusy, setAdminBusy] = useState(false);
  const [filesBusy, setFilesBusy] = useState(false);
  const [recents, setRecents] = useState<Recent[]>(() => {
    discardLegacy();
    return loadRecents(user.id);
  });

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

  const client = useQueryClient();

  useEffect(() => {
    prefsRef.current = prefs;
    applyPrefs(prefs);
    savePrefs(prefs);
  }, [prefs]);

  const treeQuery = useTree();
  const tidyQuery = useTidy();
  // Only while it is on screen. It is the most expensive answer the server gives
  // — `attentionCount` alone walks the notes four times — and nothing outside
  // this view needs it now that the nav strip reads tags from the tag list.
  const overviewQuery = useOverview(view === 'overview');
  const sharesQuery = useShares();
  const tagsQuery = useTags();
  const noteQuery = useNote(openRef);
  // The vocabulary `/tag` is allowed to offer, from the vault the open note
  // lives in — a shared note follows its owner's registry, not the reader's.
  const registryQuery = useTagRegistry(view === 'note' ? (openRef?.owner ?? null) : null);
  // The graph feeds both the big network view and the neighbourhood panel beside
  // an open note, so it is wanted in exactly those two places and nowhere else.
  const graphQuery = useGraph(view === 'brain' || view === 'note');
  const filesQuery = useFiles(view === 'files');
  const settingsQuery = useSettings(view === 'settings');
  const topicsQuery = useTopics(view === 'tidy');
  const adminUsersQuery = useAdminUsers(view === 'admin');
  const adminKeysQuery = useAdminKeys(keyOwner, view === 'admin');
  // Built rather than spread with `dir: taskDir` directly: the filter type is
  // properly optional (`dir?: string`), and `exactOptionalPropertyTypes` draws
  // a line between "absent" and "present but undefined" that a plain object
  // literal would cross the moment no folder is picked.
  const taskFilter = useMemo(
    () => (taskDir === undefined ? { includeDone: taskIncludeDone } : { dir: taskDir, includeDone: taskIncludeDone }),
    [taskDir, taskIncludeDone],
  );
  const tasksQuery = useTasks(taskFilter, view === 'tasks');
  const toggleTaskMutation = useToggleTask();

  const notes = treeQuery.data?.notes ?? [];
  const tidy = tidyQuery.data ?? null;
  const tasks = tasksQuery.data ?? null;
  const overview = overviewQuery.data ?? null;
  const granted = sharesQuery.data?.granted ?? [];
  const received = sharesQuery.data?.received ?? [];
  const tags = tagsQuery.data?.tags ?? [];
  const graph = graphQuery.data ?? null;
  const files = filesQuery.data ?? null;
  const open = noteQuery.data ?? null;

  /**
   * The tree's state markers, derived rather than stored.
   *
   * They come from the same findings the tidy view lists, so the two cannot
   * disagree. Tidy answers for the caller's own vault only, so every key carries
   * the caller as the owner — a marker keyed by path alone would light up a note
   * of the same name in a shared vault.
   */
  const findings = useMemo((): Map<string, Finding> => {
    const map = new Map<string, Finding>();
    if (tidy === null) return map;
    // `untagged` is deliberately absent. In a vault where tagging is not a habit
    // it matches nearly every note, and a marker on every row points at nothing.
    for (const row of tidy.stale) map.set(refKey(user.id, row.path), 'warn');
    for (const row of tidy.orphans) map.set(refKey(user.id, row.path), 'crit');
    for (const row of tidy.deadLinks) map.set(refKey(user.id, row.source), 'crit');
    return map;
  }, [tidy, user.id]);

  /** Kept for the handful of places that still ask for everything explicitly. */
  const refreshTree = useCallback(async (): Promise<void> => {
    invalidate.afterStructure(client);
  }, [client]);

  const refreshShares = useCallback(async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: keys.shares });
  }, [client]);

  const refreshOverview = useCallback(async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: keys.overview });
  }, [client]);

  const refreshFiles = useCallback(async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: keys.files });
  }, [client]);

  useEffect(() => {
    void api
      .pulse()
      .then(({ now }) => {
        pulseSince.current = now;
      })
      .catch(() => undefined);
  }, []);


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
      // Cleared only when nothing was typed while the write was in flight —
      // otherwise this would drop text newer than the version just stored.
      if (pending.current === null) window.__ndbrainPending = null;
      setSaveState(pending.current === null ? 'saved' : 'dirty');

      // Somebody else's version was displaced and kept. Reported plainly and
      // left on screen: the text on this screen won, and the other one is only
      // recoverable if the person is told the file exists.
      if (result.conflictCopy !== undefined) {
        setError(
          copy.errors.conflict(result.conflictCopy),
        );
      }

      // An edit can move links, so the panel, the findings and the graph are
      // marked stale. Note what is *not* here: the note list. Notes appear and
      // disappear on create, delete and rename — not when their text changes —
      // and re-reading the whole tree plus a four-scan tidy pass on every pause
      // in typing was pure waste. Marking is also not fetching: a stale query
      // nobody is rendering costs nothing until something asks for it.
      invalidate.afterEdit(client, outstanding.owner, outstanding.path);
      // A newly created note *is* a structural change: the conflict copy above
      // is a new file, and so is a first save of a note typed into the palette.
      if (result.created || result.conflictCopy !== undefined) invalidate.afterStructure(client);
    } catch (caught) {
      setSaveState('failed');
      setError(
        caught instanceof ApiError ? caught.message : copy.errors.saveFailed,
      );
    }
  }, [client]);

  const scheduleSave = useCallback(
    (owner: string, path: string, content: string): void => {
      pending.current = { owner, path, content };
      // Mirrored where the error boundary can still reach it: if a render fault
      // tears this tree down, the boundary is what hands the text back.
      window.__ndbrainPending = { path, content };
      setSaveState('dirty');
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void flush(), prefsRef.current.saveDelayMs);
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
    async (owner: string, path: string, line?: number): Promise<void> => {
      // Never switch away from unsaved text without writing it first.
      if (pending.current !== null) await flush();
      setJumpLine(line ?? null);

      try {
        // Fetched through the cache under this note's own key rather than into
        // one shared `open` slot. That is what removes the race: two quick
        // clicks used to be two responses landing in arrival order, so a slow
        // answer for the note you had already left could overwrite the one you
        // were looking at. Now a late answer updates its own entry and changes
        // nothing on screen.
        const opened = await client.fetchQuery({
          queryKey: keys.note(owner, path),
          queryFn: () => api.getNote(owner, path),
          staleTime: Infinity,
        });
        setOpenRef({ owner, path });
        baseMtime.current = opened.note.mtimeMs;
        setView('note');
        setSaveState('saved');
        setDrawerOpen(false);
        setRevealed(null);
        setError(null);
        pushRecent(user.id, owner, path);
        setRecents(loadRecents(user.id));
      } catch {
        // A note in a share that has just been withdrawn is gone in exactly the
        // same way as a deleted one, and is told so in the same words. There is
        // nothing to distinguish here — that is the point of the design.
        setError(copy.errors.noteGone);
        setOpenRef(null);
        invalidate.afterStructure(client);
      }
    },
    [flush, client, user.id],
  );

  /**
   * Reopens the last note, when that is what the preferences ask for.
   *
   * Guarded by a ref rather than by the dependency list: this must happen once
   * on load and never again, or every later change to the note list would drag
   * somebody back to where they started.
   */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || prefs.startView !== 'note' || notes.length === 0) return;
    restored.current = true;

    const last = loadRecents(user.id)[0];
    if (last === undefined) return;
    if (!notes.some((note) => note.owner === last.owner && note.path === last.path)) return;

    void openNote(last.owner, last.path);
  }, [notes, prefs.startView, openNote, user.id]);

  /**
   * Reloads the open note after a restore.
   *
   * The editor holds the old text and rebuilds only when (owner, path, readOnly)
   * change — which is right while typing and wrong here, since the file on the
   * server has just been replaced underneath it. Dropping the cached note and
   * re-opening is what makes the restored text appear rather than sitting one
   * save away from being overwritten again.
   */
  const reopenAfterRestore = useCallback(async (): Promise<void> => {
    if (openRef === null) return;
    pending.current = null;
    window.__ndbrainPending = null;

    await client.invalidateQueries({ queryKey: keys.note(openRef.owner, openRef.path) });
    setOpenRef(null);
    await openNote(openRef.owner, openRef.path);
    invalidate.afterStructure(client);
  }, [openRef, client, openNote]);

  /**
   * Stores a pasted or dropped file beside the open note.
   *
   * The name is made unique here rather than left to the server: two screenshots
   * pasted a minute apart are both called `image.png` by every operating system,
   * and silently replacing the first one with the second is the worst possible
   * reading of "upload". A short timestamp is enough — this is a file name, not
   * an identifier anything else depends on.
   */
  const attachFile = useCallback(
    async (file: File): Promise<string | null> => {
      if (open === null) return null;

      const dir = open.note.path.slice(0, Math.max(0, open.note.path.lastIndexOf('/')));
      const dot = file.name.lastIndexOf('.');
      // The characters a wikilink target cannot contain, plus the separators.
      // A file whose name breaks `![[…]]` is an embed that silently renders as
      // plain text — see assertLinkableName on the server for the same rule.
      const stem = (dot === -1 ? file.name : file.name.slice(0, dot)).replace(
        /[[\]|#/\\]/g,
        '-',
      );
      const extension = dot === -1 ? '' : file.name.slice(dot).toLowerCase();
      // Seconds, from the note's own clock; enough to separate two pastes and
      // short enough to still read as a file name.
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
      const name = `${stem}-${stamp}${extension}`;

      try {
        await api.uploadFile(open.owner, dir === '' ? name : `${dir}/${name}`, file);
        void client.invalidateQueries({ queryKey: keys.files });
        setError(null);
        return name;
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : copy.errors.attachFailed);
        return null;
      }
    },
    [open, client],
  );

  /**
   * Adds the proposed tags to the notes that were left ticked.
   *
   * Sends paths only. The tags themselves are re-derived on the server, so a
   * proposal this page has been holding for ten minutes cannot write something
   * the note no longer says.
   */
  const applyTopics = useCallback(
    async (paths: string[]): Promise<void> => {
      setBulkBusy(true);
      try {
        const { applied } = await api.applyTopics(paths);
        // Everything that reads tags is now stale: the tree markers, the tag
        // cloud, the untagged finding and the proposal list itself.
        invalidate.afterStructure(client);
        setTopicsDone(applied.length);
        setError(null);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : copy.topics.failed);
      } finally {
        setBulkBusy(false);
      }
    },
    [client],
  );

  /**
   * The admin writes.
   *
   * Each one invalidates the two admin queries rather than patching state: the
   * counts in the account table come from the server, and a list that drifts
   * from what the server thinks is worse on this screen than on any other.
   */
  const adminAct = useCallback(
    async <T,>(run: () => Promise<T>): Promise<T> => {
      setAdminBusy(true);
      try {
        const result = await run();
        await client.invalidateQueries({ queryKey: keys.adminUsers });
        await client.invalidateQueries({ queryKey: ['admin', 'keys'] });
        return result;
      } finally {
        setAdminBusy(false);
      }
    },
    [client],
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
        setError(caught instanceof ApiError ? caught.message : copy.errors.createFailed);
      }
    },
    [openNote, refreshTree],
  );

  // Always in your own vault. Creating into somebody else's shared folder is
  // possible through the dead-link button below, where the folder is implied by
  // the note you are standing in; offering it here would mean a vault picker on
  // the most-used button in the application.
  const createNote = async (): Promise<void> => {
    const name = window.prompt(copy.ask.newNoteName);
    if (name === null) return;
    await createNoteAt(user.id, name);
  };

  const createFolder = async (): Promise<void> => {
    const name = window.prompt(copy.ask.newFolderName);
    if (name === null || name.trim() === '') return;

    try {
      await api.createFolder(name.trim());
      await refreshTree();
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : copy.errors.createFolderFailed);
    }
  };

  /**
   * Renaming a folder moves every note inside it, which is what carries the
   * links along. Reported afterwards rather than silently: moving forty notes
   * and rewriting a dozen files is a big thing to have happen without a word.
   */
  const renameFolder = async (from: string): Promise<void> => {
    const to = window.prompt(copy.ask.renameFolder, from);
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
      setError(caught instanceof ApiError ? caught.message : copy.errors.renameFailed);
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

  /**
   * Deletes one note, after saying what that breaks.
   *
   * The same path for all three places that offer it — the note's header, the
   * tree and the inspector — so the question, the permission and the clean-up
   * cannot drift apart between them.
   *
   * The count of notes that link here is read fresh from the backlinks
   * endpoint, which answers within the caller's own view: a note in a part of
   * somebody's vault the caller cannot see is not counted, and not revealed by
   * the number either. Answers whether the note was deleted.
   */
  const deleteNote = useCallback(
    async (owner: string, path: string, title: string): Promise<boolean> => {
      const typingHere = (): boolean =>
        pending.current !== null && pending.current.owner === owner && pending.current.path === path;
      // Text waiting for a different note is written first, as on any switch.
      if (pending.current !== null && !typingHere()) await flush();

      let linking = 0;
      try {
        const { backlinks } = await client.fetchQuery({
          queryKey: keys.links(owner, path),
          queryFn: () => api.links(owner, path),
          staleTime: 0,
        });
        linking = new Set(backlinks.filter((row) => row.source !== path).map((row) => row.source)).size;
      } catch {
        // Unknown is not zero, but the question still names the note, and the
        // server has the final word on whether it exists at all.
      }

      const question = copy.ask.deleteNote(title) + (linking > 0 ? ` ${copy.ask.linksWillBreak(linking)}` : '');
      if (!window.confirm(question)) return false;

      // Unsaved text in the note being deleted is dropped, not written: a save
      // landing after the delete would bring the note straight back.
      if (typingHere()) {
        pending.current = null;
        window.__ndbrainPending = null;
        if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }

      try {
        await api.deleteNote(owner, path);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : copy.errors.deleteNoteFailed);
        return false;
      }

      dropRecent(user.id, owner, path);
      setRecents(loadRecents(user.id));
      // Off the screen before its cache entry goes: an editor still mounted on
      // a removed entry would fetch it again, and get a 404 for its trouble.
      flushSync(() => {
        setRevealed((current) => (current?.owner === owner && current.path === path ? null : current));
        if (openRef?.owner === owner && openRef.path === path) {
          setOpenRef(null);
          setSaveState('saved');
          if (view === 'note') setView('overview');
        }
      });
      invalidate.afterDelete(client, owner, path);
      setError(null);
      return true;
    },
    [client, flush, openRef, user.id, view],
  );

  /** Whether a note may be deleted from a place that holds only its path. */
  const mayDelete = useCallback(
    (owner: string, path: string): boolean => mayChange(user.id, received, owner, path),
    [user.id, received],
  );

  /**
   * Shows a note in the tree without opening it.
   *
   * The tree has to be on screen for that: full screen is left, a filter that
   * would hide the folders is cleared, a folded sidebar unfolds, and on a
   * phone the drawer slides out over the network.
   */
  const revealNote = useCallback(
    (owner: string, path: string): void => {
      fullscreenRef.current?.leave();
      setTreeFilter('');
      revealSeq.current += 1;
      setRevealed({ owner, path, seq: revealSeq.current });
      if (narrow) setDrawerOpen(true);
      else setPrefs((current) => (current.sidebarCollapsed ? { ...current, sidebarCollapsed: false } : current));
    },
    [narrow],
  );

  const runSearch = useCallback(
    async (value: string, active: Filters): Promise<void> => {
      // A query with only filters is legitimate — "everything tagged #homelab" —
      // so the search runs whenever either part is present.
      const hasFilter = active.tag !== undefined || active.dir !== undefined || active.days !== undefined;
      if (value.trim() === '' && !hasFilter) {
        searchSeq.current += 1; // an in-flight search must not refill the list
        setHits([]);
        return;
      }

      setView('search');
      const seq = (searchSeq.current += 1);
      const { hits: found } = await api.search(value.trim(), active);
      // Answers do not arrive in the order they were asked for. Without this,
      // a slow response for "prox" lands after a fast one for "proxmox" and
      // leaves the wrong results sitting under the right query.
      if (seq !== searchSeq.current) return;
      setHits(found);
    },
    [],
  );

  const onQueryChange = (value: string): void => {
    setQuery(value);
    void runSearch(value, filters).catch(() => setError(copy.errors.searchFailed));
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
    void runSearch(query, next).catch(() => setError(copy.errors.searchFailed));

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

  /**
   * Opens the palette, leaving full screen first.
   *
   * Leaving rather than drawing the palette inside the full-screen frame, for
   * three reasons. Everything the palette does opens a note, which ends the
   * network view and with it full screen anyway. With the platform's full-screen
   * API, Escape belongs to the browser and cannot be intercepted, so closing a
   * palette drawn inside would throw somebody out of full screen as a side
   * effect. And outside, the whole shell is back, header search included.
   */
  const openPalette = useCallback((): void => {
    fullscreenRef.current?.leave();
    setPaletteOpen(true);
  }, []);
  const paletteOpenRef = useRef(paletteOpen);
  paletteOpenRef.current = paletteOpen;

  // ⌘K on a Mac, Ctrl-K elsewhere. Registered on the window so it works while
  // the editor has focus, which is where it will usually be pressed.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (paletteOpenRef.current) setPaletteOpen(false);
        else openPalette();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPalette]);

  useEffect(() => {
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
    const timer = window.setInterval(tick, prefs.pulseMs);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
    // The interval is in the dependencies, so changing it on the settings page
    // restarts the poll at the new rate rather than taking effect on the next
    // view switch.
  }, [view, user.id, prefs.pulseMs]);

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
  /**
   * Uploads a batch, one request per file.
   *
   * Sequential rather than parallel: a vault import can be hundreds of files,
   * and firing them all at once buys nothing on a single-user server while
   * making the failure of one indistinguishable from the failure of the rest.
   */
  const uploadFiles = useCallback(
    async (picked: File[], intoDir: string): Promise<void> => {
      setFilesBusy(true);
      const failed: string[] = [];
      try {
        for (const file of picked) {
          const target = intoDir === '' ? file.name : `${intoDir}/${file.name}`;
          try {
            await api.uploadFile(user.id, target, file);
          } catch (caught) {
            failed.push(`${file.name}: ${caught instanceof ApiError ? caught.message : 'failed'}`);
          }
        }
        await refreshFiles();
        // An uploaded note is a note: the tree and the index have to catch up.
        if (picked.some((file) => file.name.toLowerCase().endsWith('.md'))) await refreshTree();
        setError(failed.length === 0 ? null : copy.errors.importFailed(failed.length, failed[0] ?? ''));
      } finally {
        setFilesBusy(false);
      }
    },
    [refreshFiles, refreshTree, user.id],
  );

  const replaceFile = useCallback(
    async (path: string, file: File): Promise<void> => {
      setFilesBusy(true);
      try {
        await api.uploadFile(user.id, path, file);
        await refreshFiles();
        if (path.toLowerCase().endsWith('.md')) await refreshTree();
        setError(null);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : copy.errors.replaceFailed);
      } finally {
        setFilesBusy(false);
      }
    },
    [refreshFiles, refreshTree, user.id],
  );

  const removeFile = useCallback(
    async (file: FileRow): Promise<void> => {
      const name = file.path.slice(file.path.lastIndexOf('/') + 1);
      if (!window.confirm(copy.ask.deleteFile(name))) return;

      setFilesBusy(true);
      try {
        await api.deleteFile(user.id, file.path);
        await refreshFiles();
        if (file.isNote) {
          await refreshTree();
          // The open note may be the one just deleted.
          if (open !== null && open.note.path === file.path) setOpenRef(null);
        }
        setError(null);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : copy.errors.deleteFileFailed);
      } finally {
        setFilesBusy(false);
      }
    },
    [refreshFiles, refreshTree, user.id, open],
  );

  /**
   * Writes the one setting that lives on the server.
   *
   * Optimistic: the slider has already moved, and waiting for a round trip to
   * confirm what somebody just dragged makes the control feel broken. The reply
   * is authoritative — it comes back clamped — so the cache takes that.
   */
  const saveStaleDays = useCallback(
    async (days: number): Promise<void> => {
      client.setQueryData(keys.settings, { settings: { staleDays: days } });
      try {
        const result = await api.saveSettings({ staleDays: days });
        client.setQueryData(keys.settings, result);
        // The threshold decides what counts as a finding, so everything that
        // reports findings is now out of date.
        void client.invalidateQueries({ queryKey: keys.tidy });
        void client.invalidateQueries({ queryKey: keys.overview });
      } catch {
        void client.invalidateQueries({ queryKey: keys.settings });
        setError(copy.errors.settingsFailed);
      }
    },
    [client],
  );

  const recentRows = useMemo((): NoteRow[] => {
    // Zero means off, and it has to be checked before the loop rather than
    // inside it: the limit was tested *after* pushing, so "show 0" still left
    // exactly one entry — and the heading above it — which is the setting doing
    // visibly nothing at the one value somebody chooses deliberately.
    if (prefs.recentCount <= 0) return [];

    const byKey = new Map(notes.map((note) => [refKey(note.owner, note.path), note]));
    const out: NoteRow[] = [];
    for (const recent of recents) {
      const note = byKey.get(refKey(recent.owner, recent.path));
      if (note === undefined) continue;
      // The open note stays in the list, marked with a point, rather than
      // dropping out while you look at it. A list that reshuffles every time a
      // note is opened is a list nobody can find their way around by position;
      // this one only ever moves the note you just opened to the top.
      out.push(note);
      if (out.length >= prefs.recentCount) break;
    }
    return out;
  }, [recents, notes, prefs.recentCount]);

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
   * Ticks or unticks one task, verified server-side against the exact line it
   * came from — see `App.toggleTask` on the server. A 409 means the note
   * changed since this list was loaded; the list is refreshed so the person
   * sees the real state rather than a checkbox that silently did nothing.
   */
  const toggleTask = async (task: TaskRow): Promise<void> => {
    setTaskBusy(true);
    try {
      await toggleTaskMutation.mutateAsync({ owner: task.owner, task, done: !task.done });
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'task_changed'
          ? copy.errors.taskChanged
          : copy.errors.saveFailed,
      );
      void client.invalidateQueries({ queryKey: keys.tasks(taskFilter) });
    } finally {
      setTaskBusy(false);
    }
  };

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
      const dir = window.prompt(copy.ask.moveTo(paths.length), 'Archive');
      if (dir === null) return;
      extra = { dir };
    } else if (action === 'tag') {
      const tag = window.prompt(copy.ask.tagWith(paths.length));
      if (tag === null || tag.trim() === '') return;
      extra = { tag };
    } else if (!window.confirm(copy.ask.deleteNotes(paths.length))) {
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
      setError(caught instanceof ApiError ? caught.message : copy.errors.bulkFailed);
    } finally {
      setBulkBusy(false);
    }
  };

  // A focus handed over from the home view is used once, on arrival.
  useEffect(() => {
    if (view !== 'tidy') setTidyFocus(null);
  }, [view]);

  const showView = async (next: View): Promise<void> => {
    if (pending.current !== null) await flush();
    if (next === 'overview') await refreshOverview();
    if (next === 'files') await refreshFiles();
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
      setError(caught instanceof ApiError ? caught.message : copy.errors.shareFailed);
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
      setError(caught instanceof ApiError ? caught.message : copy.errors.revokeFailed);
    } finally {
      setShareBusy(false);
    }
  };

  const signOut = async (): Promise<void> => {
    if (pending.current !== null) await flush();
    await api.logout();
    // What this browser kept about the account goes with it — see `end` in
    // `App`, which unmounts this shell before forgetting anything.
    onSignedOut();
  };

  const accountItems: MenuItem[] = [
    { key: 'settings', label: copy.nav.settings, icon: <GearIcon size={16} />, onSelect: () => void showView('settings') },
    { key: 'shares', label: copy.nav.sharing, icon: <ShareIcon size={16} />, onSelect: () => void showView('shares') },
    // Hidden for everybody else, and refused by the server regardless: a menu
    // entry that is not rendered is not a permission.
    ...(user.role === 'admin'
      ? [{ key: 'admin', label: copy.nav.admin, icon: <ShieldIcon size={16} />, onSelect: () => void showView('admin') }]
      : []),
    { key: 'signout', label: copy.nav.signOut, icon: <SignOutIcon size={16} />, onSelect: () => void signOut() },
  ];

  const heading = headingOf();

  const errorBox =
    error === null ? null : (
      <div className="floaterror" role="status">
        <span>{error}</span>
        <button type="button" onClick={() => setError(null)} aria-label={copy.errors.closeMessage}>
          ✕
        </button>
      </div>
    );

  /** The title and the line of numbers under it, for whatever view is on screen. */
  function headingOf(): { title: string; subtitle: string } {
    const sub = copy.shell.sub;
    switch (view) {
      case 'note':
        return open === null
          ? { title: copy.note.none, subtitle: '' }
          : // The same de-prefixed reading as the tree. The literal path is not
            // lost — it is shown in full under "File" in the right column, which
            // is the one place that is *about* the file on disk.
            { title: open.note.title, subtitle: displayPath(open.note.path, prefs.hidePrefixes) };
      case 'overview':
        return {
          title: copy.nav.overview,
          subtitle:
            sub.overview(notes.length, folderCount(notes)) +
            (overview !== null && overview.counts.attention > 0
              ? ` · ${sub.attention(overview.counts.attention)}`
              : ''),
        };
      case 'brain':
        return {
          title: copy.nav.network,
          subtitle:
            graph === null
              ? sub.loading
              : `${sub.network(graph.nodes.length, graph.edges.length)} · ${sub.loose(
                  graph.nodes.filter((n) => n.links === 0).length,
                )}`,
        };
      case 'tidy':
        return {
          title: copy.nav.tidy,
          subtitle:
            tidy === null ? sub.loading : sub.tidy(tidy.totals.orphans, tidy.totals.deadLinks, tidy.totals.stale),
        };
      case 'tasks':
        return { title: copy.nav.tasks, subtitle: tasks === null ? sub.loading : sub.tasks(tasks.total) };
      case 'search':
        return {
          title: copy.nav.search,
          subtitle: query.trim() === '' ? sub.search(notes.length) : sub.results(hits.length, query.trim()),
        };
      case 'files':
        return {
          title: copy.nav.files,
          subtitle: files === null ? sub.loading : sub.files(files.files.length, files.dirs.length),
        };
      case 'settings':
        return { title: copy.nav.settings, subtitle: sub.settings };
      case 'admin':
        return { title: copy.nav.admin, subtitle: sub.admin(adminUsersQuery.data?.users.length ?? 0) };
      case 'shares':
        return { title: copy.nav.sharing, subtitle: sub.shares(granted.length, received.length) };
      default:
        return { title: '', subtitle: '' };
    }
  }

  // Folding applies to the desktop sidebar only. On a phone the sidebar is a
  // drawer, and a folded drawer would be a drawer with nothing in it.
  const collapsed = prefs.sidebarCollapsed && !narrow;

  return (
    <div
      className="app"
      data-drawer={drawerOpen}
      data-wide={view !== 'note'}
      data-collapsed={collapsed}
      data-view={view}
    >
      <Sidebar
        name={user.displayName}
        view={view}
        collapsed={collapsed}
        onToggleCollapsed={() => setPrefs((current) => ({ ...current, sidebarCollapsed: !current.sidebarCollapsed }))}
        onShowView={(next) => {
          setDrawerOpen(false);
          void showView(next);
        }}
        onClose={() => setDrawerOpen(false)}
        filter={treeFilter}
        onFilter={setTreeFilter}
        onJump={openPalette}
        recents={recentRows}
        current={view === 'note' && open !== null ? { owner: open.owner, path: open.note.path } : null}
        onOpen={(owner, path) => void openNote(owner, path)}
        tree={
          <Tree
            notes={notes}
            self={user.id}
            received={received}
            selected={open === null ? null : { owner: open.owner, path: open.note.path }}
            findings={findings}
            filter={treeFilter.trim().toLowerCase()}
            hidePrefixes={prefs.hidePrefixes}
            onSelect={(owner, path) => {
              void openNote(owner, path);
              setDrawerOpen(false);
            }}
            onRenameFolder={(path) => void renameFolder(path)}
            onDeleteNote={(owner, path, title) => void deleteNote(owner, path, title)}
            revealed={revealed}
            onCreateFirst={() => void createNote()}
          />
        }
        health={
          tidy === null
            ? null
            : {
                orphans: tidy.totals.orphans,
                // Withheld while nothing is tagged — see Queries.tagsInUse. Read
                // from the tag list rather than from the overview: it answers the
                // same question, and it is already loaded and far cheaper.
                untagged: tags.length > 0 ? tidy.totals.untagged : null,
                broken: tidy.totals.deadLinks,
              }
        }
        onHealth={() => {
          setDrawerOpen(false);
          void showView('tidy');
        }}
        onNewNote={() => void createNote()}
        onNewFolder={() => void createFolder()}
        onSettings={() => {
          setDrawerOpen(false);
          void showView('settings');
        }}
      />

      <div className="work">
        <Topbar
          title={heading.title}
          subtitle={heading.subtitle}
          extras={
            view === 'note' ? (
              <>
                {open !== null && open.owner !== user.id && (
                  <span className="pill p-info">
                    {open.owner} · {open.canWrite ? copy.note.canWrite : copy.note.readOnly}
                  </span>
                )}
                <SaveIndicator state={saveState} />
                {/* Only where the server said this note may be written: a note
                    read through a read-only share has nothing to offer here. */}
                {open !== null && open.canWrite && (
                  <MenuButton
                    label={copy.note.actions}
                    icon={<MoreIcon />}
                    items={[
                      {
                        key: 'delete',
                        label: copy.note.delete,
                        icon: <TrashIcon size={16} />,
                        danger: true,
                        onSelect: () => void deleteNote(open.owner, open.note.path, open.note.title),
                      },
                    ]}
                  />
                )}
              </>
            ) : undefined
          }
          dark={dark}
          accountName={user.displayName}
          accountItems={accountItems}
          onMenu={() => setDrawerOpen((o) => !o)}
          onSearch={openPalette}
          onToggleTheme={() => setPrefs((current) => ({ ...current, theme: dark ? 'light' : 'dark' }))}
        />

        <div className="stage">
          <main className="main">
            {/* In full screen only the network frame is visible, so a message
                raised there — a note that could not be opened — is drawn in it. */}
            {error !== null &&
              (fullscreen === null ? errorBox : createPortal(errorBox, fullscreen.host))}

            <div className="main-body">
              {view === 'note' &&
                (open === null ? (
                  <p className="empty" style={{ padding: '2rem' }}>
                    {copy.note.pickOne.before}
                    <kbd>{copy.note.paletteKey}</kbd>
                    {copy.note.pickOne.after}
                  </p>
                ) : (
                  <Editor
                    owner={open.owner}
                    path={open.note.path}
                    initialContent={open.note.content}
                    readOnly={!open.canWrite}
                    tags={registryQuery.data ?? null}
                    line={jumpLine ?? undefined}
                    onChange={(content) => scheduleSave(open.owner, open.note.path, content)}
                    onAttach={attachFile}
                  />
                ))}

              {view === 'overview' && overview === null && (
                /* Shaped like what is coming. A skeleton that does not match the
                   final layout adds to the jank instead of covering it. */
                <div className="pane padded" aria-busy="true" aria-label={copy.overview.title}>
                  <div className="skel skel-row" style={{ width: '9rem', height: 26 }} />
                  <div className="skel skel-row" style={{ width: '14rem' }} />
                  <div className="bento" style={{ marginTop: 'var(--s-4)' }}>
                    <div className="skel skel-tile tile-wide" />
                    <div className="skel skel-tile" />
                    <div className="skel skel-tile" />
                    <div className="skel skel-tile" />
                  </div>
                </div>
              )}

              {view === 'overview' && overview !== null && (
                <HomeView
                  overview={overview}
                  self={user.id}
                  ownNotes={notes.filter((note) => note.owner === user.id).length}
                  recents={recentRows}
                  hidePrefixes={prefs.hidePrefixes}
                  onOpen={(owner, path) => void openNote(owner, path)}
                  onTasks={() => void showView('tasks')}
                  onTidy={(focus) => {
                    setTidyFocus(focus ?? null);
                    void showView('tidy');
                  }}
                  onNetwork={() => void showView('brain')}
                />
              )}

              {view === 'brain' &&
                (graph === null ? (
                  <p className="empty" style={{ padding: '2rem' }}>{copy.overview.loadingGraph}</p>
                ) : (
                  <NetworkFrame
                    graph={graph}
                    events={pulse}
                    account={user.id}
                    hidePrefixes={prefs.hidePrefixes}
                    view={prefs.networkView}
                    onView={(networkView) => setPrefs((current) => ({ ...current, networkView }))}
                    onOpen={(owner, path) => void openNote(owner, path)}
                    onFullscreen={setFullscreen}
                    onReveal={revealNote}
                    onDelete={deleteNote}
                    mayDelete={mayDelete}
                  />
                ))}

              {view === 'tidy' && (
                <>
                  {topicsDone !== null && (
                    <p className="warnline" role="status">{copy.topics.done(topicsDone)}</p>
                  )}
                  <TopicsPanel
                    proposals={topicsQuery.data?.proposals ?? []}
                    busy={bulkBusy}
                    onApply={(paths) => void applyTopics(paths)}
                  />
                </>
              )}

              {view === 'tidy' && tidy !== null && (
                <TidyView
                  data={tidy}
                  selected={selection}
                  busy={bulkBusy}
                  tags={tags}
                  dirs={topLevelDirs(notes)}
                  // Tags in use is read from the tag list, as the sidebar does; the
                  // score does not depend on it, only the wording of an empty line.
                  health={{ notes: notes.filter((note) => note.owner === user.id).length, tagsInUse: tags.length > 0 }}
                  initialFocus={tidyFocus}
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

              {view === 'tasks' && tasks !== null && (
                <TasksView
                  data={tasks}
                  dirs={topLevelDirs(notes)}
                  dir={taskDir}
                  includeDone={taskIncludeDone}
                  self={user.id}
                  busy={taskBusy}
                  onDir={setTaskDir}
                  onIncludeDone={setTaskIncludeDone}
                  onToggle={(task) => void toggleTask(task)}
                  onOpen={(owner, path, line) => void openNote(owner, path, line)}
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

              {view === 'files' &&
                (files === null ? (
                  <p className="empty" style={{ padding: '2rem' }}>{copy.files.reading}</p>
                ) : (
                  <FilesView
                    files={files.files}
                    dirs={files.dirs}
                    truncated={files.truncated}
                    owner={user.id}
                    busy={filesBusy}
                    dir={filesDir}
                    onDir={setFilesDir}
                    onUpload={(picked, intoDir) => void uploadFiles(picked, intoDir)}
                    onReplace={(path, file) => void replaceFile(path, file)}
                    onDelete={(file) => void removeFile(file)}
                    onOpenNote={(path) => void openNote(user.id, path)}
                  />
                ))}

              {view === 'admin' && (
                <AdminView
                  users={adminUsersQuery.data?.users ?? []}
                  keys={adminKeysQuery.data?.keys ?? []}
                  self={user.id}
                  busy={adminBusy}
                  keyOwner={keyOwner}
                  onPickOwner={setKeyOwner}
                  onCreateUser={(id, password, displayName, admin) =>
                    adminAct(() => api.createUser(id, password, displayName, admin ? 'admin' : 'user')).then(
                      () => undefined,
                    )
                  }
                  onResetPassword={(id, password) =>
                    adminAct(() => api.adminSetPassword(id, password)).then(() => undefined)
                  }
                  onSetDisabled={(id, disabled) =>
                    adminAct(() => api.adminSetDisabled(id, disabled)).then(() => undefined)
                  }
                  onCreateKey={(owner, name, scope, canWrite) =>
                    adminAct(() => api.createKey(owner, name, scope, canWrite))
                  }
                  onRevokeKey={(id) => adminAct(() => api.revokeKey(id)).then(() => undefined)}
                />
              )}

              {view === 'settings' && (
                <SettingsView
                  prefs={prefs}
                  onPrefs={setPrefs}
                  staleDays={settingsQuery.data?.settings.staleDays ?? null}
                  onStaleDays={(days) => void saveStaleDays(days)}
                  user={user}
                  onSignedOutEverywhere={() => setError(null)}
                  onRenamed={() => {
                    // The sidebar greets you by this name, so it changes with it
                    // rather than at the next reload.
                    void api.me().then(({ user: me }) => onUserChanged(me)).catch(() => undefined);
                  }}
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
            <aside
              className="side"
              aria-label={copy.note.aboutOpen}
              data-graph={local === null || local.nodes.length <= 1 ? 'empty' : 'has'}
            >
              <div className="side-info">
                <ContextPanel
                  note={{ owner: open.owner, path: open.note.path }}
                  self={user.id}
                  canCreate={open.canWrite}
                  onRestored={() => void reopenAfterRestore()}
                  onOpen={(owner, path) => void openNote(owner, path)}
                  onCreate={(target) => void createFromDeadLink(target)}
                />
              </div>

              <div className="side-graph">
                <div className="side-graph-head">
                  <span>{copy.note.neighbourhood}</span>
                  <button type="button" onClick={() => void showView('brain')} title={copy.note.showWholeNetwork}>
                    {copy.note.wholeNetwork}
                  </button>
                </div>
                {local === null ? (
                  <p className="empty small">{copy.note.loadingNeighbourhood}</p>
                ) : local.nodes.length <= 1 ? (
                  <p className="empty small">
                    {copy.note.noLinksYet.before}
                    <code>{copy.note.linkSyntax}</code>
                    {copy.note.noLinksYet.after}
                  </p>
                ) : (
                  <Brain
                    data={local}
                    events={pulse}
                    onOpen={(owner, path) => void openNote(owner, path)}
                    view={refKey(open.owner, open.note.path)}
                    arrangement="loose"
                  />
                )}
              </div>
            </aside>
          )}
        </div>
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

/** How many distinct folders the notes live in, at any depth. */
function folderCount(notes: NoteRow[]): number {
  const dirs = new Set<string>();
  for (const note of notes) {
    const segments = note.path.split('/');
    segments.pop();
    for (let i = 1; i <= segments.length; i += 1) dirs.add(`${note.owner}\u0000${segments.slice(0, i).join('/')}`);
  }
  return dirs.size;
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
    saved: copy.save.saved,
    dirty: copy.save.dirty,
    saving: copy.save.saving,
    failed: copy.save.failed,
  }[state];

  return (
    <span className={`saved ${state === 'saved' ? '' : state}`} role="status">
      <i />
      {label}
    </span>
  );
}
