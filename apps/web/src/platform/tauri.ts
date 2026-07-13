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
