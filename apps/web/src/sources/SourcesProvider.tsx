/**
 * Owns the live runtime for every configured ndBrain source: one `ApiClient`
 * per `server` source, one `LocalNotesStore` per `folder` source, and each
 * source's own auth/connection state (`SourceState`) - fully independent of
 * every other source's (see the plan's auth-isolation guarantee).
 *
 * BROWSER, NO REGRESSION (hard requirement): outside of Tauri, there is
 * exactly one implicit `"origin"` server source pointed at `""` (same-origin,
 * relative REST calls exactly as before this module existed). The registry
 * (`registry.ts`, `localStorage`) is never read or written in the browser,
 * and `addServer`/`addFolder`/`remove`/`rename` are all no-ops - the existing
 * single-server browser app keeps behaving exactly as it did pre-Plan-8.
 *
 * AUTH ISOLATION (hard requirement): each server runtime's `ApiClient` gets
 * its own `setUnauthorizedHandler` callback, which flips only that source's
 * state to `"needs-login"`. A 401 (or explicit `logout()`) on one source can
 * never affect any other source's state.
 *
 * NETWORK ISOLATION (hard requirement): folder sources are always
 * `"connected"` and are never probed - they have no network path to fail on.
 * The only thing done for them is `store.grantFolderAccess()`, a local Tauri
 * IPC call (no `fetch`), both when a folder source is first added and when
 * restoring one from the registry on mount (the Tauri fs plugin's runtime
 * scope does not survive an app restart, see `LocalNotesStore`'s docs).
 */
import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createApiClient, UnauthorizedError, type ApiClient } from "../api/client";
import { LocalNotesStore } from "../local/localStore";
import { isTauri } from "../platform/tauri";
import {
  addFolderSource,
  addServerSource,
  listSources,
  normalizeServerUrl,
  removeSource,
  renameSource,
} from "./registry";
import type { SourceDef, SourceRuntime, SourceState } from "./types";

/** The single implicit source used in the browser - see the module doc. */
const ORIGIN_SOURCE: SourceDef = { id: "origin", kind: "server", label: "Server", url: "" };

function buildRuntime(def: SourceDef): SourceRuntime {
  if (def.kind === "folder") {
    return { def, state: "connected", kind: "folder", store: new LocalNotesStore(def.path ?? "") };
  }
  return { def, state: "connecting", kind: "server", client: createApiClient(def.url ?? "") };
}

/** The registry-backed source list in Tauri, or the single implicit origin
 *  source in the browser - see the module doc's no-regression guarantee.
 *  Lazily computed once, inside `useState`'s initializer, so `listSources()`
 *  (and therefore `localStorage`) is never touched at all outside of Tauri. */
function buildInitialRuntimes(): SourceRuntime[] {
  if (!isTauri()) return [buildRuntime(ORIGIN_SOURCE)];
  return listSources().map(buildRuntime);
}

export interface SourcesContextValue {
  sources: SourceRuntime[];
  addServer(label: string, url: string, username: string, password: string): Promise<void>;
  addFolder(label: string, path: string): Promise<void>;
  remove(id: string): void;
  rename(id: string, label: string): void;
  login(id: string, username: string, password: string): Promise<void>;
  logout(id: string): Promise<void>;
  retry(id: string): void;
}

export const SourcesContext = createContext<SourcesContextValue | null>(null);

