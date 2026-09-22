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
  type ShareKind,
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
import { FileIcon, GearIcon, MoreIcon, PencilIcon, ShareIcon, ShieldIcon, SignOutIcon, TrashIcon } from './icons';
import { NetworkFrame, type FullscreenFrame } from './NetworkFrame';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { MenuButton, type MenuItem } from './Menu';
import { mayChange, mayChangeFolder, mayShare } from './rights';
import { OwnersContext, ownerDirectory, ownerKind, ownerLabel } from './owners';
import { ShareDialog, type ShareTarget } from './ShareDialog';
import { RenameDialog, vaultFolders, type RenameTarget } from './RenameDialog';
import { SettingsView } from './Settings';
import { AdminView } from './Admin';
import { TopicsPanel } from './Topics';
import { FilesView } from './Files';
import { Login } from './Login';
import { Palette, type PaletteCommand } from './Palette';
import { JournalView } from './Journal';
import {
  dailyNoteTemplate,
  isoDate,
  journalDays as journalDaysOf,
  journalPath,
  localDate,
  NOTES_SECTION,
  parseJournalLinkTarget,
  parseJournalPath,
  sameDate,
  type JournalDate,
} from './daily';
import { Tree, displayPath, type Finding } from './Tree';
import { lineOfHit } from './snippet';
import { SearchView, SharesView, TasksView, TidyView } from './Views';
import { RecentlyDeleted } from './RecentlyDeleted';
import { OfflineBar, Trouble } from './Trouble';
import { HomeView } from './Home';
import type { HealthKey } from './healthScore';
import {
  invalidate,
  keys,
  useSettings,
  useAdminUsers,
  useAdminKeys,
  useAdminSpaces,
  useTopics,
  useFiles,
  useGraph,
  useNote,
  useOverview,
  useShares,
  useTagRegistry,
  useTags,
  useTasks,
  useSaveNote,
  useTidy,
  useToggleTask,
  useTree,
  troubleOf,
  useOnline,
} from './queries';
import { useNoteBuffer, type SaveState } from './useNoteBuffer';

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
  | 'journal'
  | 'brain'
  | 'tidy'
  | 'search'
  | 'shares'
  | 'files'
  | 'settings'
  | 'admin';


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
  /**
   * Whether the sign-in form on screen is there because a session ended.
   *
   * The shell is gone by the time the form renders, so the form is the only
   * place left that can say what happened — and without it, an expired cookie
   * is indistinguishable from a first visit. Kept out of `user`, which answers
   * a different question and is `null` in both cases.
   */
  const [expired, setExpired] = useState(false);
  const client = useQueryClient();
  /** The signed-in account as of now, for listeners registered once. */
  const userRef = useRef<User | null>(null);

  const begin = useCallback((next: User): void => {
    openSession(next.id);
    userRef.current = next;
    setUser(next);
    setExpired(false);
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
    (announce: boolean, why: 'asked' | 'expired' = 'asked'): void => {
      const previous = userRef.current;
      if (previous === null) return;
      userRef.current = null;
      // Before the shell is torn down, so the form that replaces it renders
      // with the reason already in hand rather than a frame later.
      setExpired(why === 'expired');
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
  useEffect(() => onUnauthenticated(() => end(false, 'expired')), [end]);

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
        expired={expired}
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
  /** The view on screen as of the last render, for the same reason as `openNow`. */
  const viewNow = useRef(view);
  viewNow.current = view;
  /** Where to place the cursor on the next open — a task's line, or nowhere. */
  const [jumpLine, setJumpLine] = useState<number | null>(null);
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
  /** The note the share dialog is open for, or null. */
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  /** The note the rename dialog is open for, or null. */
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [props, setProps] = useState<Array<{ key: string; count: number }>>([]);
  const [propValues, setPropValues] = useState<Array<{ value: string; count: number }>>([]);
  const [pulse, setPulse] = useState<PulseEvent[]>([]);
  /** The server's timestamp to ask from next time. */
  const pulseSince = useRef<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  /** On a narrow screen the tree overlays the page rather than keeping a column. */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [treeFilter, setTreeFilter] = useState('');
  /** The view a navigation is on its way to, while it waits for what it needs. */
  const [arriving, setArriving] = useState<View | null>(null);
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
  const [filesDir, setFilesDir] = useState('');
  /** Whose files the browser shows: the caller's own vault, or a space's. */
  const [filesOwner, setFilesOwner] = useState(user.id);
  /** Which account's keys the admin view is showing. */
  const [keyOwner, setKeyOwner] = useState(user.id);
  const [adminBusy, setAdminBusy] = useState(false);
  const [filesBusy, setFilesBusy] = useState(false);
  const [recents, setRecents] = useState<Recent[]>(() => {
    discardLegacy();
    return loadRecents(user.id);
  });

  const client = useQueryClient();
  const saveNoteMutation = useSaveNote();
  /**
   * The write itself, reachable from a callback that must not be rebuilt.
   *
   * `createNoteAt` is handed to the tree and to the palette; taking the
   * mutation object as a dependency would rebuild it on every render.
   */
  const saveNote = useRef(saveNoteMutation.mutateAsync);
  saveNote.current = saveNoteMutation.mutateAsync;
  /**
   * The editor's buffer and everything that gets its text onto the disk.
   *
   * The promise that typed text does not go missing is kept in `useNoteBuffer`
   * and nowhere else: the debounce, the retry, the version each write claims as
   * its base, the hold a delete puts on a note, and the handlers that ask on the
   * way out whether anything is still owed. What is left here is the screen
   * around it — which note the tree highlights, which view is on, what the
   * header says.
   */
  const {
    openRef,
    openNow,
    setOpenRef,
    saveState,
    deletingKeys,
    hasPending,
    scheduleSave,
    flush,
    settle,
    opened,
    closed,
    forget,
    discard,
    beginDelete,
    holdsTextFor,
    releaseDelete,
    finishDelete,
  } = useNoteBuffer({
    save: saveNoteMutation.mutateAsync,
    saveDelayMs: prefs.saveDelayMs,
    onError: setError,
  });

  useEffect(() => {
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
  const filesQuery = useFiles(view === 'files', filesOwner === user.id ? undefined : filesOwner);
  const settingsQuery = useSettings(view === 'settings');
  const topicsQuery = useTopics(view === 'tidy');
  const isAdmin = user.role === 'admin';
  // Also while the share dialog is open, for its list of people: only an
  // administrator can ask the server who has an account.
  const adminUsersQuery = useAdminUsers(isAdmin && (view === 'admin' || shareTarget !== null));
  const adminSpacesQuery = useAdminSpaces(isAdmin && view === 'admin');
  const adminKeysQuery = useAdminKeys(keyOwner, isAdmin && view === 'admin');
  // Built rather than spread with `dir: taskDir` directly: the filter type is
  // properly optional (`dir?: string`), and `exactOptionalPropertyTypes` draws
  // a line between "absent" and "present but undefined" that a plain object
  // literal would cross the moment no folder is picked.
  const taskFilter = useMemo(
    () => (taskDir === undefined ? { includeDone: taskIncludeDone } : { dir: taskDir, includeDone: taskIncludeDone }),
    [taskDir, taskIncludeDone],
  );
  // Tasks sit beside the calendar, so they are wanted exactly while the journal is.
  const tasksQuery = useTasks(taskFilter, view === 'journal');
  const toggleTaskMutation = useToggleTask();

  /**
   * Whether the browser can reach the server at all.
   *
   * Subscribed to here, at the top of the shell, because every `troubleOf`
   * below depends on it: without the subscription the connection could come
   * back and nothing on screen would notice until something else re-rendered.
   */
  const online = useOnline();

  /**
   * Why each view has nothing to show, when the reason is not "nothing to show".
   *
   * This is the whole point of the exercise. `treeQuery.data?.notes ?? []`
   * turns a failed request into an empty vault, and every one of these lines
   * used to do that: an empty list, an empty pane, a header counting zero. The
   * `??` stays — a view still needs something to map over — but nothing draws
   * an empty state without asking here first.
   */
  const treeTrouble = troubleOf(treeQuery, online);
  const tidyTrouble = troubleOf(tidyQuery, online);
  const overviewTrouble = troubleOf(overviewQuery, online);
  const graphTrouble = troubleOf(graphQuery, online);
  const filesTrouble = troubleOf(filesQuery, online);
  const sharesTrouble = troubleOf(sharesQuery, online);
  const tasksTrouble = troubleOf(tasksQuery, online);

  /** Asks one query again, from the message that said it had failed. */
  const askAgain = useCallback(
    (key: readonly unknown[]): void => {
      void client.refetchQueries({ queryKey: key });
    },
    [client],
  );

  const notes = treeQuery.data?.notes ?? [];
  /** Which vaults are spaces, and what they are called; from the tree reply. */
  const owners = useMemo(() => ownerDirectory(treeQuery.data?.owners), [treeQuery.data]);
  /** The days with a daily note, read off the tree: no request of their own. */
  const journalDays = useMemo(() => journalDaysOf(notes, user.id), [notes, user.id]);
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

  const openNote = useCallback(
    /**
     * `line` is where to put the cursor: a number when the caller knows it,
     * or a function of the note's text when it can only be found in there —
     * the palette knows the words it matched, not the line they are on.
     */
    async (owner: string, path: string, line?: number | ((content: string) => number | undefined)): Promise<void> => {
      // Never switch away from unsaved text without writing it first — and
      // never read a note while a write is still on its way: the read would
      // show the text from before it.
      await settle();
      setJumpLine(typeof line === 'number' ? line : null);

      try {
        // Fetched through the cache under this note's own key rather than into
        // one shared `open` slot. That is what removes the race: two quick
        // clicks used to be two responses landing in arrival order, so a slow
        // answer for the note you had already left could overwrite the one you
        // were looking at. Now a late answer updates its own entry and changes
        // nothing on screen.
        //
        // Always read afresh, even though a save now writes its result back
        // into this entry. The write-back only covers what *this* tab wrote:
        // the file can also have moved on under another tab, an agent through
        // MCP or an editor on the disk, and with `staleTime: Infinity` a note
        // reopened within the cache's garbage-collection time would come back
        // as the text it had when it was first opened — the next keystroke then
        // saving that old text over the newer file, which the server has to
        // keep as a conflict copy. Pending text is flushed above, so nothing of
        // this tab's is lost by reading the server's version.
        const fresh = await client.fetchQuery({
          queryKey: keys.note(owner, path),
          queryFn: () => api.getNote(owner, path),
          staleTime: 0,
        });
        if (typeof line === 'function') setJumpLine(line(fresh.note.content) ?? null);
        // The buffer takes this note: it is the one on screen, and the version
        // just read is the base its writes will claim.
        opened(owner, path, fresh.note.hash);
        setView('note');
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
    [settle, client, user.id, setOpenRef, opened],
  );

  /**
   * Opens a day's daily note, creating it first if it is not there.
   *
   * Always in the caller's own vault. A daily note is personal by definition,
   * and a share that happens to include somebody's `50_Journal` is not an
   * invitation to start their day for them — nothing here takes an owner.
   *
   * Idempotent where it has to be, on the server: `ensureNote` creates the note
   * only if it is absent and otherwise hands back what is there, so a double
   * click, the shortcut pressed alongside the button, or a second tab can never
   * overwrite the note or leave a conflict copy. The in-flight map only saves
   * the duplicate request within this tab; correctness does not depend on it.
   *
   * The tree is consulted first so that opening an existing day costs no write
   * request, but it is never trusted to say a day is missing: it may be a few
   * seconds old, which is precisely the window the server-side check covers.
   */
  const dailyInFlight = useRef(new Map<string, Promise<void>>());
  const openDay = useCallback(
    (date: JournalDate): Promise<void> => {
      const path = journalPath(date);
      const running = dailyInFlight.current.get(path);
      if (running !== undefined) return running;

      const run = (async (): Promise<void> => {
        fullscreenRef.current?.leave();
        if (hasPending()) await flush();

        const known = notes.some((note) => note.owner === user.id && note.path === path);
        if (!known) {
          try {
            const result = await api.ensureNote(user.id, path, dailyNoteTemplate(date));
            if (result.created) invalidate.afterStructure(client);
          } catch (caught) {
            setError(caught instanceof ApiError ? caught.message : copy.journal.failed);
            return;
          }
        }
        await openNote(user.id, path);
      })();

      dailyInFlight.current.set(path, run);
      void run.finally(() => dailyInFlight.current.delete(path));
      return run;
    },
    [notes, user.id, hasPending, flush, client, openNote],
  );

  /** Today by the device's clock, read at the moment of asking — never cached across midnight. */
  const openToday = useCallback((): Promise<void> => openDay(localDate(new Date())), [openDay]);

  /**
   * Adds a thought to today's note without opening it.
   *
   * One request, and the whole read-modify-write happens on the server inside
   * the note's write lock — see `NoteService.appendNote`. Doing it here as
   * "read the note, splice, write it back" would be the mistake this endpoint
   * exists to avoid: the note it writes to is the one most likely to be open
   * elsewhere, and two thoughts captured quickly would cost one of them.
   *
   * Everything outstanding is written first. A capture does not leave the start
   * page, so the editor is not mounted, but this tab may still owe the server
   * text typed into today's note before coming here; flushing it now means the
   * append lands after it rather than racing an autosave into a conflict copy.
   *
   * The date is read at the moment of asking, like `openToday`: a tab left open
   * over midnight must capture into the new day, not the one it was loaded on.
   *
   * Nothing is caught here. The field is what keeps the text when this fails,
   * and it can only do that if the failure reaches it.
   */
  const captureToday = useCallback(
    async (thought: string): Promise<void> => {
      await settle();

      const date = localDate(new Date());
      const path = journalPath(date);
      const result = await api.append(user.id, path, thought, {
        section: NOTES_SECTION,
        ifAbsent: dailyNoteTemplate(date),
      });

      if (result.created) invalidate.afterStructure(client);
      else invalidate.afterEdit(client, user.id, path);
      // The note's text on the server has changed. Marked stale rather than
      // re-read: nothing is rendering it from here, and the next open fetches
      // it fresh instead of showing a version without what was just captured.
      void client.invalidateQueries({ queryKey: keys.note(user.id, path) });
    },
    [settle, user.id, client],
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
    discard();

    await client.invalidateQueries({ queryKey: keys.note(openRef.owner, openRef.path) });
    setOpenRef(null);
    await openNote(openRef.owner, openRef.path);
    invalidate.afterStructure(client);
  }, [openRef, client, openNote, discard]);

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
        // Accounts, keys, spaces and their members: one prefix for all of them.
        await client.invalidateQueries({ queryKey: ['admin'] });
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
        // The same mutation the editor saves through: a create is a write like
        // any other, and it is the mutation that says what a write invalidates.
        await saveNote.current({ owner, path, content: `# ${title}\n\n` });
        await openNote(owner, path);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : copy.errors.createFailed);
      }
    },
    [openNote],
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

    // Same guard as `renameNote`, for the operation that moves many notes at
    // once: a save still in flight belongs to the path it was typed at, and one
    // that overtakes the move lands there and creates the note again.
    await settle();

    try {
      const result = await api.renameFolder(from, to.trim());
      await refreshTree();
      setError(
        copy.renameFolder.done(
          from,
          result.folder,
          result.movedNotes.length,
          result.movedFiles.length,
          result.updatedLinks.length,
        ) + (result.failed.length > 0 ? copy.renameFolder.leftBehind(result.failed) : ''),
      );
      // The open note may have moved with the folder — but only if it really
      // did. A folder move carries on past what it cannot take, and following
      // it to a path nothing arrived at would answer with a missing note.
      if (open !== null && open.owner === user.id && open.note.path.startsWith(`${from}/`)) {
        const moved = `${result.folder}${open.note.path.slice(from.length)}`;
        if (result.movedNotes.includes(moved)) await openNote(user.id, moved);
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : copy.errors.renameFailed);
    }
  };

  /**
   * Renames or moves one note.
   *
   * One operation, because the server has one: `POST /api/v1/rename` takes a
   * whole path, and a path whose folder differs is a move. The dialog collects
   * it; this runs it and repairs what the old path is remembered by.
   *
   * Refusals are left to throw. The dialog is still on screen and is where a
   * taken name can be corrected — sending the person back to the note to start
   * again would be the prompt's behaviour, not a dialog's.
   */
  const renameNote = useCallback(
    async (owner: string, from: string, to: string): Promise<void> => {
      // Unsaved text belongs to the note at the path it was typed at. Written
      // first, and waited for: a save that overtook the rename would land at
      // the old path and create the note there again. Every operation that
      // moves or removes a note under the editor does this — `openNote`,
      // `showView`, `signOut`, `renameFolder`, `runBulk`, `removeFile`.
      await settle();

      const result = await api.rename(owner, from, to);
      const at = result.note.path;

      // The open note follows rather than pointing at a path that is gone.
      // Before the caches are cleared, so nothing re-reads the old path in
      // between and shows the note as missing for a frame.
      if (openNow.current?.owner === owner && openNow.current.path === from) {
        await openNote(owner, at);
      }

      // What the old path was remembered by goes with it: its version, its
      // place in the recents, and everything that listed it. The same clean-up
      // a delete does, for the same reason — nothing lives at that path now.
      forget(owner, from);
      dropRecent(user.id, owner, from);
      setRecents(loadRecents(user.id));
      invalidate.afterDelete(client, owner, from);

      // Said last: `openNote` clears the message on its way through, and this
      // is the sentence worth keeping. The link count is the whole point of
      // renaming here rather than in a file manager.
      setError(copy.renameNote.done(at, result.updatedLinks.length));
    },
    [settle, openNote, client, user.id, forget, openNow],
  );

  const openRename = useCallback((owner: string, path: string, title: string): void => {
    setRenameTarget({ owner, path, title });
  }, []);

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
    // A daily note's link to a day not written yet starts that day's note, from
    // the template and in the journal — not an empty note named after the link
    // beside this one. Only in your own journal; see `openDay`.
    const day = parseJournalLinkTarget(target);
    if (day !== null && parseJournalPath(open.note.path) !== null) {
      // Somebody else's day is theirs to start; a plain note named after the
      // link would only land nested inside their journal.
      if (open.owner === user.id) await openDay(day);
      return;
    }
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
      // One delete of a note at a time, and nothing writes to the note from
      // here on: the buffer takes it out of reach and keeps whatever was typed
      // into it in a slot of its own. A double click or a second ⌘⌫ is refused
      // before anything is awaited — the second one's cancel used to release
      // the note while the first delete ran.
      if (!beginDelete(owner, path)) return false;
      // Text waiting for a different note is written first, as on any switch,
      // and a write of this one that is already running is let finish.
      await settle();

      // Asked side by side: the links it breaks, and whether it can come back.
      const [linking, preview] = await Promise.all([
        client
          .fetchQuery({ queryKey: keys.links(owner, path), queryFn: () => api.links(owner, path), staleTime: 0 })
          .then(({ backlinks }) => new Set(backlinks.filter((row) => row.source !== path).map((row) => row.source)).size)
          // Unknown is not zero, but the question still names the note, and the
          // server has the final word on whether it exists at all.
          .catch(() => 0),
        // Unknown says nothing about the way back rather than something untrue.
        api.deletePreview(owner, [path]).catch(() => null),
      ]);
      const afterwards = copy.ask.afterDelete(preview);

      const question =
        copy.ask.deleteNote(title) +
        (afterwards !== '' ? ` ${afterwards}` : '') +
        (linking > 0 ? ` ${copy.ask.linksWillBreak(linking)}` : '') +
        (holdsTextFor(owner, path) ? ` ${copy.ask.unsavedDropped}` : '');
      if (!window.confirm(question)) {
        releaseDelete(owner, path);
        return false;
      }

      try {
        await api.deleteNote(owner, path);
      } catch (caught) {
        // Still there, so its unsaved text is still worth saving.
        releaseDelete(owner, path);
        setError(caught instanceof ApiError ? caught.message : copy.errors.deleteNoteFailed);
        return false;
      }

      finishDelete(owner, path);

      dropRecent(user.id, owner, path);
      setRecents(loadRecents(user.id));
      // Off the screen before its cache entry goes: an editor still mounted on
      // a removed entry would fetch it again, and get a 404 for its trouble.
      // What is open *now*: a note opened while the delete ran stays open.
      flushSync(() => {
        setRevealed((current) => (current?.owner === owner && current.path === path ? null : current));
        if (openNow.current?.owner === owner && openNow.current.path === path) {
          closed();
          if (viewNow.current === 'note') setView('overview');
        }
      });
      invalidate.afterDelete(client, owner, path);
      setError(null);
      return true;
    },
    [client, settle, user.id, beginDelete, holdsTextFor, releaseDelete, finishDelete, closed, openNow],
  );

  /**
   * The vaults the file browser offers: the caller's own, then every space the
   * caller holds a membership in, by display name. A space that has gone (a
   * membership withdrawn, the space disabled) sends the browser back home.
   */
  const filesVaults = useMemo(
    () => [
      { id: user.id, label: user.id, space: false },
      ...[...owners.values()]
        .filter((owner) => owner.kind === 'space')
        .map((owner) => ({ id: owner.id, label: ownerLabel(owners, owner.id), space: true }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ],
    [owners, user.id],
  );
  useEffect(() => {
    if (treeQuery.data !== undefined && !filesVaults.some((vault) => vault.id === filesOwner)) setFilesOwner(user.id);
  }, [filesVaults, filesOwner, user.id, treeQuery.data]);

  /** Whether the caller may open the share dialog on notes of this vault. */
  const mayShareNote = useCallback(
    (owner: string): boolean => mayShare(user, owner, ownerKind(owners, owner)),
    [user, owners],
  );

  const openShare = useCallback((owner: string, path: string, title: string): void => {
    setShareTarget({ owner, path, title });
  }, []);

  /** Account names worth offering in the share dialog; any other name can be typed. */
  const people = useMemo((): string[] => {
    const names = new Set<string>();
    for (const share of granted) names.add(share.grantee);
    for (const share of received) if (ownerKind(owners, share.owner) === 'person') names.add(share.owner);
    for (const account of adminUsersQuery.data?.users ?? []) {
      if (ownerKind(owners, account.id) === 'person' && !account.disabled) names.add(account.id);
    }
    names.delete(user.id);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [granted, received, owners, adminUsersQuery.data, user.id]);

  /**
   * Starts a note in a space.
   *
   * Never a daily note and never a vault picker on the main button: this is
   * reached from the space's own header, and only where some share on it may
   * write. The name typed may still land outside the writable part (a member
   * who may write in one folder only), which is said here before anything is
   * sent — the server refuses it regardless.
   */
  const createInSpace = async (owner: string): Promise<void> => {
    const label = ownerLabel(owners, owner);
    const name = window.prompt(copy.ask.newNoteIn(label));
    if (name === null || name.trim() === '') return;
    const trimmed = name.trim();
    const path = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
    if (!mayChange(user.id, received, owner, path)) {
      setError(copy.errors.noWriteHere(label));
      return;
    }
    await createNoteAt(owner, trimmed);
  };

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

  // ⌘⇧D (Ctrl-Shift-D elsewhere) opens today's note. Plain ⌘D is the
  // browser's bookmark and the editor's "select next occurrence", so the shift
  // is what keeps this clear of both; the browsers' own ⌘⇧D (bookmark all tabs,
  // or Safari's reading list) is taken over while the app has focus.
  const openTodayRef = useRef(openToday);
  openTodayRef.current = openToday;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'd' && event.code !== 'KeyD') return;
      event.preventDefault();
      setPaletteOpen(false);
      void openTodayRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
    // While writing too: the neighbourhood in the right column lights up with it.
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
            await api.uploadFile(filesOwner, target, file);
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
    [refreshFiles, refreshTree, filesOwner],
  );

  const replaceFile = useCallback(
    async (path: string, file: File): Promise<void> => {
      setFilesBusy(true);
      try {
        await api.uploadFile(filesOwner, path, file);
        await refreshFiles();
        if (path.toLowerCase().endsWith('.md')) await refreshTree();
        setError(null);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : copy.errors.replaceFailed);
      } finally {
        setFilesBusy(false);
      }
    },
    [refreshFiles, refreshTree, filesOwner],
  );

  const removeFile = useCallback(
    async (file: FileRow): Promise<void> => {
      const name = file.path.slice(file.path.lastIndexOf('/') + 1);
      if (!window.confirm(copy.ask.deleteFile(name))) return;

      // A file list holds notes too, and the one being removed can be the one
      // open in the editor. Saving first means the delete is the last word.
      await settle();

      setFilesBusy(true);
      try {
        await api.deleteFile(filesOwner, file.path);
        await refreshFiles();
        if (file.isNote) {
          await refreshTree();
          // The open note may be the one just deleted.
          if (open !== null && open.owner === filesOwner && open.note.path === file.path) setOpenRef(null);
        }
        setError(null);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : copy.errors.deleteFileFailed);
      } finally {
        setFilesBusy(false);
      }
    },
    [refreshFiles, refreshTree, filesOwner, open, setOpenRef],
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
    const neighbours = new Set<string>([me]);
    for (const e of graph.edges) {
      const from = `${e.owner} ${e.from}`;
      const to = `${e.owner} ${e.to}`;
      if (from === me) neighbours.add(to);
      if (to === me) neighbours.add(from);
    }

    return {
      nodes: graph.nodes.filter((n) => neighbours.has(`${n.owner} ${n.path}`)),
      // Edges *between* the neighbours too: they say whether the surroundings
      // are a web or only a star around this one note.
      edges: graph.edges.filter(
        (e) => neighbours.has(`${e.owner} ${e.from}`) && neighbours.has(`${e.owner} ${e.to}`),
      ),
    };
  }, [graph, open]);

  /**
   * Where the rename dialog may move the note to: the folders of the vault it
   * lives in, plus that vault's root, narrowed to the ones the caller may
   * write in.
   *
   * Only a list of choices. The server checks both ends of every move again —
   * offering a folder a share does not reach would only be a way of finding
   * that out after the fact.
   */
  const renameFolders = useMemo(
    () =>
      renameTarget === null
        ? []
        : ['', ...vaultFolders(notes, treeQuery.data?.dirs ?? [], renameTarget.owner)].filter((dir) =>
            mayChangeFolder(user.id, received, renameTarget.owner, dir),
          ),
    [renameTarget, notes, treeQuery.data, received, user.id],
  );

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
    } else {
      const preview = await api.deletePreview(user.id, paths).catch(() => null);
      const afterwards = copy.ask.afterDelete(preview);
      if (!window.confirm(copy.ask.deleteNotes(paths.length) + (afterwards !== '' ? ` ${afterwards}` : ''))) return;
    }

    // Written first, like every other operation that moves or removes a note
    // under the editor: a save in flight belongs to the path it was typed at,
    // and one that lands after a move re-creates the note there.
    await settle();

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
        setError(
          copy.errors.bulkPartly(
            result.ok.length,
            result.failed.map((entry) => entry.path),
            result.failed[0]?.reason ?? '',
          ),
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
    // Said at once, before anything is awaited: on a slow connection the graph
    // can take a while, and a click that changes nothing looks like a click
    // that did not land.
    setArriving(next);
    if (hasPending()) await flush();
    if (next === 'overview') await refreshOverview();
    if (next === 'files') await refreshFiles();
    if (next === 'tidy') await refreshTree();
    if (next === 'shares') await refreshShares();
    // The graph is fetched only while a view draws it, so arriving from home
    // (or anywhere else) used to show a frame of "loading" between the page
    // that was there and the brain. Waiting for it here keeps the old page on
    // screen until the brain can take its place; a fresh answer in the cache
    // costs nothing.
    if (next === 'brain') await client.prefetchQuery({ queryKey: keys.graph, queryFn: () => api.graph(), staleTime: 30_000 });
    setView(next);
    setArriving((current) => (current === next ? null : current));
  };

  const grantShare = async (grantee: string, kind: ShareKind, path: string, canWrite: boolean): Promise<void> => {
    setShareBusy(true);
    try {
      await api.grantShare(grantee, kind, path, canWrite);
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
    const what = copy.ask.shareExtent(share.prefix);
    const question = own
      ? copy.ask.withdrawShare(share.grantee, what)
      : copy.ask.giveUpShare(share.owner, what);
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
    if (hasPending()) await flush();
    await api.logout();
    // What this browser kept about the account goes with it — see `end` in
    // `App`, which unmounts this shell before forgetting anything.
    onSignedOut();
  };

  const accountItems: MenuItem[] = [
    { key: 'settings', label: copy.nav.settings, icon: <GearIcon size={16} />, onSelect: () => void showView('settings') },
    { key: 'files', label: copy.nav.files, icon: <FileIcon size={16} />, onSelect: () => void showView('files') },
    { key: 'shares', label: copy.nav.sharing, icon: <ShareIcon size={16} />, onSelect: () => void showView('shares') },
    // Hidden for everybody else, and refused by the server regardless: a menu
    // entry that is not rendered is not a permission.
    ...(user.role === 'admin'
      ? [{ key: 'admin', label: copy.nav.admin, icon: <ShieldIcon size={16} />, onSelect: () => void showView('admin') }]
      : []),
    { key: 'signout', label: copy.nav.signOut, icon: <SignOutIcon size={16} />, onSelect: () => void signOut() },
  ];

  const heading = headingOf();

  /**
   * What ⌘K can do besides opening a note.
   *
   * Two kinds only, and the line between them is what keeps the list short.
   * Things you *do* that have no keyboard route at all — start today's note,
   * start any note, flip the theme — and the views that are not in the sidebar
   * because they sit behind the account menu. Overview, Journal, Network, Tidy
   * up and Search stay out: they are one click away in the sidebar, and a
   * palette that lists them as well is a second navigation bar that has to be
   * kept in step with the first.
   *
   * Signing out is deliberately absent. Enter in a fuzzy list is the most
   * accidental key in this application, and sign out is the one thing here that
   * pressing it again does not undo.
   */
  const paletteCommands: PaletteCommand[] = [
    {
      key: 'today',
      label: copy.palette.openToday,
      keywords: copy.palette.keywords.today,
      shortcut: copy.journal.shortcut,
      run: () => void openToday(),
    },
    {
      key: 'new-note',
      label: copy.nav.newNote,
      keywords: copy.palette.keywords.newNote,
      // The same prompt the sidebar's "+" opens: the palette shortens the
      // reach for it, it does not become a second way of naming a note.
      run: () => void createNote(),
    },
    {
      key: 'files',
      label: copy.nav.files,
      keywords: copy.palette.keywords.files,
      run: () => void showView('files'),
    },
    {
      key: 'shares',
      label: copy.nav.sharing,
      keywords: copy.palette.keywords.sharing,
      run: () => void showView('shares'),
    },
    {
      key: 'settings',
      label: copy.nav.settings,
      keywords: copy.palette.keywords.settings,
      run: () => void showView('settings'),
    },
    // Hidden for everybody else, as in the account menu: a command that is not
    // in the list is not a permission, and the server refuses it regardless.
    ...(user.role === 'admin'
      ? [
          {
            key: 'admin',
            label: copy.nav.admin,
            keywords: copy.palette.keywords.admin,
            run: () => void showView('admin'),
          },
        ]
      : []),
    {
      // Named for what it will do, like the header button it duplicates, so the
      // row cannot be read as a statement about which theme is on.
      key: 'theme',
      label: dark ? copy.shell.lightTheme : copy.shell.darkTheme,
      keywords: copy.palette.keywords.theme,
      run: () => setPrefs((current) => ({ ...current, theme: dark ? 'light' : 'dark' })),
    },
  ];

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
    /**
     * What the line of numbers says when there are no numbers.
     *
     * `0 notes · 0 folders` and `0 orphaned · 0 broken links` are not neutral
     * placeholders: they are assertions about the vault, and under a failed
     * request they are false ones. `Loading…` is equally false once the request
     * has given up, and it is the one that sat there for ever.
     */
    const instead = (trouble: ReturnType<typeof troubleOf>): string | null =>
      trouble === null ? null : trouble === 'offline' ? sub.offline : sub.failed;
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
            instead(treeTrouble ?? overviewTrouble) ??
            sub.overview(notes.length, folderCount(notes)) +
              (overview !== null && overview.counts.attention > 0
                ? ` · ${sub.attention(overview.counts.attention)}`
                : ''),
        };
      case 'brain':
        return {
          title: copy.nav.network,
          subtitle:
            instead(graphTrouble) ??
            (graph === null
              ? sub.loading
              : `${sub.network(graph.nodes.length, graph.edges.length)} · ${sub.loose(
                  graph.nodes.filter((n) => n.links === 0).length,
                )}`),
        };
      case 'tidy':
        return {
          title: copy.nav.tidy,
          subtitle:
            instead(tidyTrouble) ??
            (tidy === null
              ? sub.loading
              : sub.tidy(tidy.totals.orphans, tidy.totals.deadLinks, tidy.totals.stale)),
        };
      case 'search':
        return {
          title: copy.nav.search,
          subtitle:
            query.trim() !== ''
              ? sub.results(hits.length, query.trim())
              : // "Full text across 0 notes" reads as a vault with nothing in it.
                (instead(treeTrouble) ?? sub.search(notes.length)),
        };
      case 'files':
        return {
          title: copy.nav.files,
          subtitle:
            instead(filesTrouble) ??
            (files === null ? sub.loading : sub.files(files.files.length, files.dirs.length)),
        };
      case 'journal': {
        const today = localDate(new Date());
        const inMonth = [...journalDays].filter((day) => day.startsWith(isoDate(today).slice(0, 8))).length;
        return {
          title: copy.journal.title,
          subtitle:
            instead(treeTrouble) ??
            sub.journal(journalDays.size, inMonth) + (tasks === null ? '' : ` · ${sub.tasks(tasks.total)}`),
        };
      }
      case 'settings':
        return { title: copy.nav.settings, subtitle: sub.settings };
      case 'admin':
        return { title: copy.nav.admin, subtitle: sub.admin(adminUsersQuery.data?.users.length ?? 0) };
      case 'shares':
        return {
          title: copy.nav.sharing,
          subtitle: instead(sharesTrouble) ?? sub.shares(granted.length, received.length),
        };
      default:
        return { title: '', subtitle: '' };
    }
  }

  // Folding applies to the desktop sidebar only. On a phone the sidebar is a
  // drawer, and a folded drawer would be a drawer with nothing in it.
  const collapsed = prefs.sidebarCollapsed && !narrow;

  return (
    <OwnersContext.Provider value={owners}>
    <div
      className="app"
      data-drawer={drawerOpen}
      data-wide={view !== 'note'}
      data-collapsed={collapsed}
      data-view={view}
      data-busy={arriving !== null}
    >
      <Sidebar
        name={user.displayName}
        view={view}
        arriving={arriving}
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
            onRenameNote={openRename}
            onShareNote={openShare}
            mayShareNote={mayShareNote}
            onCreateIn={(owner) => void createInSpace(owner)}
            revealed={revealed}
            onCreateFirst={() => void createNote()}
            trouble={treeTrouble}
            onRetry={() => askAgain(keys.tree)}
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
        onToday={() => {
          setDrawerOpen(false);
          void openToday();
        }}
        onTodayNote={
          view === 'note' &&
          open !== null &&
          open.owner === user.id &&
          (() => {
            const day = parseJournalPath(open.note.path);
            return day !== null && sameDate(day, localDate(new Date()));
          })()
        }
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
                    {ownerLabel(owners, open.owner)} · {open.canWrite ? copy.note.canWrite : copy.note.readOnly}
                  </span>
                )}
                <SaveIndicator state={saveState} />
                {/* Rename and move, and delete, where the server said this note
                    may be written; share where the caller may hand it on (their
                    own, or a space's as administrator). A note read through a
                    read-only share has nothing to offer here.

                    Ordered by how often it is wanted and how hard it is to
                    undo: renaming is the everyday one and the destructive one
                    is last, where a slip cannot land on it. */}
                {open !== null && (open.canWrite || mayShareNote(open.owner)) && (
                  <MenuButton
                    label={copy.note.actions}
                    icon={<MoreIcon />}
                    items={[
                      ...(open.canWrite
                        ? [
                            {
                              key: 'rename',
                              label: copy.renameNote.menu,
                              icon: <PencilIcon size={16} />,
                              onSelect: () => openRename(open.owner, open.note.path, open.note.title),
                            },
                          ]
                        : []),
                      ...(mayShareNote(open.owner)
                        ? [
                            {
                              key: 'share',
                              label: copy.shareNote.menu,
                              icon: <ShareIcon size={16} />,
                              onSelect: () => openShare(open.owner, open.note.path, open.note.title),
                            },
                          ]
                        : []),
                      ...(open.canWrite
                        ? [
                            {
                              key: 'delete',
                              label: copy.note.delete,
                              icon: <TrashIcon size={16} />,
                              danger: true,
                              onSelect: () => void deleteNote(open.owner, open.note.path, open.note.title),
                            },
                          ]
                        : []),
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

        {!online && <OfflineBar />}

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
                    // Locked, not rebuilt, while its delete is in flight: typing
                    // then would be text with nowhere to go.
                    locked={deletingKeys.has(refKey(open.owner, open.note.path))}
                    tags={registryQuery.data ?? null}
                    line={jumpLine ?? undefined}
                    onChange={(content) => scheduleSave(open.owner, open.note.path, content)}
                    onAttach={attachFile}
                  />
                ))}

              {view === 'overview' && overviewTrouble !== null && (
                <div className="pane padded">
                  <Trouble
                    kind={overviewTrouble}
                    what={copy.trouble.overview}
                    onRetry={() => askAgain(keys.overview)}
                  />
                </div>
              )}

              {view === 'overview' && overview === null && overviewTrouble === null && (
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
                  onTasks={() => void showView('journal')}
                  onTidy={(focus) => {
                    setTidyFocus(focus ?? null);
                    void showView('tidy');
                  }}
                  onNetwork={() => void showView('brain')}
                  journalDays={journalDays}
                  onOpenDay={(date) => void openDay(date)}
                  onCapture={captureToday}
                />
              )}

              {view === 'journal' && (
                <JournalView
                  days={journalDays}
                  onOpenDay={(date) => void openDay(date)}
                  aside={
                    tasksTrouble !== null ? (
                      <section className="journal-tasks" aria-label={copy.tasks.title}>
                        <h2 className="h-big">{copy.tasks.title}</h2>
                        <Trouble
                          kind={tasksTrouble}
                          what={copy.trouble.tasks}
                          onRetry={() => askAgain(['tasks'])}
                        />
                      </section>
                    ) : tasks === null ? (
                      <section className="journal-tasks" aria-busy="true" aria-label={copy.tasks.title}>
                        <h2 className="h-big">{copy.tasks.title}</h2>
                        <p className="h-sub">{copy.shell.sub.loading}</p>
                      </section>
                    ) : (
                      <TasksView
                        embedded
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
                    )
                  }
                />
              )}

              {view === 'brain' &&
                (graphTrouble !== null ? (
                  <div className="pane padded">
                    <Trouble
                      kind={graphTrouble}
                      what={copy.trouble.network}
                      onRetry={() => askAgain(keys.graph)}
                    />
                  </div>
                ) : graph === null ? (
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
                    onShare={openShare}
                    mayShare={mayShareNote}
                  />
                ))}

              {view === 'tidy' && tidyTrouble !== null && (
                <div className="pane padded">
                  <h2 className="h-big">{copy.tidy.title}</h2>
                  <Trouble
                    kind={tidyTrouble}
                    what={copy.trouble.findings}
                    onRetry={() => askAgain(keys.tidy)}
                  />
                </div>
              )}

              {view === 'tidy' && tidyTrouble === null && (
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
                  onKeepSelected={(paths) =>
                    setSelection((current) => {
                      const shown = new Set(paths);
                      const kept = [...current].filter((path) => shown.has(path));
                      return kept.length === current.size ? current : new Set(kept);
                    })
                  }
                  onOpen={(path) => void openNote(user.id, path)}
                  onBulk={(action) => void runBulk(action)}
                  after={<RecentlyDeleted self={user.id} onOpen={(owner, path) => void openNote(owner, path)} />}
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
                (filesTrouble !== null ? (
                  <div className="pane padded">
                    <Trouble
                      kind={filesTrouble}
                      what={copy.trouble.files}
                      onRetry={() => askAgain(keys.files)}
                    />
                  </div>
                ) : files === null ? (
                  <p className="empty" style={{ padding: '2rem' }}>{copy.files.reading}</p>
                ) : (
                  <FilesView
                    files={files.files}
                    dirs={files.dirs}
                    truncated={files.truncated}
                    owner={filesOwner}
                    vaults={filesVaults}
                    onVault={setFilesOwner}
                    mayWrite={(path) => mayChange(user.id, received, filesOwner, path)}
                    mayAddTo={(dir) => mayChangeFolder(user.id, received, filesOwner, dir)}
                    busy={filesBusy}
                    dir={filesDir}
                    onDir={setFilesDir}
                    onUpload={(picked, intoDir) => void uploadFiles(picked, intoDir)}
                    onReplace={(path, file) => void replaceFile(path, file)}
                    onDelete={(file) => void removeFile(file)}
                    onOpenNote={(path) => void openNote(filesOwner, path)}
                  />
                ))}

              {/* Rendered for an administrator only. The server refuses every
                  admin call regardless; this keeps a stored or stale view from
                  drawing the controls for somebody who cannot use them. */}
              {view === 'admin' && isAdmin && (
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
                  spaces={{
                    spaces: adminSpacesQuery.data ?? [],
                    onCreate: (id, displayName) =>
                      adminAct(() => api.createSpace(id, displayName)).then(() => {
                        // The new space is a vault this page may be showing soon.
                        invalidate.afterStructure(client);
                      }),
                    onRename: (id, displayName) =>
                      adminAct(() => api.updateSpace(id, { displayName })).then(() => {
                        // Members see the display name in the tree.
                        invalidate.afterStructure(client);
                      }),
                    onSetDisabled: (id, disabled) =>
                      adminAct(() => api.updateSpace(id, { disabled })).then(() => undefined),
                    onAddMember: (space, grantee, kind, path, canWrite) =>
                      adminAct(() => api.addSpaceMember(space, grantee, kind, path, canWrite)).then(() => undefined),
                    onRemoveMember: (space, share) =>
                      adminAct(() => api.removeSpaceMember(space, share.id)).then(() => {
                        void client.invalidateQueries({ queryKey: keys.shares });
                        invalidate.afterStructure(client);
                      }),
                  }}
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

              {view === 'shares' && sharesTrouble !== null && (
                <div className="pane padded">
                  <h2 className="h-big">{copy.shares.title}</h2>
                  {/* "Nobody can see into your vault" would be a statement about
                      the shares, and nothing is known about them right now. */}
                  <Trouble
                    kind={sharesTrouble}
                    what={copy.trouble.shares}
                    onRetry={() => askAgain(keys.shares)}
                  />
                </div>
              )}

              {view === 'shares' && sharesTrouble === null && (
                <SharesView
                  granted={granted}
                  received={received}
                  dirs={ownDirs}
                  busy={shareBusy}
                  onGrant={(grantee, prefix, canWrite) =>
                    void grantShare(grantee, prefix === '' ? 'vault' : 'folder', prefix, canWrite)
                  }
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
        commands={paletteCommands}
        onClose={() => setPaletteOpen(false)}
        onOpenNote={(owner, path, find) =>
          void openNote(owner, path, find === undefined ? undefined : (content) => lineOfHit(content, find.snippet, find.query))
        }
        onSearchAll={(words) => {
          setQuery(words);
          void showView('search').then(() => runSearch(words, filters)).catch(() => setError(copy.errors.searchFailed));
        }}
      />

      {shareTarget !== null && mayShareNote(shareTarget.owner) && (
        <ShareDialog
          note={shareTarget}
          user={user}
          ownerKind={ownerKind(owners, shareTarget.owner)}
          ownerLabel={ownerLabel(owners, shareTarget.owner)}
          granted={granted}
          people={people}
          onClose={() => setShareTarget(null)}
        />
      )}

      {/* Only where this screen believes the note may be changed. The server
          checks both ends of the move again, on every request. */}
      {renameTarget !== null && mayChange(user.id, received, renameTarget.owner, renameTarget.path) && (
        <RenameDialog
          note={renameTarget}
          folders={renameFolders}
          onRename={(to) => renameNote(renameTarget.owner, renameTarget.path, to)}
          onClose={() => setRenameTarget(null)}
        />
      )}
    </div>
    </OwnersContext.Provider>
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
