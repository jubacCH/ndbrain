/**
 * Transitional single-folder default for `LocalNotesView`/`moveToServer`.
 *
 * `LocalNotesStore` (see `./localStore.ts`) is now constructed per folder and
 * no longer owns picking/persisting that folder itself (Plan 8 Task 3) — that
 * becomes the source registry's job (Plan 8 Task 5's "Add source" flow,
 * `sources/registry.ts`). Until the views are wired up to the registry (Plan
 * 8 Task 6/7), this module keeps the app working with exactly one local
 * folder: it owns the folder-path persistence `LocalNotesStore` used to do
 * itself, and lazily (re)builds a `LocalNotesStore` for whichever folder is
 * currently persisted.
 *
 * DELETE this module once `LocalNotesView`/`moveToServer` take an
 * already-scoped store from the registry instead of a default.
 */
import { load as loadTauriStore, type Store } from "@tauri-apps/plugin-store";
import { isTauri } from "../platform/tauri";
import { LocalNotesStore, LocalPathError, pickFolderDialog, type LocalNoteSummary } from "./localStore";

const STORE_FILE = "local-notes.json";
const FOLDER_KEY = "folderPath";

/** The shape `LocalNotesView`/`moveToServer` depend on for their default
 *  store — the old, folder-owning `LocalNotesStore` interface, kept alive
 *  here only for this transitional single-folder default. */
export interface DefaultLocalNotesStoreLike {
  getFolder(): Promise<string | null>;
  pickFolder(): Promise<string | null>;
  listLocal(): Promise<LocalNoteSummary[]>;
  readLocal(rel: string): Promise<string>;
  writeLocal(rel: string, content: string): Promise<void>;
  deleteLocal(rel: string): Promise<boolean>;
  grantFolderAccess(path: string): Promise<void>;
}

class DefaultLocalNotesStore implements DefaultLocalNotesStoreLike {
  private storePromise: Promise<Store> | null = null;
  private scoped: { path: string; store: LocalNotesStore } | null = null;

  private getTauriStore(): Promise<Store> {
    if (!this.storePromise) {
      this.storePromise = loadTauriStore(STORE_FILE, { defaults: {} });
    }
    return this.storePromise;
  }

  /** Reuses the last `LocalNotesStore` built for `path` (state, e.g. a
   *  granted fs scope grant, lives on the store instance) rather than
   *  constructing a fresh one on every call. */
  private storeFor(path: string): LocalNotesStore {
    if (!this.scoped || this.scoped.path !== path) {
      this.scoped = { path, store: new LocalNotesStore(path) };
    }
    return this.scoped.store;
  }

  async getFolder(): Promise<string | null> {
    if (!isTauri()) return null;
    const store = await this.getTauriStore();
    const path = await store.get<string>(FOLDER_KEY);
    return path ?? null;
  }

  async pickFolder(): Promise<string | null> {
    if (!isTauri()) return null;
    const path = await pickFolderDialog();
    if (path) {
      const store = await this.getTauriStore();
      await store.set(FOLDER_KEY, path);
      await store.save();
    }
    return path;
  }

  async grantFolderAccess(path: string): Promise<void> {
    if (!isTauri()) return;
    await this.storeFor(path).grantFolderAccess();
  }

  async listLocal(): Promise<LocalNoteSummary[]> {
    if (!isTauri()) return [];
    const path = await this.getFolder();
    if (!path) return [];
    return this.storeFor(path).listLocal();
  }

  async readLocal(rel: string): Promise<string> {
    if (!isTauri()) return "";
    const path = await this.getFolder();
    if (!path) throw new LocalPathError("no local notes folder configured");
    return this.storeFor(path).readLocal(rel);
  }

  async writeLocal(rel: string, content: string): Promise<void> {
    if (!isTauri()) return;
    const path = await this.getFolder();
    if (!path) throw new LocalPathError("no local notes folder configured");
    await this.storeFor(path).writeLocal(rel, content);
  }

  async deleteLocal(rel: string): Promise<boolean> {
    if (!isTauri()) return false;
    const path = await this.getFolder();
    if (!path) return false;
    return this.storeFor(path).deleteLocal(rel);
  }
}

/** Shared singleton, mirroring the old `localNotesStore` — the app uses one
 *  of these for its whole lifetime; tests inject their own fake store. */
export const defaultLocalNotesStore: DefaultLocalNotesStoreLike = new DefaultLocalNotesStore();
