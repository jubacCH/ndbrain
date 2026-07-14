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

import { useEffect, useMemo, useState } from "react";
import { isTauri } from "../platform/tauri";
import {
  extractTitle,
  localNotesStore,
  type LocalNoteSummary,
  type LocalNotesStore,
} from "./localStore";
import { buildLocalIndex, searchLocal } from "./localSearch";
import { moveToServer as defaultMoveToServer, type MoveToServerResult } from "./moveToServer";
import { LocalEditor, type LocalEditorProps } from "../editor/LocalEditor";
import styles from "./LocalNotesView.module.css";

interface LocalDoc {
  path: string;
  title: string | null;
  content: string;
}

/** Structural subset of `LocalNotesStore` this view needs — lets tests inject
 *  a plain fake object (same convention as `NoteTreeClient`/`AuthClient`). */
export type LocalNotesStoreLike = Pick<
  LocalNotesStore,
  | "getFolder"
  | "pickFolder"
  | "listLocal"
  | "readLocal"
  | "writeLocal"
  | "deleteLocal"
  | "grantFolderAccess"
>;

export interface LocalNotesViewProps {
  /** Injectable for tests; defaults to the shared `localNotesStore` singleton. */
  store?: LocalNotesStoreLike;
  /** Injectable for tests; defaults to the real `moveToServer` (which itself
   *  defaults to the shared store/client singletons). */
  moveToServer?: (rel: string) => Promise<MoveToServerResult>;
  /** Injectable for tests; defaults to the real, CodeMirror-backed `LocalEditor`. */
  EditorComponent?: (props: LocalEditorProps) => ReturnType<typeof LocalEditor>;
}

export function LocalNotesView({
  store = localNotesStore,
  moveToServer = defaultMoveToServer,
  EditorComponent = LocalEditor,
}: LocalNotesViewProps) {
  const [folder, setFolder] = useState<string | null | undefined>(undefined);
  const [docs, setDocs] = useState<LocalDoc[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [listError, setListError] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [moveWarning, setMoveWarning] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  const enabled = isTauri();

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
    void store.getFolder().then(async (path) => {
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
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, store]);

  if (!enabled) return null;

  async function handlePickFolder() {
    const path = await store.pickFolder();
    if (path) {
      setFolder(path);
      await store.grantFolderAccess(path);
      await refresh();
    }
  }

  function handleSelect(path: string) {
    setSelectedPath(path);
    setMoveError(null);
    setMoveWarning(null);
  }

  async function handleChange(path: string, content: string) {
    try {
      await store.writeLocal(path, content);
      setDocs((prev) =>
        prev.map((doc) => (doc.path === path ? { ...doc, content, title: extractTitle(content) } : doc)),
      );
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to save the note.");
    }
  }

  async function handleMoveToServer() {
    if (!selectedPath) return;
    const confirmed = window.confirm(
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
      setMoveError(err instanceof Error ? err.message : "Failed to move the note to the server.");
    } finally {
      setMoving(false);
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
        <div className={styles.pickFolder}>
          <p>No local notes folder configured yet.</p>
          <button type="button" onClick={() => void handlePickFolder()}>
            Choose folder…
          </button>
        </div>
      ) : (
        <div className={styles.layout}>
          <div className={styles.listPane}>
            <input
              className={styles.search}
              role="searchbox"
              aria-label="Search local notes"
              placeholder="Search local notes…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />

            {listError && (
              <p role="alert" className={styles.error}>
                {listError}
              </p>
            )}

            <ul className={styles.list}>
              {visible.map((doc) => (
                <li key={doc.path}>
                  <button
                    type="button"
                    className={
                      doc.path === selectedPath ? `${styles.noteButton} ${styles.active}` : styles.noteButton
                    }
                    onClick={() => handleSelect(doc.path)}
                  >
                    {doc.title ?? doc.path}
                  </button>
                </li>
              ))}
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
                <div className={styles.toolbar}>
                  <span className={styles.path}>{selectedDoc.path}</span>
                  <button type="button" disabled={moving} onClick={() => void handleMoveToServer()}>
                    Move to server
                  </button>
                </div>

                <EditorComponent
                  path={selectedDoc.path}
                  content={selectedDoc.content}
                  onChange={(content) => void handleChange(selectedDoc.path, content)}
                />
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
