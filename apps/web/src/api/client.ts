/** Typed fetch wrapper for the `/api/v1` REST surface exposed by @ndbrain/server. */

import { getApiBaseUrl } from "./base-url";

const API_BASE = "/api/v1";

/** Thrown for any 401 response — either bad login credentials or an expired/missing
 *  session on an otherwise-authed call. Callers that need to tell the two apart can
 *  still inspect `code` (e.g. "bad_credentials" vs "unauthorized"). */
export class UnauthorizedError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Thrown for any other non-2xx response. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface NoteSummary {
  path: string;
  title: string | null;
}

export interface NoteContent {
  path: string;
  content: string;
}

export interface SearchHit {
  path: string;
  title: string | null;
  snippet: string;
  rank: number;
}

export interface HistoryEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface ApiKeyListEntry {
  name: string;
  namespace: string;
  canWrite: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface AuditEntry {
  ts: string;
  keyName: string | null;
  tool: string;
  target: string | null;
  allowed: boolean;
}

export interface GraphNode {
  id: string;
  title: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface LoginResult {
  /** Echoed back from the submitted credentials — the login response body itself
   *  carries no username (see `AuthService.login`). */
  username: string;
  /** Opaque collab token, handed to the Hocuspocus provider as its auth token
   *  (Task 6). Also cached on the client via `getCollabToken()`. */
  token: string;
}

interface ErrorBody {
  error: { code: string; message: string };
}

async function readErrorBody(res: Response): Promise<ErrorBody | null> {
  try {
    return (await res.json()) as ErrorBody;
  } catch {
    return null;
  }
}

/** Encodes each path segment individually so nested vault paths (`myai/deploy.md`)
 *  survive as multi-segment wildcard routes instead of one escaped blob. */
function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

interface RequestOpts {
  method?: string;
  body?: unknown;
  /** Set false for endpoints that reply 204/empty on success (nothing to parse). */
  parseJson?: boolean;
  /** Set true for the login call: a 401 there means "bad credentials", not "your
   *  session died" — it must not trigger the global unauthorized handler. */
  skipUnauthorizedHandler?: boolean;
}

/** Structural interface `useAuth` depends on, so tests can inject a fake without
 *  constructing a real `ApiClient`. */
export interface AuthClient {
  login(username: string, password: string): Promise<LoginResult>;
  logout(): Promise<void>;
  listNotes(): Promise<NoteSummary[]>;
  setUnauthorizedHandler(handler: (() => void) | null): void;
}

export class ApiClient implements AuthClient {
  private collabToken: string | null = null;
  private onUnauthorized: (() => void) | null = null;

  /** `baseUrl` is either a fixed origin (a specific source's server URL) or a
   *  resolver called fresh on every request (the app-wide singleton below uses
   *  `getApiBaseUrl` so it always reflects the current Tauri/browser state).
   *  Defaults to `getApiBaseUrl` itself so existing call sites that construct
   *  `new ApiClient()` with no argument keep resolving the base URL exactly as
   *  before this class took an injectable one — relative same-origin in the
   *  browser, the configured server origin in Tauri. */
  constructor(private readonly baseUrl: string | (() => string) = getApiBaseUrl) {}

  private resolveBaseUrl(): string {
    return typeof this.baseUrl === "function" ? this.baseUrl() : this.baseUrl;
  }

  /** Registers a callback fired whenever a non-login request comes back 401 (session
   *  expired or never existed) — `useAuth` uses this to flip back to "logged out". */
  setUnauthorizedHandler(handler: (() => void) | null): void {
    this.onUnauthorized = handler;
  }

  /** The collab token from the last successful login, kept in memory only (never
   *  persisted) for the Hocuspocus provider (Task 6). Null until login() succeeds. */
  getCollabToken(): string | null {
    return this.collabToken;
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const { token } = await this.request<{ token: string }>("/auth/login", {
      method: "POST",
      body: { username, password },
      skipUnauthorizedHandler: true,
    });
    this.collabToken = token;
    return { username, token };
  }

  async logout(): Promise<void> {
    try {
      await this.request<void>("/auth/logout", { method: "POST", parseJson: false });
    } finally {
      this.collabToken = null;
    }
  }

