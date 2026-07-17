/** Persisted "local-only mode" flag for the Tauri desktop client (see
 *  `shell/LocalOnlyShell.tsx`'s doc comment for the feature this backs).
 *
 *  Backed by `localStorage`, same pattern as `platform/tauri.ts`'s
 *  `getStoredServerUrl`/`setStoredServerUrl` - a single boolean doesn't
 *  warrant the Tauri v2 store plugin. No-op-safe when `localStorage` is
 *  unavailable (defaults to `false`, `setLocalOnly` silently does nothing). */

const LOCAL_ONLY_STORAGE_KEY = "ndbrain.localOnly";

/** Whether the app should skip the server entirely and go straight to the
 *  local-notes-only shell. `false` if never set (or if `localStorage` is
 *  unavailable). */
export function isLocalOnly(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(LOCAL_ONLY_STORAGE_KEY) === "true";
}

/** Persists (or clears) the local-only flag. */
export function setLocalOnly(value: boolean): void {
  if (typeof localStorage === "undefined") return;
  if (value) {
    localStorage.setItem(LOCAL_ONLY_STORAGE_KEY, "true");
  } else {
    localStorage.removeItem(LOCAL_ONLY_STORAGE_KEY);
  }
}
