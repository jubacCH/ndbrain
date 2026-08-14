/**
 * Typed client for the ndBrain API.
 *
 * Same origin: the server serves this bundle, so there is no base URL to
 * configure and the session cookie travels automatically.
 *
 * Since sharing, a note is no longer identified by its path alone. Two people can
 * each have a `Projekte/Notizen.md`, so every call that addresses one note takes
 * an **owner** as well — the vault the note lives in, which is not necessarily
 * the person signed in. The owner travels in the query string or the body and
 * never in the path, where it would be indistinguishable from a folder of the
 * same name; the server treats it as untrusted and decides what it means.
 */

/** What it takes to name one note: which vault, and where in it. */
export interface Ref {
  owner: string;
  path: string;
}

/**
 * A stable identity for a note, for React keys and selection sets.
 *
 * NUL cannot occur in a vault path, so no owner/path pair can be spelled two
 * ways — which matters, because a collision here would mean the wrong note
 * highlighted, or worse, deleted.
 */
export function refKey(owner: string, path: string): string {
  return `${owner}\u0000${path}`;
}

export interface Note {
  path: string;
  title: string;
  content: string;
  size: number;
  mtimeMs: number;
}

/** A note as it was opened, with what the caller may do to it. */
export interface OpenNote {
  note: Note;
  owner: string;
  canWrite: boolean;
}

export interface NoteRow {
  owner: string;
  path: string;
  title: string;
  size: number;
  mtimeMs: number;
}

/** A folder in the tree, with the vault it belongs to. */
export interface DirRow {
  owner: string;
  path: string;
}

export interface SearchHit extends NoteRow {
  snippet: string;
  rank: number;
}

export interface LinkRow {
  owner: string;
  source: string;
  targetRaw: string;
  targetPath: string | null;
  heading: string | null;
  alias: string | null;
  offset: number;
}

export interface TaskRow {
  owner: string;
  path: string;
  line: number;
  done: boolean;
  text: string;
}

export interface ActivityRow {
  owner: string;
  path: string;
  title: string;
  actor: string;
  action: 'create' | 'update' | 'delete' | 'rename';
  at: number;
  edits: number;
  deleted: boolean;
}

export interface Overview {
  counts: { notes: number; orphans: number; untagged: number; deadLinks: number; stale: number };
  recent: NoteRow[];
  tasks: TaskRow[];
  tags: Array<{ tag: string; count: number }>;
  activity: ActivityRow[];
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

/** One grant: a region of one vault, opened to one other account. */
export interface Share {
  id: string;
  owner: string;
  /** Path prefix, `''` for the whole vault. Ends in `/` when it names a folder. */
  prefix: string;
  grantee: string;
  canWrite: boolean;
  createdAt: number;
}

export interface PutResult {
  note: Note;
  created: boolean;
  /**
   * Set when this write displaced a version the writer had not seen; names the
   * copy that version was kept in. Nothing was lost, but somebody has to be told.
   */
  conflictCopy?: string;
}

export interface BulkResult {
  /** Final paths of the notes that succeeded — a move changes the path. */
  ok: string[];
  failed: Array<{ path: string; reason: string }>;
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

  tree: () => request<{ notes: NoteRow[]; dirs: DirRow[] }>('/api/v1/tree'),

  getNote: (owner: string, path: string) =>
    request<OpenNote>(`/api/v1/notes/${encodePath(path)}?owner=${encodeURIComponent(owner)}`),

  /**
   * Writes a note.
   *
   * `baseMtimeMs` is the version the editor started from. The server needs it to
   * tell "you are the only writer" from "somebody else changed this since you
   * opened it" — without it a shared note silently loses the other person's
   * paragraph, since the rule is last-writer-wins either way.
   */
  putNote: (owner: string, path: string, content: string, baseMtimeMs?: number) =>
    request<PutResult>(`/api/v1/notes/${encodePath(path)}`, {
      method: 'PUT',
      body: JSON.stringify({ content, owner, baseMtimeMs }),
    }),