  listNotes(): Promise<NoteSummary[]> {
    return this.request<{ notes: NoteSummary[] }>("/notes").then((r) => r.notes);
  }

  getNote(path: string): Promise<NoteContent> {
    return this.request<NoteContent>(`/notes/${encodePath(path)}`);
  }

  putNote(path: string, content: string): Promise<void> {
    return this.request<void>(`/notes/${encodePath(path)}`, {
      method: "PUT",
      body: { content },
      parseJson: false,
    });
  }

  deleteNote(path: string): Promise<void> {
    return this.request<void>(`/notes/${encodePath(path)}`, { method: "DELETE", parseJson: false });
  }

  moveNote(from: string, to: string): Promise<void> {
    return this.request<void>("/notes-move", { method: "POST", body: { from, to }, parseJson: false });
  }

  search(q: string): Promise<SearchHit[]> {
    return this.request<{ hits: SearchHit[] }>(`/search?q=${encodeURIComponent(q)}`).then((r) => r.hits);
  }

  backlinks(path: string): Promise<string[]> {
    return this.request<{ backlinks: string[] }>(`/backlinks/${encodePath(path)}`).then((r) => r.backlinks);
  }

  history(path: string): Promise<HistoryEntry[]> {
    return this.request<{ history: HistoryEntry[] }>(`/history/${encodePath(path)}`).then((r) => r.history);
  }

  reindex(): Promise<number> {
    return this.request<{ count: number }>("/reindex", { method: "POST" }).then((r) => r.count);
  }

  listKeys(): Promise<ApiKeyListEntry[]> {
    return this.request<{ keys: ApiKeyListEntry[] }>("/keys").then((r) => r.keys);
  }

  createKey(name: string, namespace: string, canWrite: boolean, expiresAt?: string): Promise<string> {
    return this.request<{ key: string }>("/keys", {
      method: "POST",
      body: { name, namespace, canWrite, expiresAt },
    }).then((r) => r.key);
  }

  revokeKey(name: string): Promise<void> {
    return this.request<void>(`/keys/${encodeURIComponent(name)}`, { method: "DELETE", parseJson: false });
  }

  audit(limit?: number): Promise<AuditEntry[]> {
    const qs = limit ? `?limit=${limit}` : "";
    return this.request<{ entries: AuditEntry[] }>(`/audit${qs}`).then((r) => r.entries);
  }

  graph(): Promise<Graph> {
    return this.request<Graph>("/graph");
  }

  private async request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
    const { method = "GET", body, parseJson = true, skipUnauthorizedHandler = false } = opts;
    const res = await fetch(`${this.resolveBaseUrl()}${API_BASE}${path}`, {
      method,
      credentials: "include",
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401) {
      const errBody = await readErrorBody(res);
      if (!skipUnauthorizedHandler) this.onUnauthorized?.();
      throw new UnauthorizedError(errBody?.error.code ?? "unauthorized", errBody?.error.message ?? "unauthorized");
    }

    if (!res.ok) {
      const errBody = await readErrorBody(res);
      throw new ApiError(res.status, errBody?.error.code ?? "unknown", errBody?.error.message ?? res.statusText);
    }

    if (!parseJson || res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

/** Convenience factory for a client bound to one source's fixed server URL
 *  (e.g. a registry entry's `url`), as opposed to the resolver form below. */
export function createApiClient(baseUrl: string): ApiClient {
  return new ApiClient(baseUrl);
}

/** Shared singleton — the app uses one client for its whole lifetime; tests construct
 *  their own `new ApiClient()` (or a fake `AuthClient`) instead of touching this.
 *
 *  Passed as a resolver (not a plain string) so it re-reads `getApiBaseUrl()` on
 *  every request rather than freezing whatever it returned at import time — this
 *  keeps every existing consumer's behavior identical to before this class took
 *  an injectable base URL (browser: always `""`; Tauri: the configured server
 *  URL, which can change after the client is constructed). Removed in Task 10
 *  once callers migrate to per-source clients. */
export const apiClient = new ApiClient(getApiBaseUrl);
