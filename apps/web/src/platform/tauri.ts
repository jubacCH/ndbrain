import { isTauri as detectTauriRuntime } from "@tauri-apps/api/core";

/**
 * Detects whether the app is running inside the Tauri v2 desktop shell.
 *
 * The Tauri v2 runtime injects a `window.isTauri === true` flag before any
 * page script runs (the older v1 marker was `window.__TAURI__`, which no
 * longer exists in v2). `@tauri-apps/api/core#isTauri()` reads that flag and
 * is safe to call unconditionally in a plain browser: it never touches
 * `window.__TAURI_INTERNALS__` (the actual IPC bridge), so importing this
 * module never throws outside of Tauri.
 */
export function isTauri(): boolean {
  return detectTauriRuntime();
}

/**
 * Runs `fn` only when inside the Tauri desktop shell; otherwise it is a
 * no-op that returns `undefined`. Use this to guard any `@tauri-apps/api`
 * (or plugin) call so importing/calling code stays safe in the browser
 * build, where those APIs are unavailable.
 */
export function withTauri<T>(fn: () => T): T | undefined {
  return isTauri() ? fn() : undefined;
}

/**
 * Shows a confirmation dialog and resolves to the user's choice, working in
 * both the browser and the Tauri desktop shell.
 *
 * `window.confirm` is unusable inside Tauri on macOS: its WKWebView backend
 * (via wry) implements no `runJavaScriptConfirmPanel` delegate, so WebKit
 * answers `confirm()` with `false` immediately — a confirm-gated action would
 * silently never run. Inside Tauri this delegates to the native
 * `@tauri-apps/plugin-dialog` `confirm` (loaded lazily so the browser bundle
 * never imports it); in a plain browser it falls back to `window.confirm`.
 */
export async function platformConfirm(message: string, title?: string): Promise<boolean> {
  if (isTauri()) {
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    return confirm(message, title ? { title, kind: "warning" } : undefined);
  }
  return typeof confirm === "function" ? confirm(message) : false;
}

/** Storage key for the user-configured ndBrain server URL (Tauri only, see
 * `api/base-url.ts`). */
const SERVER_URL_STORAGE_KEY = "ndbrain.serverUrl";

/**
 * Reads the persisted server URL, or `null` if none has been configured yet.
 *
 * Backed by `localStorage` rather than the Tauri v2 store plugin
 * (`@tauri-apps/plugin-store`): the Tauri webview provides a real
 * `localStorage` already, so no extra plugin dependency is needed for a
 * single string value. This function is the seam a later task would swap
 * for the store plugin (e.g. for cross-window sync) without touching
 * `base-url.ts` callers.
 */
export function getStoredServerUrl(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(SERVER_URL_STORAGE_KEY);
}

/** Persists (or clears, when `url` is `null`) the configured server URL. */
export function setStoredServerUrl(url: string | null): void {
  if (typeof localStorage === "undefined") return;
  if (url === null) {
    localStorage.removeItem(SERVER_URL_STORAGE_KEY);
  } else {
    localStorage.setItem(SERVER_URL_STORAGE_KEY, url);
  }
}
