/** Tauri-only view over the device-local notes folder (Task 4's
 *  `LocalNotesStore`/`localSearch.ts`): pick a folder, list/open/edit local
 *  markdown files in a non-collaborative editor, search them entirely
 *  on-device, and optionally move one to the server.
 *
 *  Strict isolation carries over from `localStore.ts`/`moveToServer.ts`: the
 *  only server call anywhere in this component is the explicit "Move to
 *  server" action, gated behind a confirmation dialog. Everything else
 *  (listing, opening, editing, searching) never leaves the device.
 *
 *  Self-gated like `ServerUrlView`: renders nothing outside of Tauri, so
 *  mounting it unconditionally is safe — `AppRoot` additionally only mounts
 *  it behind `isTauri()` for defense in depth (see its doc comment). */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { isTauri } from "../platform/tauri";
import { assertSafeRelPath, extractTitle, LocalPathError, type LocalNoteSummary } from "./localStore";
import { defaultLocalNotesStore, type DefaultLocalNotesStoreLike } from "./defaultLocalNotesStore";
import { buildLocalIndex, searchLocal } from "./localSearch";
import { moveToServer as defaultMoveToServer, MoveAbortedError, type MoveToServerResult } from "./moveToServer";
import { createWriteQueue } from "./writeQueue";
import { LocalEditor, type LocalEditorProps } from "../editor/LocalEditor";
import styles from "./LocalNotesView.module.css";

/** How long to wait after the last keystroke before a note's content is
 *  persisted to disk and its title/search index updated (see `handleChange`'s
 *  doc comment — this is a deliberate trade-off, not an oversight: writing
 *  and re-indexing on every single keystroke was both a data-loss risk and
 *  wasteful CPU work for larger vaults). */
const WRITE_DEBOUNCE_MS = 400;

interface LocalDoc {
  path: string;
  title: string | null;
  content: string;
}

/** Falls back to the filename (without its `.md` extension) as a note's
 *  display name when it has no markdown heading to extract a title from —
 *  used by both the list rows and the editor pane's doc header. */
function noteDisplayName(path: string): string {
  const fileName = path.split("/").pop() ?? path;
  return fileName.toLowerCase().endsWith(".md") ? fileName.slice(0, -".md".length) : fileName;
}

/** Structural subset this view needs — lets tests inject a plain fake object
 *  (same convention as `NoteTreeClient`/`AuthClient`). Mirrors
 *  `DefaultLocalNotesStoreLike` (see `./defaultLocalNotesStore.ts`) rather
 *  than the real, per-folder `LocalNotesStore` class: this view still owns
 *  picking/persisting a single folder itself, a transitional arrangement
 *  until Plan 8 Task 6/7 switches it to an injected, already-scoped store
 *  from the source registry. */
export type LocalNotesStoreLike = DefaultLocalNotesStoreLike;

/** The folder/notes-count snapshot this view reports via `onStatusChange` —
 *  `LocalOnlyShell` renders a statusbar from it instead of re-deriving the
 *  same folder/count itself. */
export interface LocalNotesStatus {
  folder: string | null;
  count: number;
}

export interface LocalNotesViewProps {
  /** Injectable for tests; defaults to the shared `defaultLocalNotesStore`
   *  singleton (single-folder transitional default — see
   *  `./defaultLocalNotesStore.ts`). */
  store?: LocalNotesStoreLike;
  /** Injectable for tests; defaults to the real `moveToServer` (which itself
   *  defaults to the shared store/client singletons). */
  moveToServer?: (rel: string) => Promise<MoveToServerResult>;
  /** Injectable for tests; defaults to the real, CodeMirror-backed `LocalEditor`. */
  EditorComponent?: (props: LocalEditorProps) => ReturnType<typeof LocalEditor>;
  /** Fired whenever the configured folder or its note count changes. Optional
   *  and unused by `AppRoot`'s standalone "Local" tab — `LocalOnlyShell` is
   *  the only caller that passes it, to drive its statusbar without this
   *  component needing to know a statusbar exists. */
  onStatusChange?: (status: LocalNotesStatus) => void;
}

