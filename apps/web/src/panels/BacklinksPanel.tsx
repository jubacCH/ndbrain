/** Sidebar/inspector panel that lists notes linking to the currently selected
 *  note ("backlinks"). Fetches `GET /backlinks/*` for `useAppState().selectedPath`
 *  and refetches whenever the selection changes; clicking a backlink navigates
 *  there via `setSelectedPath` — the same decoupled pattern as `NoteTree`. */

import { useEffect, useState } from "react";
import { apiClient } from "../api/client";
import { useAppState } from "../shell/AppState";
import styles from "./BacklinksPanel.module.css";

/** Structural subset of `ApiClient` this component needs — lets tests inject a
 *  fake without constructing a real client (same pattern as `NoteTreeClient`). */
export interface BacklinksClient {
  backlinks(path: string): Promise<string[]>;
}

export interface BacklinksPanelProps {
  client?: BacklinksClient;
}

export function BacklinksPanel({ client = apiClient }: BacklinksPanelProps = {}) {
  const { selectedPath, setSelectedPath } = useAppState();
  const [backlinks, setBacklinks] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedPath === null) {
      setBacklinks(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setBacklinks(null);
    setError(null);

    client
      .backlinks(selectedPath)
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
  }, [client, selectedPath]);

  return (
    <section className={styles.panel} aria-label="Backlinks">
      <h2 className={styles.heading}>Backlinks</h2>

      {selectedPath === null && <p className={styles.status}>No note selected.</p>}

      {selectedPath !== null && backlinks === null && !error && (
        <p className={styles.status}>Loading backlinks…</p>
      )}

      {error && (
        <p className={styles.status} role="alert">
          {error}
        </p>
      )}

      {selectedPath !== null && backlinks !== null && !error && backlinks.length === 0 && (
        <p className={styles.status}>No backlinks.</p>
      )}

      {backlinks !== null && backlinks.length > 0 && (
        <ul className={styles.list}>
          {backlinks.map((path) => (
            <li key={path}>
              <button type="button" className={styles.item} onClick={() => setSelectedPath(path)}>
                {path}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
