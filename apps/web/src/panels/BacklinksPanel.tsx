/** Sidebar/inspector panel that lists notes linking to the currently selected
 *  note ("backlinks"). Fetches `GET /backlinks/*` for `useAppState().selection`
 *  and refetches whenever the selection changes; clicking a backlink navigates
 *  there via `setSelection` — the same decoupled pattern as `NoteTree`/`SourceSection`.
 *
 *  Backlinks only exist for `server` sources (the vault's git-backed link
 *  index) — a `folder` source has no such index, so this never calls its
 *  client (there isn't one) and shows a quiet notice instead. The client used
 *  is the *selected source's own* (via `useSources()`), not a global
 *  singleton, so backlinks are always looked up against the right server. */

import { useEffect, useState } from "react";
import { useAppState } from "../shell/AppState";
import { useSources } from "../sources/useSources";
import styles from "./BacklinksPanel.module.css";

export function BacklinksPanel() {
  const { selection, setSelection } = useAppState();
  const { sources } = useSources();
  const runtime = selection ? sources.find((s) => s.def.id === selection.sourceId) : undefined;
  const [backlinks, setBacklinks] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selection || !runtime || runtime.kind !== "server") {
      setBacklinks(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setBacklinks(null);
    setError(null);

    runtime.client
      .backlinks(selection.path)
      .then((result) => {
        if (cancelled) return;
        setBacklinks(result);
      })
      .catch(() => {
        if (cancelled) return;
        setBacklinks([]);
        setError("Failed to load backlinks.");
      });

    return () => {
      cancelled = true;
    };
  }, [selection, runtime]);

  const isFolderSelection = selection !== null && runtime?.kind === "folder";

  return (
    <section className={styles.panel} aria-label="Backlinks">
      <h2 className={styles.heading}>Backlinks</h2>

      {selection === null && <p className={styles.status}>No note selected.</p>}

      {isFolderSelection && <p className={styles.status}>Not available for local notes.</p>}

      {selection !== null && !isFolderSelection && backlinks === null && !error && (
        <p className={styles.status}>Loading backlinks…</p>
      )}

      {error && (
        <p className={styles.status} role="alert">
          {error}
        </p>
      )}

      {selection !== null && !isFolderSelection && backlinks !== null && !error && backlinks.length === 0 && (
        <p className={styles.status}>No backlinks.</p>
      )}

      {backlinks !== null && backlinks.length > 0 && (
        <ul className={styles.list}>
          {backlinks.map((path) => (
            <li key={path}>
              <button
                type="button"
                className={styles.item}
                onClick={() => setSelection({ sourceId: selection!.sourceId, path })}
              >
                {path}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