export function LocalNotesView({
  store = defaultLocalNotesStore,
  moveToServer = defaultMoveToServer,
  EditorComponent = LocalEditor,
  onStatusChange,
}: LocalNotesViewProps) {
  const [folder, setFolder] = useState<string | null | undefined>(undefined);
  const [docs, setDocs] = useState<LocalDoc[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [listError, setListError] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [moveWarning, setMoveWarning] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [isCreatingNote, setIsCreatingNote] = useState(false);
  const [newNoteName, setNewNoteName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const newNoteInputRef = useRef<HTMLInputElement>(null);
  // Paths with a debounced edit not yet committed (see `handleChange`/
  // `commitChange` below) — drives the doc header's "Saved"/"Unsaved
  // changes" status line, purely cosmetic bookkeeping alongside the actual
  // debounce/write-queue logic those functions already perform.
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(() => new Set());

  const enabled = isTauri();

  // Serializes disk writes per path (see `writeQueue.ts`'s doc comment) so
  // concurrent Tauri IPC calls for the same note can never settle out of
  // order and clobber a newer edit with a stale one.
  const writeQueue = useMemo(() => createWriteQueue((path, content) => store.writeLocal(path, content)), [store]);
  // Debounce state per path, keyed independently of `writeQueue`: holds the
  // pending timer plus the latest not-yet-committed content for a note being
  // actively typed into. See `handleChange`/`commitChange` below.
  const pendingRef = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; content: string }>());

  const refresh = useMemo(
    () => async () => {
      try {
        const summaries: LocalNoteSummary[] = await store.listLocal();
        const loaded = await Promise.all(
          summaries.map(async (summary) => ({
            path: summary.path,
            title: summary.title,
            content: await store.readLocal(summary.path),
          })),
        );
        setDocs(loaded);
        setListError(null);
      } catch {
        setDocs([]);
        setListError("Failed to load local notes.");
      }
    },
    [store],
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void store
      .getFolder()
      .then(async (path) => {
        if (cancelled) return;
        setFolder(path);
        if (path) {
          // The Tauri fs plugin's runtime scope (unlike the persisted folder
          // path itself) does not survive an app restart — re-grant it here
          // for a folder restored from a previous session (see
          // `LocalNotesStore.grantFolderAccess`'s doc comment).
          await store.grantFolderAccess(path);
          if (cancelled) return;
          await refresh();
        }
      })
      .catch((err) => {
        // Without this, a `grantFolderAccess`/`getFolder` rejection here died
        // as a silent unhandled rejection: the folder was set but the note
        // list stayed empty forever with no visible error (M3 finding).
        if (cancelled) return;
        setListError(err instanceof Error ? err.message : "Failed to load the local notes folder.");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, store]);

  // Same focus-on-open convention as `NoteTree`'s inline "+ New note" input.
  useEffect(() => {
    if (isCreatingNote) newNoteInputRef.current?.focus();
  }, [isCreatingNote]);

  // Reports the folder/count snapshot up to whoever asked (see
  // `LocalNotesViewProps.onStatusChange`'s doc comment) whenever either
  // changes — before `folder` first resolves it is `undefined`, reported as
  // `null` (no folder configured yet) rather than left out entirely.
  useEffect(() => {
    onStatusChange?.({ folder: folder ?? null, count: docs.length });
  }, [folder, docs.length, onStatusChange]);

  // Flushes every note's debounced-but-not-yet-persisted edit on unmount, so
  // navigating away right after typing never silently drops the last change.
  useEffect(() => {
    return () => {
      for (const path of Array.from(pendingRef.current.keys())) {
        flushPending(path);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!enabled) return null;

  async function handlePickFolder() {
    try {
      const path = await store.pickFolder();
      if (path) {
        setFolder(path);
        await store.grantFolderAccess(path);
        await refresh();
      }
    } catch (err) {
      // Same silent-death risk as the mount effect above (M3 finding): a
      // `pickFolder`/`grantFolderAccess` failure here used to vanish as an
      // unhandled rejection behind `void handlePickFolder()`.
      setListError(err instanceof Error ? err.message : "Failed to open the local notes folder.");
    }
  }

  async function handleChangeFolder() {
    try {
      const path = await store.pickFolder();
      if (!path) return;
      if (selectedPath) flushPending(selectedPath);
      setFolder(path);
      setSelectedPath(null);
      setMoveError(null);
      setMoveWarning(null);
      await store.grantFolderAccess(path);
      await refresh();
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to open the local notes folder.");
    }
  }

  function handleSelect(path: string) {
    if (selectedPath && selectedPath !== path) flushPending(selectedPath);
    setSelectedPath(path);
    setMoveError(null);
    setMoveWarning(null);
  }

  /** Applies a debounced-off edit: updates the list's title/content (and so,
   *  transitively, the search index — see the `index` memo below, which
   *  depends on `docs`) and enqueues the actual disk write. Called once per
   *  pause in typing, never per keystroke. */
  function commitChange(path: string, content: string) {
    setDocs((prev) =>
      prev.map((doc) => (doc.path === path ? { ...doc, content, title: extractTitle(content) } : doc)),
    );
    setListError(null);
    writeQueue.enqueue(path, content);
    setDirtyPaths((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }

  /** Immediately commits and enqueues a still-pending debounced edit for
   *  `path` (if any), instead of waiting out the rest of `WRITE_DEBOUNCE_MS`.
   *  Used when the user switches notes, changes folder, or unmounts — none
   *  of which should be able to lose the last few keystrokes typed into the
   *  note being left behind. */
  function flushPending(path: string) {
    const entry = pendingRef.current.get(path);
    if (!entry) return;
    clearTimeout(entry.timer);
    pendingRef.current.delete(path);
    commitChange(path, entry.content);
  }

  /** Fired on every CodeMirror doc change (i.e. potentially every keystroke).
   *  Deliberately does NOT write to disk or touch `docs`/the search index
   *  synchronously (I2 finding): doing so on every keystroke both risked
   *  out-of-order writes clobbering newer edits with stale ones, and rebuilt
   *  the whole MiniSearch index on every character typed. Instead this only
   *  restarts a per-path debounce timer; `commitChange` (via `flushPending`
   *  or the timer firing) is what actually persists and re-indexes, at most
   *  once per pause in typing. */
  function handleChange(path: string, content: string) {
    const existing = pendingRef.current.get(path);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      pendingRef.current.delete(path);
      commitChange(path, content);
    }, WRITE_DEBOUNCE_MS);
    pendingRef.current.set(path, { timer, content });
    setDirtyPaths((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
  }

  async function handleMoveToServer() {
    if (!selectedPath) return;
    // `window.confirm` never returns on macOS's WKWebView-backed Tauri
    // shell — it silently resolves to `false` every time, so the button did
    // nothing (C1 finding). The native dialog plugin's `confirm` is async
    // and actually shows a dialog.
    const confirmed = await confirmDialog(
      `Move "${selectedPath}" to the server? It will be removed from this device.`,
    );
    if (!confirmed) return;

    setMoving(true);
    setMoveError(null);
    setMoveWarning(null);
    try {
      const result = await moveToServer(selectedPath);
      setDocs((prev) => prev.filter((doc) => doc.path !== result.path));
      setSelectedPath(null);
      if (!result.localDeleted) {
        setMoveWarning(
          `"${result.path}" was moved to the server, but the local copy could not be confirmed removed — please check this device.`,
        );
      }
    } catch (err) {
      if (err instanceof MoveAbortedError) {
        // The user declined `moveToServer`'s separate overwrite confirmation
        // (Known-Important-1 finding) — nothing happened (no PUT, no local
        // delete), so there is nothing to report as an error; leave the note
        // exactly as it was.
        return;
      }
      setMoveError(err instanceof Error ? err.message : "Failed to move the note to the server.");
    } finally {
      setMoving(false);
    }
  }

  function openNewNoteInput() {
    setCreateError(null);
    setNewNoteName("");
    setIsCreatingNote(true);
  }

  function closeNewNoteInput() {
    setIsCreatingNote(false);
    setNewNoteName("");
    setCreateError(null);
  }

  /** Enforces the `.md` extension `listLocal` filters on (see its doc
   *  comment) without doubling it if the user already typed one — matches
   *  `NoteTree`'s `submitNewNote` convention. */
  function toMdPath(raw: string): string {
    return raw.toLowerCase().endsWith(".md") ? raw : `${raw}.md`;
  }

  /** Validates and creates a new local note from the inline input's current
   *  value: enforces `.md`, rejects unsafe paths (`assertSafeRelPath`) and
   *  collisions with an already-listed note, then persists it and opens it
   *  for editing. Never uses `window.prompt`/`alert` (see the module's C1
   *  finding above) — errors surface via the same `role="alert"` pattern as
   *  `listError`/`moveError`, and the input stays open so the user can
   *  correct the name instead of losing what they typed. */
  async function submitNewNote() {
    const trimmed = newNoteName.trim();
    if (!trimmed) return;

    let safeRel: string;
    try {
      safeRel = assertSafeRelPath(toMdPath(trimmed));
    } catch (err) {
      setCreateError(err instanceof LocalPathError ? err.message : "Invalid note name.");
      return;
    }

    if (docs.some((doc) => doc.path === safeRel)) {
      setCreateError(`"${safeRel}" already exists.`);
      return;
    }

    const fileName = safeRel.split("/").pop() ?? safeRel;
    const title = fileName.slice(0, -".md".length);
    const initialContent = `# ${title}\n`;

    try {
      await store.writeLocal(safeRel, initialContent);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create the note.");
      return;
    }

    if (selectedPath) flushPending(selectedPath);
    setDocs((prev) =>
      [...prev, { path: safeRel, title: extractTitle(initialContent), content: initialContent }].sort((a, b) =>
        a.path.localeCompare(b.path),
      ),
    );
    setSelectedPath(safeRel);
    setMoveError(null);
    setMoveWarning(null);
    closeNewNoteInput();
  }

  function handleNewNoteKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitNewNote();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeNewNoteInput();
    }
  }

  const index = useMemo(
    () => buildLocalIndex(docs.map((doc) => ({ path: doc.path, title: doc.title, content: doc.content }))),
    [docs],
  );

  const visible = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return docs;
    const hits = searchLocal(index, trimmed);
    const byPath = new Map(docs.map((doc) => [doc.path, doc]));
    return hits.map((hit) => byPath.get(hit.path)).filter((doc): doc is LocalDoc => doc !== undefined);
  }, [docs, index, query]);

  const selectedDoc = docs.find((doc) => doc.path === selectedPath) ?? null;

  return (
    <div className={styles.view}>
      {folder === null ? (
        <div className={styles.emptyState}>
          <svg className={styles.emptyLogo} width="40" height="31" viewBox="0 0 26 20" fill="none" aria-hidden="true">
            <circle className={styles.emptyLogoRing} cx="9.5" cy="10" r="6.5" strokeWidth="1.6" />
            <circle className={styles.emptyLogoRing} cx="16.5" cy="10" r="6.5" strokeWidth="1.6" />
          </svg>
          <h2 className={styles.emptyTitle}>Open a folder of Markdown notes</h2>
          <p className={styles.emptyText}>
            These notes stay on this device only — they are never sent to the server or seen by an agent.
          </p>
          <button type="button" className={styles.primaryButton} onClick={() => void handlePickFolder()}>
            Choose folder…
          </button>
          <p className={styles.emptyHint}>Any folder inside your home directory</p>
        </div>
      ) : (
        <div className={styles.layout}>
          <div className={styles.listPane}>
            <div className={styles.listHeader}>
              <span className={styles.listLabel}>Notes</span>
              <span className={styles.listCount}>{docs.length}</span>
            </div>

            <div className={styles.folderRow}>
              <span className={styles.folderPath} title={folder ?? undefined}>
                {folder}
              </span>
              <button type="button" className={styles.changeFolder} onClick={() => void handleChangeFolder()}>
                Change folder…
              </button>
            </div>

            <div className={styles.searchRow}>
              <svg
                className={styles.searchIcon}
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                aria-hidden="true"
              >
                <circle cx="5.2" cy="5.2" r="4" stroke="currentColor" strokeWidth="1.2" />
                <path d="M8.2 8.2 11 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
              <input
                className={styles.search}
                role="searchbox"
                aria-label="Search local notes"
                placeholder="Search local notes…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            {folder && !isCreatingNote && (
              <button type="button" className={styles.newNote} onClick={openNewNoteInput}>
                + New note
              </button>
            )}

            {isCreatingNote && (
              <div className={styles.newNoteRow}>
                <input
                  ref={newNoteInputRef}
                  type="text"
                  className={styles.newNoteInput}
                  aria-label="Name for the new local note"
                  placeholder="note or folder/note"
                  value={newNoteName}
                  onChange={(e) => setNewNoteName(e.target.value)}
                  onKeyDown={handleNewNoteKeyDown}
                />
                <button type="button" className={styles.newNoteConfirm} onClick={() => void submitNewNote()}>
                  Create
                </button>
                <button type="button" className={styles.newNoteCancel} onClick={closeNewNoteInput}>
                  Cancel
                </button>
              </div>
            )}

            {createError && (
              <p role="alert" className={styles.error}>
                {createError}
              </p>
            )}

            {listError && (
              <p role="alert" className={styles.error}>
                {listError}
              </p>
            )}

            <ul className={styles.list}>
              {visible.length === 0 ? (
                <li className={styles.listEmpty}>{query.trim() ? "No matches" : "No notes yet"}</li>
              ) : (
                visible.map((doc) => (
                  <li key={doc.path}>
                    <button
                      type="button"
                      className={
                        doc.path === selectedPath ? `${styles.noteButton} ${styles.active}` : styles.noteButton
                      }
                      onClick={() => handleSelect(doc.path)}
                    >
                      <span className={styles.noteTitle}>{doc.title ?? noteDisplayName(doc.path)}</span>
                      <span className={styles.notePath}>{doc.path}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>

          <div className={styles.editorPane}>
            {moveError && (
              <p role="alert" className={styles.error}>
                {moveError}
              </p>
            )}
            {moveWarning && (
              <p role="alert" className={styles.warning}>
                {moveWarning}
              </p>
            )}

            {selectedDoc ? (
              <>
                <div className={styles.docHeader}>
                  <div className={styles.docHeaderMain}>
                    <h1 className={styles.docTitle}>{selectedDoc.title ?? noteDisplayName(selectedDoc.path)}</h1>
                    <p className={styles.docMeta}>
                      {selectedDoc.path} · {dirtyPaths.has(selectedDoc.path) ? "Unsaved changes" : "Saved"}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={styles.moveButton}
                    disabled={moving}
                    onClick={() => void handleMoveToServer()}
                  >
                    Move to server
                  </button>
                </div>

                <div className={styles.editorBody}>
                  <EditorComponent
                    path={selectedDoc.path}
                    content={selectedDoc.content}
                    onChange={(content) => void handleChange(selectedDoc.path, content)}
                  />
                </div>
              </>
            ) : (
              <p className={styles.placeholder}>Select a local note to start editing.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
