/** Settings view for the tool-call audit log — read-only, newest first (the
 *  server already orders `GET /api/v1/audit` that way). */

import { useCallback, useEffect, useState } from "react";
import { apiClient, type AuditEntry } from "../api/client";
import { formatTimestamp } from "./formatTimestamp";
import styles from "./Settings.module.css";

/** Structural subset of `ApiClient` this view needs — lets tests inject a fake
 *  without constructing a real client (same pattern as `KeysClient`). */
export interface AuditClient {
  audit(limit?: number): Promise<AuditEntry[]>;
}

export interface AuditViewProps {
  client?: AuditClient;
}

type LoadState = "loading" | "ready" | "error";

const LIMIT_OPTIONS = [50, 100, 200, 500];
const DEFAULT_LIMIT = 100;

export function AuditView({ client = apiClient }: AuditViewProps) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [limit, setLimit] = useState(DEFAULT_LIMIT);

  const refresh = useCallback(
    (currentLimit: number) => {
      setLoadState("loading");
      client
        .audit(currentLimit)
        .then((result) => {
          setEntries(result);
          setLoadState("ready");
        })
        .catch(() => {
          setLoadState("error");
        });
    },
    [client],
  );

  useEffect(() => {
    refresh(limit);
  }, [refresh, limit]);

  return (
    <div className={styles.page}>
      <section className={styles.section}>
        <div className={styles.headerRow}>
          <h2 className={styles.heading}>Audit Log</h2>
          <label className={styles.field}>
            Show
            <select
              className={styles.limitSelect}
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
            >
              {LIMIT_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>

        {loadState === "loading" && <p className={styles.status}>Loading audit log…</p>}
        {loadState === "error" && (
          <p className={styles.error} role="alert">
            Failed to load the audit log.
          </p>
        )}
        {loadState === "ready" && entries.length === 0 && (
          <p className={styles.status}>No audit entries yet.</p>
        )}
        {loadState === "ready" && entries.length > 0 && (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Time</th>
                <th>Key</th>
                <th>Tool</th>
                <th>Target</th>
                <th>Allowed</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => (
                <tr key={`${entry.ts}-${index}`}>
                  <td className={styles.mono}>{formatTimestamp(entry.ts)}</td>
                  <td className={styles.mono}>{entry.keyName ?? "—"}</td>
                  <td className={styles.mono}>{entry.tool}</td>
                  <td className={styles.mono}>{entry.target ?? "—"}</td>
                  <td>
                    <span
                      className={
                        entry.allowed
                          ? `${styles.badge} ${styles.badgeAllowed}`
                          : `${styles.badge} ${styles.badgeDenied}`
                      }
                    >
                      {entry.allowed ? "Allowed" : "Denied"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
