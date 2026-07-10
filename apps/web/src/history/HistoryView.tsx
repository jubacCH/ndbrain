/** Read-only git history view for the currently selected note. Fetches
 *  `GET /history/*` and lists commits (message, author, relative date).
 *
 *  Restore is intentionally NOT implemented yet: the current REST surface
 *  (`ApiClient`) has no way to fetch a note's content as of a specific past
 *  commit — `history()` only returns commit metadata (hash/message/author/date),
 *  and `getNote()` always reads the current working-tree version. Faking a
 *  restore from that data would silently write the wrong content, so each
 *  commit instead gets a disabled "Restore" button with a TODO.
 *
 *  TODO(server): add a `GET /api/v1/history/<path>/:hash` route returning the
 *  note's content at that commit, then wire this button to `putNote(path,
 *  content)` (or add a dedicated `POST /api/v1/history/<path>/:hash/restore`
 *  that does the read+write server-side in one step). */

import { useEffect, useState } from "react";
import { apiClient, type HistoryEntry } from "../api/client";
import { useAppState } from "../shell/AppState";
import { formatDate } from "./formatDate";
import styles from "./HistoryView.module.css";

/** Structural subset of `ApiClient` this component needs — lets tests inject a
 *  fake without constructing a real client (same pattern as `NoteTreeClient`). */
export interface HistoryClient {
  history(path: string): Promise<HistoryEntry[]>;
}

export interface HistoryViewProps {
  client?: HistoryClient;
}

const RESTORE_UNAVAILABLE_REASON =
  "Restore is not yet supported — needs a server endpoint to fetch note content by commit hash.";

export function HistoryView({ client = apiClient }: HistoryViewProps = {}) {
  const { selectedPath } = useAppState();
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedPath === null) {
      setEntries(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setEntries(null);
    setError(null);

    client
      .history(selectedPath)
      .then((result) => {
        if (cancelled) return;
        setEntries(result);
      })
      .catch(() => {
        if (cancelled) return;
        setEntries([]);
        setError("Failed to load history.");
      });

    return () => {
      cancelled = true;
    };
  }, [client, selectedPath]);

  return (
    <section className={styles.view} aria-label="History">
      <h2 className={styles.heading}>History</h2>

      {selectedPath === null && <p className={styles.status}>No note selected.</p>}

      {selectedPath !== null && entries === null && !error && (
        <p className={styles.status}>Loading history…</p>
      )}

      {error && (
        <p className={styles.status} role="alert">
          {error}
        </p>
      )}

      {selectedPath !== null && entries !== null && !error && entries.length === 0 && (
        <p className={styles.status}>No history yet.</p>
      )}

      {entries !== null && entries.length > 0 && (
        <ul className={styles.list}>
          {entries.map((entry) => (
            <li key={entry.hash} className={styles.entry}>
              <div className={styles.entryMain}>
                <span className={styles.message}>{entry.message}</span>
                <span className={styles.meta}>
                  <span className={styles.author}>{entry.author}</span>
                  <span aria-hidden="true"> · </span>
                  <span className={styles.date}>{formatDate(entry.date)}</span>
                </span>
              </div>
              <button
                type="button"
                className={styles.restore}
                disabled
                title={RESTORE_UNAVAILABLE_REASON}
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
