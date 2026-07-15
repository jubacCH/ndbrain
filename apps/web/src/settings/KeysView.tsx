/** Settings view for managing API keys (list, create, revoke). Newly created keys
 *  are shown exactly once — the server never returns the secret again after the
 *  create response, so we hold it only in component state and never write it to
 *  localStorage or a log. */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiClient, type ApiKeyListEntry } from "../api/client";
import { platformConfirm } from "../platform/tauri";
import { formatTimestamp } from "./formatTimestamp";
import styles from "./Settings.module.css";

/** Structural subset of `ApiClient` this view needs — lets tests inject a fake
 *  without constructing a real client (same pattern as `SearchClient`). */
export interface KeysClient {
  listKeys(): Promise<ApiKeyListEntry[]>;
  createKey(name: string, namespace: string, canWrite: boolean, expiresAt?: string): Promise<string>;
  revokeKey(name: string): Promise<void>;
}

export interface KeysViewProps {
  client?: KeysClient;
  /** Whether this view is currently the visible one. Defaults to true (standalone
   *  rendering/tests). `AppRoot` wires settings as a view-toggle rather than an
   *  unmount-on-close route, so flipping this to false — the user closed Settings
   *  or switched to the Audit tab — is what clears a freshly shown key secret,
   *  not just an eventual component unmount. */
  active?: boolean;
}

type LoadState = "loading" | "ready" | "error";

export function KeysView({ client = apiClient, active = true }: KeysViewProps) {
  const [keys, setKeys] = useState<ApiKeyListEntry[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");

  const [name, setName] = useState("");
  const [namespace, setNamespace] = useState("");
  const [canWrite, setCanWrite] = useState(false);
  const [expiresAt, setExpiresAt] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // The freshly created secret — held only in memory, cleared once the user
  // dismisses the banner. Never persisted or logged.
  const [newKey, setNewKey] = useState<string | null>(null);

  // Also clear it the moment this view stops being the visible one (Settings
  // closed, or the user switched away to another tab) — not only on unmount —
  // so the secret never lingers in memory longer than it's actually shown.
  useEffect(() => {
    if (!active) setNewKey(null);
  }, [active]);

  const refresh = useCallback(() => {
    setLoadState("loading");
    return client
      .listKeys()
      .then((result) => {
        setKeys(result);
        setLoadState("ready");
      })
      .catch(() => {
        setLoadState("error");
      });
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const key = await client.createKey(name, namespace, canWrite, expiresAt || undefined);
      setNewKey(key);
      setName("");
      setNamespace("");
      setCanWrite(false);
      setExpiresAt("");
      await refresh();
    } catch {
      setCreateError("Failed to create the key. Please try again.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(keyName: string) {
    const confirmed = await platformConfirm(
      `Revoke API key "${keyName}"? This cannot be undone.`,
      "Revoke API key?",
    );
    if (!confirmed) return;
    setRevokeError(null);
    try {
      await client.revokeKey(keyName);
      await refresh();
    } catch {
      setRevokeError("Failed to revoke the key. Please try again.");
    }
  }

  function handleCopy() {
    if (!newKey) return;
    void navigator.clipboard?.writeText(newKey);
  }

  return (
    <div className={styles.page}>
      <section className={styles.section}>
        <h2 className={styles.heading}>API Keys</h2>

        {newKey && (
          <div className={styles.newKeyBanner}>
            <p className={styles.newKeyWarning}>Copy this key now — it won't be shown again.</p>
            <div className={styles.newKeyRow}>
              <input
                className={styles.newKeyValue}
                type="text"
                readOnly
                value={newKey}
                aria-label="New API key"
                onFocus={(event) => event.currentTarget.select()}
              />
              <button type="button" className={styles.copyButton} onClick={handleCopy}>
                Copy
              </button>
              <button type="button" className={styles.dismissButton} onClick={() => setNewKey(null)}>
                Done
              </button>
            </div>
          </div>
        )}

        <form className={styles.form} onSubmit={handleCreate}>
          <label className={styles.field}>
            Name
            <input type="text" value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label className={styles.field}>
            Namespace
            <input
              type="text"
              value={namespace}
              onChange={(event) => setNamespace(event.target.value)}
              required
            />
          </label>
          <label className={`${styles.field} ${styles.checkboxField}`}>
            <input type="checkbox" checked={canWrite} onChange={(event) => setCanWrite(event.target.checked)} />
            Can write
          </label>
          <label className={styles.field}>
            Expires
            <input type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
          </label>
          <button type="submit" className={styles.submit} disabled={creating}>
            Create key
          </button>
        </form>
        {createError && (
          <p className={styles.error} role="alert">
            {createError}
          </p>
        )}
        {revokeError && (
          <p className={styles.error} role="alert">
            {revokeError}
          </p>
        )}

        {loadState === "loading" && <p className={styles.status}>Loading keys…</p>}
        {loadState === "error" && (
          <p className={styles.error} role="alert">
            Failed to load API keys.
          </p>
        )}
        {loadState === "ready" && keys.length === 0 && <p className={styles.status}>No API keys yet.</p>}
        {loadState === "ready" && keys.length > 0 && (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Namespace</th>
                <th>Access</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.name}>
                  <td>{key.name}</td>
                  <td>{key.namespace}</td>
                  <td>{key.canWrite ? "Read/write" : "Read-only"}</td>
                  <td>{formatTimestamp(key.createdAt)}</td>
                  <td>{formatTimestamp(key.lastUsedAt)}</td>
                  <td>{formatTimestamp(key.expiresAt, "Never")}</td>
                  <td>
                    <button
                      type="button"
                      className={styles.revokeButton}
                      onClick={() => handleRevoke(key.name)}
                    >
                      Revoke
                    </button>
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
