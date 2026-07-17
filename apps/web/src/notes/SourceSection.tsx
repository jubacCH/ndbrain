/** One sidebar section per registered source — the core of the unified
 *  sidebar: local folders and remote servers sit side by side in the same
 *  list, distinguishable by a `device` marker rather than living in two
 *  separate UIs (a plain browser has exactly one section and no header at
 *  all — see `showHeader`).
 *
 *  Lists a source's notes once it is `"connected"` (`client.listNotes()` for
 *  a `server`, `store.listLocal()` for a `folder`), offers inline "+ New
 *  note" creation scoped to *this* source only, and degrades gracefully for
 *  every other `SourceState` without blocking any other section:
 *  `"needs-login"` shows an inline sign-in form, `"unreachable"` shows a
 *  retry button, `"connecting"` a quiet hint — each section owns its own
 *  local state, so one source's degraded state can never affect another's
 *  (same isolation guarantee `SourcesProvider` gives the runtime itself).
 *
 *  No `window.prompt`/`confirm` anywhere here (see `platform/tauri.ts`'s doc
 *  comment: both are unusable/dead in the Tauri webview) — creation uses the
 *  same inline-input pattern the pre-unification `NoteTree` used. */

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useSources } from "../sources/useSources";
import type { NoteSelection, SourceRuntime, SourceState } from "../sources/types";
import styles from "./SourceSection.module.css";

interface SectionNote {
  path: string;
  title: string | null;
}

export interface SourceSectionProps {
  runtime: SourceRuntime;
  selection: NoteSelection | null;
  onSelect: (selection: NoteSelection) => void;
  /** Whether to render the section header (label + count + state chip +
   *  device marker). `AppRoot` passes `false` when there is exactly one
   *  source (the plain browser) so a single implicit source never grows a
   *  redundant "SERVER" header nobody asked for. */
  showHeader: boolean;
}

function stateLabel(state: SourceState): string {
  switch (state) {
    case "connecting":
      return "Connecting…";
    case "needs-login":
      return "Needs sign-in";
    case "unreachable":
      return "Unreachable";
    default:
      return "";
  }
}

export function SourceSection({ runtime, selection, onSelect, showHeader }: SourceSectionProps) {
  const { login, retry } = useSources();
  const { def, state } = runtime;

  const [notes, setNotes] = useState<SectionNote[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [isCreating, setIsCreating] = useState(false);
  const [newNotePath, setNewNotePath] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const newNoteInputRef = useRef<HTMLInputElement>(null);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result =
        runtime.kind === "server" ? await runtime.client.listNotes() : await runtime.store.listLocal();
      setNotes([...result].sort((a, b) => a.path.localeCompare(b.path)));
      setListError(null);
    } catch {
      setNotes([]);
      setListError("Failed to load notes.");
    }
  }, [runtime]);

  useEffect(() => {
    if (state !== "connected") {
      setNotes(null);
      return;
    }
    void refresh();
  }, [state, refresh]);

  useEffect(() => {
    if (isCreating) newNoteInputRef.current?.focus();
  }, [isCreating]);

  function openNewNoteInput() {
    setCreateError(null);
    setNewNotePath("");
    setIsCreating(true);
  }

  function closeNewNoteInput() {
    setIsCreating(false);
    setNewNotePath("");
    setCreateError(null);
  }

  async function submitNewNote() {
    const path = newNotePath.trim();
    if (!path) return;
    if (!path.toLowerCase().endsWith(".md")) {
      setCreateError("Path must end with .md");
      return;
    }
    if (notes?.some((note) => note.path === path)) {
      setCreateError("A note with this path already exists.");
      return;
    }

    const fileName = path.split("/").pop() ?? path;
    const title = fileName.slice(0, -3);
    setCreateError(null);
    try {
      if (runtime.kind === "server") {
        await runtime.client.putNote(path, `# ${title}\n`);
      } else {
        await runtime.store.writeLocal(path, `# ${title}\n`);
      }
      await refresh();
      onSelect({ sourceId: def.id, path });
      closeNewNoteInput();
    } catch {
      setCreateError("Failed to create the note.");
    }
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

  async function handleLoginSubmit(event: FormEvent) {
    event.preventDefault();
    setLoginError(null);
    setLoggingIn(true);
    try {
      await login(def.id, username, password);
      setPassword("");
    } catch {
      setLoginError("Sign-in failed.");
    } finally {
      setLoggingIn(false);
    }
  }

  function handleRetry() {
    retry(def.id);
  }

  return (
    <section className={styles.section} aria-label={def.label}>
      {showHeader && (
        <div className={styles.header}>
          <span className={styles.label}>{def.label}</span>
          <span className={styles.meta}>
            {runtime.kind === "folder" && <span className={styles.marker}>device</span>}
            {state !== "connected" && <span className={styles.chip}>{stateLabel(state)}</span>}
            <span className={styles.count}>{notes?.length ?? 0}</span>
          </span>
        </div>
      )}

      {state === "connecting" && <p className={styles.hint}>Connecting…</p>}

      {state === "needs-login" && (
        <form className={styles.loginForm} onSubmit={(event) => void handleLoginSubmit(event)}>
          <p className={styles.hint}>Sign in to {def.label}.</p>
          <input
            type="text"
            aria-label={`Username for ${def.label}`}
            className={styles.loginInput}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
          <input
            type="password"
            aria-label={`Password for ${def.label}`}
            className={styles.loginInput}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button type="submit" className={styles.loginSubmit} disabled={loggingIn}>
            Sign in
          </button>
          {loginError && (
            <p className={styles.status} role="alert">
              {loginError}
            </p>
          )}
        </form>
      )}

      {state === "unreachable" && (
        <div className={styles.errorRow}>
          <p className={styles.status} role="alert">
            Could not reach {def.label}.
          </p>
          <button type="button" className={styles.retryButton} onClick={handleRetry}>
            Retry
          </button>
        </div>
      )}

      {state === "connected" && (
        <>
          <div className={styles.actions}>
            {!isCreating && (
              <button type="button" className={styles.newNote} onClick={openNewNoteInput}>
                + New note
              </button>
            )}
          </div>

          {isCreating && (
            <div className={styles.newNoteRow}>
              <input
                ref={newNoteInputRef}
                type="text"
                className={styles.newNoteInput}
                aria-label="Path for the new note"
                placeholder="folder/note.md"
                value={newNotePath}
                onChange={(event) => setNewNotePath(event.target.value)}
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

          {listError && (
            <p className={styles.status} role="alert">
              {listError}
            </p>
          )}
          {createError && (
            <p className={styles.status} role="alert">
              {createError}
            </p>
          )}

          {notes === null && !listError && <p className={styles.status}>Loading notes…</p>}
          {notes !== null && !listError && notes.length === 0 && (
            <p className={styles.status}>No notes yet — create your first one.</p>
          )}

          <ul className={styles.list}>
            {notes?.map((note) => {
              const isSelected = selection?.sourceId === def.id && selection.path === note.path;
              return (
                <li key={note.path}>
                  <button
                    type="button"
                    className={isSelected ? `${styles.note} ${styles.selected}` : styles.note}
                    onClick={() => onSelect({ sourceId: def.id, path: note.path })}
                    aria-current={isSelected ? "page" : undefined}
                  >
                    {note.title ?? note.path}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
