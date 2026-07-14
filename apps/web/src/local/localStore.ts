/**
 * Device-local notes store (Task 4).
 *
 * STRICT ISOLATION: everything in this module reads/writes a markdown folder
 * the user picked on their own filesystem, via the Tauri v2 `fs`/`dialog`/
 * `store` plugins. Nothing here ever calls `@ndbrain/server`'s HTTP API, the
 * vault, or MCP — local notes are invisible to the server and to agents by
 * construction (there is no code path from this module to `../api/*`). The
 * only way a local note reaches the server is the explicit "move to server"
 * action (a separate feature), which is not implemented in this file.
 *
 * Only functional inside the Tauri desktop shell: in a plain browser
 * (`!isTauri()`) every method is a safe no-op (empty array / null / false /
 * no-op write) and never touches `@tauri-apps/*`, so importing this module
 * has zero effect on the existing web app.
 */
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { mkdir, readDir, readTextFile, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import { load as loadTauriStore, type Store } from "@tauri-apps/plugin-store";
import { isTauri } from "../platform/tauri";

const STORE_FILE = "local-notes.json";
const FOLDER_KEY = "folderPath";

export class LocalPathError extends Error {}

export interface LocalNoteSummary {
  path: string;
  title: string | null;
}

/**
 * Rejects absolute paths and `..` traversal in a local-notes-relative path
 * (same spirit as the server's `Vault.assertSafePath`, reimplemented here so
 * this module never imports server code). Accepts `/`- or `\`-separated
 * input and normalizes to `/`.
 */
export function assertSafeRelPath(rel: string): string {
  if (rel.length === 0) throw new LocalPathError("empty path");
  if (/^[/\\]/.test(rel) || /^[a-zA-Z]:[/\\]/.test(rel)) {
    throw new LocalPathError(`unsafe path: ${rel}`);
  }
  const segments = rel.split(/[/\\]+/).filter((s) => s.length > 0);
  if (segments.length === 0 || segments.some((s) => s === ".." || s === ".")) {
    throw new LocalPathError(`unsafe path: ${rel}`);
  }
  return segments.join("/");
}

/** Extracts a title from a note's first markdown heading (`# `..`###### `).
 *  Returns `null` if the note has no heading. Deliberately minimal — this is
 *  not the server's title extractor, just enough to label local notes in the
 *  picker/search UI. */
export function extractTitle(content: string): string | null {
  const match = content.match(/^#{1,6}[ \t]+(.+?)[ \t]*$/m);
  return match ? match[1].trim() || null : null;
}

/** Joins a local-notes root with an already-safe relative path. Always uses
 *  forward slashes: the Tauri v2 fs plugin (backed by Rust's `Path`) accepts
 *  `/`-separated paths on Windows as well as Unix, so no per-OS branching is
 *  needed here. */
function joinPath(root: string, rel: string): string {
  if (!rel) return root;
  const trimmedRoot = root.replace(/[/\\]+$/, "");
  return `${trimmedRoot}/${rel}`;
}

function parentOf(rel: string): string | null {
  const idx = rel.lastIndexOf("/");
  return idx === -1 ? null : rel.slice(0, idx);
}

export class LocalNotesStore {
  private storePromise: Promise<Store> | null = null;

  private getTauriStore(): Promise<Store> {
    if (!this.storePromise) {
      this.storePromise = loadTauriStore(STORE_FILE, { defaults: {} });
    }
    return this.storePromise;
  }

  /** Opens the native directory picker and persists the chosen folder as the
   *  local-notes root. Returns `null` if the user cancels (or in the
   *  browser, where it is a no-op). */
  async pickFolder(): Promise<string | null> {
    if (!isTauri()) return null;
    const selected = await openDialog({ directory: true, multiple: false });
    const path = Array.isArray(selected) ? (selected[0] ?? null) : selected;
    if (path) await this.setFolder(path);
    return path;
  }

  /** The persisted local-notes root, or `null` if none has been picked yet
   *  (or in the browser). */
  async getFolder(): Promise<string | null> {
    if (!isTauri()) return null;
    const store = await this.getTauriStore();
    const path = await store.get<string>(FOLDER_KEY);
    return path ?? null;
  }

  async setFolder(path: string): Promise<void> {
    if (!isTauri()) return;
    const store = await this.getTauriStore();
    await store.set(FOLDER_KEY, path);
    await store.save();
  }

  /** Extends the Tauri fs plugin's runtime scope to cover `path`, recursively,
   *  via the app's own `allow_local_notes_folder` Rust command (see
   *  `apps/desktop/src-tauri/src/lib.rs`). This module's fs permissions
   *  (`fs:allow-read-text-file` etc., see
   *  `apps/desktop/src-tauri/capabilities/default.json`) are deliberately
   *  declared WITHOUT any compile-time scope of their own — actual filesystem
   *  access is governed entirely by the plugin's runtime `Scope`, and this
   *  method is what grants it. It's the only mechanism Tauri v2's
   *  static-by-default capability system offers for a directory chosen at
   *  runtime rather than known at build time (see the Task 5 report for the
   *  full trace against the `tauri`/`tauri-plugin-fs` source).
   *
   *  The runtime scope is in-memory only and does NOT survive an app
   *  restart — unlike the persisted `folderPath` (see `getFolder`/`setFolder`
   *  above). Callers (see `LocalNotesView`) must call this both right after
   *  `pickFolder()` resolves AND when restoring a previously persisted
   *  folder on a fresh app launch. Idempotent; safe to call repeatedly.
   *  No-op in the browser. */
  async grantFolderAccess(path: string): Promise<void> {
    if (!isTauri()) return;
    await invoke("allow_local_notes_folder", { path });
  }

  /** Recursively lists every `.md` file under the local-notes folder, as
   *  root-relative POSIX paths, with a best-effort title parsed from each
   *  file's first heading. Empty array if no folder is configured (or in
   *  the browser). Skips dotfiles/dot-directories (e.g. `.git`, `.DS_Store`)
   *  the same way the server vault never surfaces its `.git` metadata. */
  async listLocal(): Promise<LocalNoteSummary[]> {
    if (!isTauri()) return [];
    const root = await this.getFolder();
    if (!root) return [];
    const results: LocalNoteSummary[] = [];
    await this.walk(root, "", results);
    results.sort((a, b) => a.path.localeCompare(b.path));
    return results;
  }

  private async walk(root: string, relDir: string, results: LocalNoteSummary[]): Promise<void> {
    const absDir = relDir ? joinPath(root, relDir) : root;
    const entries = await readDir(absDir);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        await this.walk(root, rel, results);
      } else if (entry.isFile && entry.name.toLowerCase().endsWith(".md")) {
        // A single unreadable file (permissions, a broken symlink, a file that
        // vanished between `readDir` and `readTextFile`) must not take down the
        // whole listing — skip it (title-less, still shown as `null`-titled) and
        // keep walking the rest of the folder. Task 5 review minor (T4).
        try {
          const content = await readTextFile(joinPath(root, rel));
          results.push({ path: rel, title: extractTitle(content) });
        } catch {
          results.push({ path: rel, title: null });
        }
      }
    }
  }

  /** Reads a local note by root-relative path. Throws `LocalPathError` for
   *  an unsafe path or when no folder is configured. Returns `""` in the
   *  browser without validating `rel` (safe no-op contract). */
  async readLocal(rel: string): Promise<string> {
    if (!isTauri()) return "";
    const safeRel = assertSafeRelPath(rel);
    const root = await this.getFolder();
    if (!root) throw new LocalPathError("no local notes folder configured");
    return readTextFile(joinPath(root, safeRel));
  }

  /** Writes a local note by root-relative path, creating parent directories
   *  as needed (`mkdir -p`). No-op in the browser. */
  async writeLocal(rel: string, content: string): Promise<void> {
    if (!isTauri()) return;
    const safeRel = assertSafeRelPath(rel);
    const root = await this.getFolder();
    if (!root) throw new LocalPathError("no local notes folder configured");
    const parentRel = parentOf(safeRel);
    if (parentRel) await mkdir(joinPath(root, parentRel), { recursive: true });
    await writeTextFile(joinPath(root, safeRel), content);
  }

  /** Deletes a local note by root-relative path. Returns whether it existed.
   *  `false` in the browser, when no folder is configured, or when the
   *  remove fails (e.g. the file was already gone) — Tauri IPC errors don't
   *  carry a reliable ENOENT code to distinguish "missing" from other
   *  failures the way Node's `fs` does, so any failure collapses to `false`
   *  rather than risking a false rethrow. */
  async deleteLocal(rel: string): Promise<boolean> {
    if (!isTauri()) return false;
    const safeRel = assertSafeRelPath(rel);
    const root = await this.getFolder();
    if (!root) return false;
    try {
      await remove(joinPath(root, safeRel));
      return true;
    } catch {
      return false;
    }
  }
}

/** Shared singleton, mirroring `apiClient` in `../api/client.ts` — the app
 *  uses one store for its whole lifetime; tests construct their own
 *  `new LocalNotesStore()`. */
export const localNotesStore = new LocalNotesStore();
