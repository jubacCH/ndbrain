/** Routes the main editor slot to whichever source the current selection
 *  belongs to (Plan 8 Task 7). Before this, `AppRoot` always rendered the
 *  collaborative `<Editor>` regardless of `selection.sourceId` - harmless
 *  while exactly one (server) source could ever exist, but wrong the moment
 *  a folder source's note got selected: it has no server-side Y.Doc to
 *  connect to at all.
 *
 *  - `kind: "server"` -> the collaborative `<Editor>`, wired to *that*
 *    source's own collab token and its own Hocuspocus ws URL (never the
 *    globally-derived one - two server sources must never cross-connect).
 *  - `kind: "folder"` -> the non-collaborative `<LocalEditor>`, reading and
 *    writing through *that* source's own `LocalNotesStore` - no `Editor`,
 *    no `HocuspocusProvider`, no network path at all (the plan's isolation
 *    guarantee).
 *
 *  The doc header (title + source label + path [+ save status]) is shared by
 *  both kinds and carried over from the now-deleted `local/LocalNotesView.tsx`,
 *  along with its debounced-write/flush-on-switch logic (see `flushPending`
 *  below) - only the "Move to server" button did not survive the move: a
 *  later task rebuilds "Move to..." with a target picker directly in this
 *  header, no longer a single hardcoded destination.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { deriveWsUrlFromOrigin } from "../api/base-url";
import { createCollabProvider } from "../api/collab";
import { Editor, type ProviderFactory } from "../editor/Editor";
import { LocalEditor } from "../editor/LocalEditor";
import type { LocalNotesStore } from "../local/localStore";
import { createWriteQueue, type WriteQueue } from "../local/writeQueue";
import { useSources } from "../sources/useSources";
import { useAppState } from "./AppState";
import styles from "./EditorPane.module.css";

/** How long to wait after the last keystroke before a folder note's content
 *  is persisted to disk - unchanged from the deleted `LocalNotesView.tsx`
 *  (see its doc comment: writing on every keystroke was both a data-loss
 *  risk under out-of-order IPC writes and wasteful re-indexing work). */
const WRITE_DEBOUNCE_MS = 400;

/** Falls back to the filename (without its `.md` extension) as a note's doc
 *  header title. Unlike the old `LocalNotesView` (which preferred a
 *  markdown heading), the header here is always filename-derived - the same
 *  rule for a server note as for a folder note. */
function noteDisplayName(path: string): string {
  const fileName = path.split("/").pop() ?? path;
  return fileName.toLowerCase().endsWith(".md") ? fileName.slice(0, -".md".length) : fileName;
}

interface PendingEdit {
  store: LocalNotesStore;
  path: string;
  content: string;
  timer: ReturnType<typeof setTimeout>;
}