export function SourcesProvider({ children }: { children: ReactNode }) {
  const [sources, setSourcesState] = useState<SourceRuntime[]>(buildInitialRuntimes);
  // Mirrors `sources` synchronously so action callbacks (remove/rename/login/
  // logout/retry) can look up "the current runtime for this id" without
  // depending on - and therefore re-creating on every change of - `sources`
  // itself. Only ever written through `setSources` below, right alongside
  // the state update, so it is never stale when an action reads it.
  const sourcesRef = useRef<SourceRuntime[]>(sources);

  const setSources = useCallback((updater: (prev: SourceRuntime[]) => SourceRuntime[]) => {
    setSourcesState((prev) => {
      const next = updater(prev);
      sourcesRef.current = next;
      return next;
    });
  }, []);

  const setSourceState = useCallback(
    (id: string, state: SourceState) => {
      setSources((prev) => prev.map((rt) => (rt.def.id === id ? { ...rt, state } : rt)));
    },
    [setSources],
  );

  /** Probes a single server source's session via `GET /notes` and maps the
   *  outcome onto `SourceState` per the plan's mapping: success ->
   *  `"connected"`, `UnauthorizedError`/401 -> `"needs-login"`, anything else
   *  (network/DNS/TLS failure) -> `"unreachable"`. */
  const probeServer = useCallback(
    async (id: string, client: ApiClient) => {
      setSourceState(id, "connecting");
      try {
        await client.listNotes();
        setSourceState(id, "connected");
      } catch (err) {
        setSourceState(id, err instanceof UnauthorizedError ? "needs-login" : "unreachable");
      }
    },
    [setSourceState],
  );

  // Mount: probe every server source's session and grant filesystem access
  // to every folder source's runtime scope (the Tauri fs plugin's runtime
  // scope does not survive an app restart, so every folder source must
  // re-grant it on every fresh launch). Each server client also gets its own
  // unauthorized handler here, torn down on unmount so a stale handler never
  // outlives this provider.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately runs once against the initial runtimes only
  useEffect(() => {
    for (const rt of sourcesRef.current) {
      if (rt.kind === "server") {
        rt.client.setUnauthorizedHandler(() => setSourceState(rt.def.id, "needs-login"));
        void probeServer(rt.def.id, rt.client);
      } else {
        void rt.store.grantFolderAccess();
      }
    }
    return () => {
      for (const rt of sourcesRef.current) {
        if (rt.kind === "server") rt.client.setUnauthorizedHandler(null);
      }
    };
  }, []);

  const addServer = useCallback(
    async (label: string, url: string, username: string, password: string): Promise<void> => {
      if (!isTauri()) return;
      const normalizedUrl = normalizeServerUrl(url);
      const client = createApiClient(normalizedUrl);
      // Only on a successful login do we persist anything - a bad password
      // must leave the registry (and the runtime list) untouched.
      await client.login(username, password);
      const def = addServerSource(label, url);
      client.setUnauthorizedHandler(() => setSourceState(def.id, "needs-login"));
      setSources((prev) => [...prev, { def, state: "connected", kind: "server", client }]);
    },
    [setSources, setSourceState],
  );

  const addFolder = useCallback(
    async (label: string, path: string): Promise<void> => {
      if (!isTauri()) return;
      const def = addFolderSource(label, path);
      const store = new LocalNotesStore(def.path ?? path);
      await store.grantFolderAccess();
      setSources((prev) => [...prev, { def, state: "connected", kind: "folder", store }]);
    },
    [setSources],
  );

  const remove = useCallback(
    (id: string): void => {
      if (!isTauri()) return;
      const rt = sourcesRef.current.find((candidate) => candidate.def.id === id);
      if (rt?.kind === "server") rt.client.setUnauthorizedHandler(null);
      removeSource(id);
      setSources((prev) => prev.filter((candidate) => candidate.def.id !== id));
    },
    [setSources],
  );

  const rename = useCallback(
    (id: string, label: string): void => {
      if (!isTauri()) return;
      renameSource(id, label);
      setSources((prev) =>
        prev.map((rt) => (rt.def.id === id ? { ...rt, def: { ...rt.def, label } } : rt)),
      );
    },
    [setSources],
  );

  const login = useCallback(
    async (id: string, username: string, password: string): Promise<void> => {
      const rt = sourcesRef.current.find((candidate) => candidate.def.id === id);
      if (!rt || rt.kind !== "server") return;
      await rt.client.login(username, password);
      setSourceState(id, "connected");
    },
    [setSourceState],
  );

  const logout = useCallback(
    async (id: string): Promise<void> => {
      const rt = sourcesRef.current.find((candidate) => candidate.def.id === id);
      if (!rt || rt.kind !== "server") return;
      try {
        await rt.client.logout();
      } finally {
        setSourceState(id, "needs-login");
      }
    },
    [setSourceState],
  );

  const retry = useCallback(
    (id: string): void => {
      const rt = sourcesRef.current.find((candidate) => candidate.def.id === id);
      if (!rt || rt.kind !== "server") return;
      void probeServer(id, rt.client);
    },
    [probeServer],
  );

  const value = useMemo<SourcesContextValue>(
    () => ({ sources, addServer, addFolder, remove, rename, login, logout, retry }),
    [sources, addServer, addFolder, remove, rename, login, logout, retry],
  );

  return <SourcesContext.Provider value={value}>{children}</SourcesContext.Provider>;
}
