/**
 * Typed client for the ndBrain API.
 *
 * Same origin: the server serves this bundle, so there is no base URL to
 * configure and the session cookie travels automatically.
 */

export interface Note {
  path: string;
  title: string;
  content: string;
  size: number;
  mtimeMs: number;
}

export interface NoteRow {
  path: string;
  title: string;
  size: number;
  mtimeMs: number;
}

export interface SearchHit extends NoteRow {
  snippet: string;
  rank: number;
}

export interface LinkRow {
  source: string;
  targetRaw: string;
  targetPath: string | null;
  heading: string | null;
  alias: string | null;
  offset: number;
}

export interface TaskRow {
  path: string;
  line: number;
  done: boolean;
  text: string;
}

export interface Overview {
  counts: { notes: number; orphans: number; untagged: number; deadLinks: number; stale: number };
  recent: NoteRow[];
  tasks: TaskRow[];
  tags: Array<{ tag: string; count: number }>;
}

export interface Tidy {
  orphans: NoteRow[];
  untagged: NoteRow[];
  deadLinks: LinkRow[];
  stale: NoteRow[];
}

export interface User {
  id: string;
  displayName: string;
  role: 'admin' | 'user';
}

/** Carries the server's error code so callers can react to `case_collision` and friends. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : {};

  if (!response.ok) {
    const problem = parsed as { code?: string; message?: string };
    throw new ApiError(response.status, problem.code ?? 'unknown', problem.message ?? 'request failed');
  }

  return parsed as T;
}

/**
 * Encodes a vault path for a URL without destroying its separators.
 *
 * `encodeURIComponent` would turn every `/` into `%2F`, which the router then
 * hands back as one long segment. Each segment is encoded on its own instead.
 */
export function encodePath(vaultPath: string): string {
  return vaultPath.split('/').map(encodeURIComponent).join('/');
}

export const api = {
  me: () => request<{ user: User }>('/api/v1/auth/me'),

  login: (user: string, password: string) =>
    request<{ user: User }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ user, password }),
    }),

  logout: () => request<{ ok: boolean }>('/api/v1/auth/logout', { method: 'POST' }),

  tree: () => request<{ notes: NoteRow[]; dirs: string[] }>('/api/v1/tree'),

  getNote: (path: string) => request<{ note: Note }>(`/api/v1/notes/${encodePath(path)}`),

  putNote: (path: string, content: string) =>
    request<{ note: Note }>(`/api/v1/notes/${encodePath(path)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  deleteNote: (path: string) =>
    request<void>(`/api/v1/notes/${encodePath(path)}`, { method: 'DELETE' }),

  rename: (from: string, to: string) =>
    request<{ note: Note; updatedLinks: string[] }>('/api/v1/rename', {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    }),

  search: (q: string, filters: { tag?: string; dir?: string; days?: number } = {}) => {
    const params = new URLSearchParams();
    if (q !== '') params.set('q', q);
    if (filters.tag !== undefined) params.set('tag', filters.tag);
    if (filters.dir !== undefined) params.set('dir', filters.dir);
    if (filters.days !== undefined) params.set('days', String(filters.days));
    return request<{ hits: SearchHit[] }>(`/api/v1/search?${params.toString()}`);
  },

  quickFind: (q: string) =>
    request<{ notes: NoteRow[] }>(`/api/v1/quickfind?q=${encodeURIComponent(q)}`),

  tags: () => request<{ tags: Array<{ tag: string; count: number }> }>('/api/v1/tags'),

  links: (path: string) =>
    request<{ backlinks: LinkRow[]; outgoing: LinkRow[] }>(`/api/v1/backlinks/${encodePath(path)}`),

  overview: () => request<Overview>('/api/v1/overview'),

  tidy: () => request<Tidy>('/api/v1/tidy'),
};