export function EditorPane() {
  const { selection } = useAppState();
  const { sources } = useSources();

  const runtime = selection ? sources.find((candidate) => candidate.def.id === selection.sourceId) : undefined;

  // ---- server-kind wiring ----
  // `def.url === ""` is the plain-browser implicit origin source (see
  // `SourcesProvider`'s `ORIGIN_SOURCE`) - passing no `wsUrl` at all there
  // lets `createCollabProvider` fall back to its `window.location`-derived
  // default, exactly as before this task (no regression). Any other source
  // gets its own ws URL derived from its own `def.url`, never the page's.
  const wsUrl =
    runtime?.kind === "server" && runtime.def.url ? deriveWsUrlFromOrigin(runtime.def.url) : undefined;
  // Memoized on the derived `wsUrl` string, not on `runtime` itself: a
  // `SourcesProvider` state update (e.g. a different source's login) rebuilds
  // every `SourceRuntime` object via spread (see its doc comment), which
  // would otherwise tear down and reconnect this source's live Collab
  // session for no reason.
  const providerFactory: ProviderFactory = useMemo(
    () => (opts) => createCollabProvider({ ...opts, wsUrl }),
    [wsUrl],
  );

  // ---- folder-kind wiring ----
  const folderStore = runtime?.kind === "folder" ? runtime.store : null;
  const [content, setContent] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // The one currently-outstanding debounced edit, if any - at most one note
  // is ever being typed into at a time (the selected one), so unlike the old
  // per-path `pendingRef` Map this only needs a single slot.
  const pendingRef = useRef<PendingEdit | null>(null);
  // One `WriteQueue` per store, built lazily and kept for the store's whole
  // lifetime - a `SourceRuntime`'s `store` reference is stable across
  // `SourcesProvider` state updates (only `def`/`state` are ever replaced),
  // so this never abandons an in-flight write by rebuilding the queue itself.
  const writeQueuesRef = useRef(new Map<LocalNotesStore, WriteQueue>());

  function writeQueueFor(store: LocalNotesStore): WriteQueue {
    let queue = writeQueuesRef.current.get(store);
    if (!queue) {
      queue = createWriteQueue((path, text) => store.writeLocal(path, text));
      writeQueuesRef.current.set(store, queue);
    }
    return queue;
  }

  /** Immediately commits a still-pending debounced edit (if any) instead of
   *  waiting out the rest of `WRITE_DEBOUNCE_MS` - used when the selection
   *  changes (a different note and/or a different source) or this pane
   *  unmounts, neither of which may silently drop the last few keystrokes
   *  typed into the note being left behind. Carried over from
   *  `LocalNotesView.tsx`'s `flushPending`. */
  function flushPending() {
    const entry = pendingRef.current;
    if (!entry) return;
    clearTimeout(entry.timer);
    pendingRef.current = null;
    writeQueueFor(entry.store).enqueue(entry.path, entry.content);
    setDirty(false);
  }

  /** Fired on every `LocalEditor` doc change (i.e. potentially every
   *  keystroke). Deliberately does not write to disk synchronously - see
   *  `WRITE_DEBOUNCE_MS`'s doc comment - only restarts a debounce timer;
   *  `flushPending` (via the timer firing, or a selection change/unmount) is
   *  what actually enqueues the write. */
  function handleChange(store: LocalNotesStore, path: string, text: string) {
    if (pendingRef.current) clearTimeout(pendingRef.current.timer);
    const timer = setTimeout(() => {
      pendingRef.current = null;
      writeQueueFor(store).enqueue(path, text);
      setDirty(false);
    }, WRITE_DEBOUNCE_MS);
    pendingRef.current = { store, path, content: text, timer };
    setDirty(true);
  }

  // Loads a folder note's content whenever the selected path (or the store
  // behind it) changes. A server-kind selection (or no selection at all)
  // clears it back to `null`, so a stale folder doc can never bleed into a
  // later render of a different kind.
  useEffect(() => {
    if (!folderStore || !selection) {
      setContent(null);
      setDirty(false);
      return;
    }
    let cancelled = false;
    setContent(null);
    setDirty(false);
    void folderStore.readLocal(selection.path).then((text) => {
      if (!cancelled) setContent(text);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderStore, selection?.path]);

  // Flushes whatever was pending for the *previous* selection right before
  // switching to a new one (source and/or note change), and on unmount - a
  // single dependency-driven effect's cleanup covers both. React runs every
  // changed effect's cleanup before any new effect body in the same commit,
  // so this always flushes before the content-loading effect above re-reads
  // for the new selection. `flushPending` only ever touches refs (read at
  // call time), so closing over it here is never actually "stale".
  useEffect(() => {
    return () => flushPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection?.sourceId, selection?.path]);

  if (!selection || !runtime) {
    return <p className={styles.placeholder}>Select a note to start editing.</p>;
  }

  const editorKey = `${selection.sourceId}:${selection.path}`;

  return (
    <div className={styles.pane}>
      <div className={styles.docHeader}>
        <h1 className={styles.docTitle}>{noteDisplayName(selection.path)}</h1>
        <p className={styles.docMeta}>
          {runtime.def.label} · {selection.path}
          {runtime.kind === "folder" ? ` · ${dirty ? "Unsaved changes" : "Saved"}` : null}
        </p>
      </div>

      <div className={styles.editorBody}>
        {runtime.kind === "server" ? (
          <Editor
            key={editorKey}
            path={selection.path}
            token={runtime.client.getCollabToken()}
            providerFactory={providerFactory}
          />
        ) : content === null ? (
          <p className={styles.loading}>Loading…</p>
        ) : (
          <LocalEditor
            key={editorKey}
            path={selection.path}
            content={content}
            onChange={(text) => handleChange(runtime.store, selection.path, text)}
          />
        )}
      </div>
    </div>
  );
}
