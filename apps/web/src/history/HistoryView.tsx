/** Read-only git history view for the currently selected note. Fetches
 *  `GET /history/*` and lists commits (message, author, relative date).
 *
 *  History (like backlinks) only exists for `server` sources — the vault's
 *  git history has no equivalent for a plain `folder` source, so this never
 *  calls a client for one (there isn't one) and shows a quiet notice instead.
 *  Uses the *selected source's own* client (via `useSources()`), never a
 *  global singleton — see `BacklinksPanel`'s identical rationale.
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
import type { HistoryEntry } from "../api/client";
import { useAppState } from "../shell/AppState";
import { useSources } from "../sources/useSources";
import { formatDate } from "./formatDate";
import styles from "./HistoryView.module.css";

const RESTORE_UNAVAILABLE_REASON =
  "Restore is not yet supported — needs a server endpoint to fetch note content by commit hash.";

export function HistoryView() {
  const { selection } = useAppState();
  const { sources } = useSources();
  const runtime = selection ? sources.find((s) => s.def.id === selection.sourceId) : undefined;
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selection || !runtime || runtime.kind !== "server") {
      setEntries(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setEntries(null);
    setError(null);

    runtime.client
      .history(selection.path)
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
  }, [selection, runtime]);

  const isFolderSelection = selection !== null && runtime?.kind === "folder";

  return (
    <section className={styles.view} aria-label="History">
      <h2 className={styles.heading}>History</h2>

      {selection === null && <p className={styles.status}>No note selected.</p>}

      {isFolderSelection && <p className={styles.status}>Not available for local notes.</p>}

      {selection !== null && !isFolderSelection && entries === null && !error && (
        <p className={styles.status}>Loading history…</p>
      )}

      {error && (
        <p className={styles.status} role="alert">
          {error}
        </p>
      )}

      {selection !== null && !isFolderSelection && entries !== null && !error && entries.length === 0 && (
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
