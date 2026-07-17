/** Persisted registry of ndBrain sources (servers and local folders).
 *
 *  Backed by `localStorage`, same pattern as `platform/tauri.ts`'s
 *  `getStoredServerUrl`/`setStoredServerUrl` - no-op-safe when `localStorage`
 *  is unavailable (`listSources()` returns `[]`, writers silently do
 *  nothing).
 *
 *  Ids are assigned from a monotonically increasing counter persisted
 *  alongside the sources (`"s1"`, `"s2"`, ...) rather than `Math.random()` or
 *  `Date.now()`, so id assignment is deterministic and testable. */

import type { SourceDef, SourceKind } from "./types";

const STORAGE_KEY = "ndbrain.sources";

/** The on-disk shape: the source list plus the next id to hand out. */
interface StoredState {
  nextId: number;
  sources: SourceDef[];
}

function emptyState(): StoredState {
  return { nextId: 1, sources: [] };
}

function isValidSourceDef(value: unknown): value is SourceDef {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.label !== "string") return false;
  const kind = record.kind as SourceKind | undefined;
  if (kind === "server") return typeof record.url === "string";
  if (kind === "folder") return typeof record.path === "string";
  return false;
}

/** Reads and validates the persisted state. Corrupt JSON, an unexpected
 *  shape, or entries with an unknown `kind`/missing required fields are
 *  dropped rather than thrown - a single bad entry must not take down the
 *  whole registry. */
function readState(): StoredState {
  if (typeof localStorage === "undefined") return emptyState();
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return emptyState();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyState();
  }
  if (typeof parsed !== "object" || parsed === null) return emptyState();

  const record = parsed as Record<string, unknown>;
  const nextId = typeof record.nextId === "number" ? record.nextId : 1;
  const rawSources = Array.isArray(record.sources) ? record.sources : [];
  return { nextId, sources: rawSources.filter(isValidSourceDef) };
}

function writeState(state: StoredState): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function assertLabel(label: string): void {
  if (label.trim().length === 0) {
    throw new Error("Source label must not be empty");
  }
}

function assertPath(path: string): void {
  if (path.trim().length === 0) {
    throw new Error("Folder path must not be empty");
  }
}

/** Validates and normalizes a server URL: must be a parseable `http:`/
 *  `https:` URL; the trailing slash is stripped so `"https://x.dev/"` and
 *  `"https://x.dev"` end up identical. Throws on anything else (unparseable
 *  strings, other protocols like `ftp:`).
 *
 *  Exported so `SourcesProvider` can apply the exact same validation before
 *  attempting a login — it must be able to construct the `ApiClient` and
 *  validate the URL *before* deciding whether to persist anything via
 *  `addServerSource`, which applies this same normalization internally. */
export function normalizeServerUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid server URL: "${rawUrl}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Server URL must use http or https: "${rawUrl}"`);
  }
  return parsed.toString().replace(/\/$/, "");
}

/** Lists all configured sources in stable (insertion) order. Empty (and
 *  never throws) when nothing has been configured or `localStorage` is
 *  unavailable. */
export function listSources(): SourceDef[] {
  return readState().sources;
}

/** Adds a `server` source and persists it. Throws (without persisting
 *  anything) if `label` is empty/whitespace or `url` is not a valid
 *  `http:`/`https:` URL. */
export function addServerSource(label: string, url: string): SourceDef {
  assertLabel(label);
  const normalizedUrl = normalizeServerUrl(url);

  const state = readState();
  const source: SourceDef = { id: `s${state.nextId}`, kind: "server", label, url: normalizedUrl };
  state.sources.push(source);
  state.nextId += 1;
  writeState(state);
  return source;
}

/** Adds a `folder` source and persists it. Throws (without persisting
 *  anything) if `label` or `path` is empty/whitespace. */
export function addFolderSource(label: string, path: string): SourceDef {
  assertLabel(label);
  assertPath(path);

  const state = readState();
  const source: SourceDef = { id: `s${state.nextId}`, kind: "folder", label, path };
  state.sources.push(source);
  state.nextId += 1;
  writeState(state);
  return source;
}

/** Removes the source with the given id, if any. No-op if it doesn't exist. */
export function removeSource(id: string): void {
  const state = readState();
  state.sources = state.sources.filter((source) => source.id !== id);
  writeState(state);
}

/** Renames the source with the given id, if any. Throws if `label` is
 *  empty/whitespace; no-op (nothing thrown) if `id` doesn't exist. */
export function renameSource(id: string, label: string): void {
  assertLabel(label);

  const state = readState();
  const source = state.sources.find((candidate) => candidate.id === id);
  if (!source) return;
  source.label = label;
  writeState(state);
}