  deleteNote: (owner: string, path: string) =>
    request<void>(`/api/v1/notes/${encodePath(path)}?owner=${encodeURIComponent(owner)}`, {
      method: 'DELETE',
    }),

  rename: (owner: string, from: string, to: string) =>
    request<{ note: Note; updatedLinks: string[] }>('/api/v1/rename', {
      method: 'POST',
      body: JSON.stringify({ from, to, owner }),
    }),

  search: (
    q: string,
    filters: { tag?: string; dir?: string; days?: number; prop?: string; propValue?: string } = {},
  ) => {
    const params = new URLSearchParams();
    if (q !== '') params.set('q', q);
    if (filters.tag !== undefined) params.set('tag', filters.tag);
    if (filters.dir !== undefined) params.set('dir', filters.dir);
    if (filters.days !== undefined) params.set('days', String(filters.days));
    if (filters.prop !== undefined) params.set('prop', filters.prop);
    if (filters.propValue !== undefined) params.set('propValue', filters.propValue);
    return request<{ hits: SearchHit[] }>(`/api/v1/search?${params.toString()}`);
  },

  // ---- folders ------------------------------------------------------------
  createFolder: (path: string) =>
    request<{ folder: string }>('/api/v1/folders', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  /** Moves the notes one by one, so the links that pointed into the folder follow. */
  renameFolder: (from: string, to: string) =>
    request<{ folder: string; movedNotes: string[]; updatedLinks: string[] }>(
      '/api/v1/folders/rename',
      { method: 'POST', body: JSON.stringify({ from, to }) },
    ),

  deleteFolder: (path: string) =>
    request<void>(`/api/v1/folders/${encodePath(path)}`, { method: 'DELETE' }),

  /** The vocabulary the vault declares about itself, for the search filters. */
  propKeys: () =>
    request<{ notes: unknown[]; props: Array<{ key: string; count: number }> }>('/api/v1/map?limit=1'),

  propValues: (key: string) =>
    request<{ values: Array<{ value: string; count: number }> }>(`/api/v1/props/${encodePath(key)}`),

  quickFind: (q: string) =>
    request<{ notes: NoteRow[] }>(`/api/v1/quickfind?q=${encodeURIComponent(q)}`),

  tags: () => request<{ tags: Array<{ tag: string; count: number }> }>('/api/v1/tags'),

  /**
   * One vault per call, on purpose: the server refuses a selection that spans
   * two, and "move these into Archiv" has no meaning across a vault boundary.
   */
  bulk: (
    owner: string,
    action: 'move' | 'tag' | 'untag' | 'delete',
    paths: string[],
    extra: { tag?: string; dir?: string } = {},
  ) =>
    request<BulkResult>('/api/v1/bulk', {
      method: 'POST',
      body: JSON.stringify({ action, paths, owner, ...extra }),
    }),

  links: (owner: string, path: string) =>
    request<{ backlinks: LinkRow[]; outgoing: LinkRow[] }>(
      `/api/v1/backlinks/${encodePath(path)}?owner=${encodeURIComponent(owner)}`,
    ),

  overview: () => request<Overview>('/api/v1/overview'),

  tidy: () => request<Tidy>('/api/v1/tidy'),

  // ---- sharing ------------------------------------------------------------
  shares: () => request<{ granted: Share[]; received: Share[] }>('/api/v1/shares'),

  /** Only ever opens a region of the caller's *own* vault — a held share is not theirs to pass on. */
  grantShare: (grantee: string, prefix: string, canWrite: boolean) =>
    request<{ share: Share }>('/api/v1/shares', {
      method: 'POST',
      body: JSON.stringify({ grantee, prefix, canWrite }),
    }),

  /** Withdraw as the owner, or decline as the grantee — the same call either way. */
  revokeShare: (id: string) =>
    request<void>(`/api/v1/shares/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
