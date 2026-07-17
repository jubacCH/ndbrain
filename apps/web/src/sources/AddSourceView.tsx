/** First-run "add a source" screen for the Tauri desktop client — replaces
 *  both the old server-url-only first run screen and the separate
 *  device-local-notes-only escape hatch, which this component's two tabs
 *  subsume: a remote ndBrain server (`addServer`) or a local folder of
 *  markdown notes (`addFolder`), both first-class entries in the same source
 *  registry (see `SourcesProvider`'s doc comment) rather than one being a
 *  special mode of the whole app.
 *
 *  Rendered by `App.tsx` whenever `useSources().sources` is empty in Tauri;
 *  never rendered in the browser (see that module's doc comment on the
 *  no-regression guarantee — the browser always has exactly one implicit
 *  origin source, so `sources.length === 0` never happens there). */

import { useId, useState, type FormEvent } from "react";
import { pickFolderDialog } from "../local/localStore";
import { useSources } from "./useSources";
import { BrandMark } from "../shell/BrandMark";
import styles from "./AddSourceView.module.css";

export interface AddSourceViewProps {
  /** Fired once a source has been successfully added (server login
   *  succeeded, or a folder was picked and confirmed). The parent is
   *  responsible for transitioning away from this view — `sources` in the
   *  nearest `SourcesProvider` has already grown by one at that point, so a
   *  parent that renders based on `sources.length` re-renders on its own;
   *  `onDone` exists for parents that need an explicit signal instead. */
  onDone: () => void;
}

type Mode = "server" | "folder";

/** Last non-empty path segment (`/`- or `\`-separated) of a folder path, used
 *  to prefill the folder source's label. Falls back to the full path if it
 *  has no separators at all. */
function lastPathSegment(path: string): string {
  const segments = path.split(/[/\\]+/).filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : path;
}

export function AddSourceView({ onDone }: AddSourceViewProps) {
  const { addServer, addFolder } = useSources();
  const [mode, setMode] = useState<Mode>("server");

  const labelId = useId();
  const urlId = useId();
  const usernameId = useId();
  const passwordId = useId();
  const folderLabelId = useId();

  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [folderLabel, setFolderLabel] = useState("");
  const [folderError, setFolderError] = useState<string | null>(null);
  const [addingFolder, setAddingFolder] = useState(false);

  async function handleServerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setServerError(null);
    setConnecting(true);
    try {
      await addServer(label, url, username, password);
      onDone();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Could not add this server.");
    } finally {
      setConnecting(false);
    }
  }

  async function handleChooseFolder() {
    setFolderError(null);
    const path = await pickFolderDialog();
    if (path === null) return;
    setFolderPath(path);
    setFolderLabel(lastPathSegment(path));
  }

  async function handleFolderSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!folderPath) return;
    setFolderError(null);
    setAddingFolder(true);
    try {
      await addFolder(folderLabel, folderPath);
      onDone();
    } catch (err) {
      setFolderError(err instanceof Error ? err.message : "Could not add this folder.");
    } finally {
      setAddingFolder(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.brandRow}>
          <BrandMark className={styles.logo} ring1ClassName={styles.logoRing1} ring2ClassName={styles.logoRing2} />
          <span className={styles.brandName}>ndBrain</span>
        </div>

        <h1 className={styles.title}>Add a source</h1>
        <p className={styles.subtitle}>
          Connect to an ndBrain server, or point at a local folder of markdown notes — local
          folders never leave this device.
        </p>

        <div className={styles.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "server"}
            className={mode === "server" ? styles.tabActive : styles.tab}
            onClick={() => setMode("server")}
          >
            Server
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "folder"}
            className={mode === "folder" ? styles.tabActive : styles.tab}
            onClick={() => setMode("folder")}
          >
            Folder
          </button>
        </div>

        {mode === "server" ? (
          <form className={styles.form} onSubmit={(e) => void handleServerSubmit(e)}>
            <label className={styles.field} htmlFor={labelId}>
              Label
              <input
                id={labelId}
                type="text"
                autoComplete="off"
                required
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>

            <label className={styles.field} htmlFor={urlId}>
              URL
              <input
                id={urlId}
                type="text"
                inputMode="url"
                autoComplete="url"
                placeholder="https://brain.example.com"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>

            <label className={styles.field} htmlFor={usernameId}>
              Username
              <input
                id={usernameId}
                type="text"
                autoComplete="username"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>

            <label className={styles.field} htmlFor={passwordId}>
              Password
              <input
                id={passwordId}
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>

            {serverError && (
              <p role="alert" className={styles.error}>
                {serverError}
              </p>
            )}

            <button type="submit" className={styles.submit} disabled={connecting}>
              {connecting ? "Connecting…" : "Add server"}
            </button>
          </form>
        ) : (
          <form className={styles.form} onSubmit={(e) => void handleFolderSubmit(e)}>
            <button type="button" className={styles.chooseFolder} onClick={() => void handleChooseFolder()}>
              Choose folder…
            </button>

            {folderPath && (
              <>
                <p className={styles.folderPath} title={folderPath}>
                  {folderPath}
                </p>

                <label className={styles.field} htmlFor={folderLabelId}>
                  Label
                  <input
                    id={folderLabelId}
                    type="text"
                    autoComplete="off"
                    required
                    value={folderLabel}
                    onChange={(e) => setFolderLabel(e.target.value)}
                  />
                </label>
              </>
            )}

            {folderError && (
              <p role="alert" className={styles.error}>
                {folderError}
              </p>
            )}

            {folderPath && (
              <button type="submit" className={styles.submit} disabled={addingFolder}>
                {addingFolder ? "Adding…" : "Add folder"}
              </button>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
