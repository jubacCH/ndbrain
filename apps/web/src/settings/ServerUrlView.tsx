import { useId, useState, type FormEvent } from "react";
import { isTauri } from "../platform/tauri";
import { getServerUrl, setServerUrl } from "../api/base-url";
import styles from "./ServerUrlView.module.css";

export interface ServerUrlViewProps {
  /** Called once a server URL has been validated (reachable) and persisted via
   *  `setServerUrl`. The parent is responsible for transitioning to the normal
   *  login flow, which will now target the configured server (see
   *  `api/base-url.ts#getApiBaseUrl`). */
  onConnected?: () => void;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Note lookup is a real route on every ndBrain server and requires no body,
 *  so it doubles as a lightweight reachability ping. Its 401-without-a-cookie
 *  response (or any other HTTP status) still counts as "reachable" - only a
 *  network-level failure (DNS, TLS, connection refused, CORS) throws and is
 *  treated as unreachable. */
const PING_PATH = "/api/v1/notes";

/** Normalizes a user-entered server URL: trims whitespace, strips a trailing
 *  slash (so it composes cleanly with fixed suffixes like `/api/v1`, matching
 *  `api/base-url.ts`'s own normalization), and requires an explicit http(s)
 *  scheme. Throws an `Error` with a user-facing message otherwise. */
function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("Enter a server URL.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Enter a valid URL, e.g. https://brain.example.com.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The server URL must start with http:// or https://.");
  }
  return trimmed;
}

/** First-run server URL entry for the Tauri desktop client.
 *
 *  The desktop shell has no same-origin server to talk to (it loads local app
 *  assets, not the ndBrain server - see `api/base-url.ts`), so before any
 *  login attempt the user must point the app at their self-hosted server.
 *
 *  Self-gating: renders nothing in the browser, and nothing once a server URL
 *  is already configured. Both checks are re-evaluated on every render (not
 *  just at mount) so the form disappears the instant `setServerUrl` persists
 *  a value, with no separate "connected" flag needed from the parent. */
export function ServerUrlView({ onConnected, fetchImpl = fetch }: ServerUrlViewProps) {
  const inputId = useId();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  if (!isTauri() || getServerUrl() !== null) {
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    let normalized: string;
    try {
      normalized = normalizeServerUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Enter a valid URL.");
      return;
    }

    setConnecting(true);
    try {
      await fetchImpl(`${normalized}${PING_PATH}`, { method: "GET" });
    } catch {
      setError("Could not reach that server. Check the URL and try again.");
      setConnecting(false);
      return;
    }

    setServerUrl(normalized);
    setConnecting(false);
    onConnected?.();
  }

  return (
    <div className={styles.page}>
      <form className={styles.card} onSubmit={(e) => void handleSubmit(e)}>
        <h1 className={styles.brand}>ndBrain</h1>
        <p className={styles.subtitle}>Connect to your ndBrain server</p>

        <label className={styles.field} htmlFor={inputId}>
          Server URL
          <input
            id={inputId}
            name="serverUrl"
            type="text"
            inputMode="url"
            autoComplete="url"
            placeholder="https://brain.example.com"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>

        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}

        <button type="submit" className={styles.submit} disabled={connecting}>
          {connecting ? "Connecting…" : "Connect"}
        </button>
      </form>
    </div>
  );
}
