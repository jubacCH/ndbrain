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

import { z, type ZodType } from 'zod';

import * as S from '../../shared/schema';

/**
 * Types come from the shared schemas rather than being declared twice.
 *
 * Re-exported so the rest of the app keeps importing them from here — the api
 * module stays the single door to the server, and no component needs to know
 * that the shapes are defined a directory up.
 */
export type PutResult = z.infer<typeof S.PutNoteResponse>;
export type BulkResult = z.infer<typeof S.BulkResponse>;

export type {
  ActivityRow,
  FileRow,
  GraphData,
  LinkRow,
  Note,
  NoteRow,
  OpenNote,
  Overview,
  PulseEvent,
  SearchHit,
  Share,
  TaskRow,
  Tidy,
  TopicProposal,
  UploadResult,
  User,
  Version,
} from '../../shared/schema';

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




/** A folder in the tree, with the vault it belongs to. */
export interface DirRow {
  owner: string;
  path: string;
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

/**
 * Raised when the server answered with a shape this build does not understand.
 *
 * Separate from `ApiError` on purpose: an ApiError is the server saying no for a
 * reason a person can act on, while this one means the two halves of the system
 * disagree about the contract. Almost always a stale browser tab against a newer
 * server, which is why the message says so — a reload genuinely fixes it.
 */
export class ContractError extends Error {
  constructor(
    readonly endpoint: string,
    readonly detail: string,
  ) {
    super(`The server's answer for ${endpoint} was not the shape this page expects. Reload to pick up the current version.`);
    this.name = 'ContractError';
  }
}

/**
 * One request, with the answer checked rather than assumed.
 *
 * The old version ended in `return parsed as T` — a cast, which TypeScript
 * erases at build time, so nothing at all verified that the server sent what the
 * types promised. A renamed field survived compilation and surfaced later as
 * `undefined is not an object` somewhere in a render, blaming a component that
 * had nothing to do with it. Now the failure lands here, names the endpoint, and
 * says what was wrong with which field.
 */
async function request<T>(path: string, schema: ZodType<T>, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });

  const text = response.status === 204 ? '' : await response.text();

  let parsed: unknown = {};
  let json = true;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      json = false;
    }
  }

  // Status first, shape second. Getting this the other way round meant a 502
  // from the reverse proxy — which answers in HTML and knows nothing about this
  // API — was reported as a broken contract, so the interface told somebody to
  // reload for a newer version when in fact the server was simply not there.
  if (!response.ok) {
    const problem = json ? (parsed as { code?: string; message?: string }) : {};
    throw new ApiError(
      response.status,
      problem.code ?? 'unknown',
      problem.message ?? `the server answered ${response.status}`,
    );
  }

  if (!json) throw new ContractError(path, 'the response was not JSON');

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first === undefined ? 'unknown field' : first.path.join('.') || '(root)';
    const why = first?.message ?? 'did not match';
    console.error(`ndBrain: ${path} failed validation`, result.error.issues, parsed);
    throw new ContractError(path, `${where}: ${why}`);
  }
  return result.data;
}

/** For the handful of endpoints that answer 204 and nothing else. */
const Empty = z.object({}).transform(() => undefined);

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
  me: () => request('/api/v1/auth/me', S.MeResponse),

  login: (user: string, password: string) =>
    request('/api/v1/auth/login', S.MeResponse, {
      method: 'POST',
      body: JSON.stringify({ user, password }),
    }),

  logout: () => request('/api/v1/auth/logout', S.LogoutResponse, { method: 'POST' }),

  tree: () => request('/api/v1/tree', S.TreeResponse),

  getNote: (owner: string, path: string) =>
    request(`/api/v1/notes/${encodePath(path)}?owner=${encodeURIComponent(owner)}`, S.OpenNote),

  /**
   * Writes a note.
   *
   * `baseMtimeMs` is the version the editor started from. The server needs it to
   * tell "you are the only writer" from "somebody else changed this since you
   * opened it" — without it a shared note silently loses the other person's
   * paragraph, since the rule is last-writer-wins either way.
   */
  putNote: (owner: string, path: string, content: string, baseMtimeMs?: number) =>
    request(`/api/v1/notes/${encodePath(path)}`, S.PutNoteResponse, {
      method: 'PUT',
      body: JSON.stringify({ content, owner, baseMtimeMs }),
    }),

  deleteNote: (owner: string, path: string) =>
    request(`/api/v1/notes/${encodePath(path)}?owner=${encodeURIComponent(owner)}`, Empty, {
      method: 'DELETE',
    }),

  rename: (owner: string, from: string, to: string) =>
    request('/api/v1/rename', S.RenameNoteResponse, {
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
    return request(`/api/v1/search?${params.toString()}`, S.SearchResponse);
  },

  // ---- folders ------------------------------------------------------------
  createFolder: (path: string) =>
    request('/api/v1/folders', S.CreateFolderResponse, {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  /** Moves the notes one by one, so the links that pointed into the folder follow. */
  renameFolder: (from: string, to: string) =>
    request('/api/v1/folders/rename', S.RenameFolderResponse, {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    }),

  deleteFolder: (path: string) =>
    request(`/api/v1/folders/${encodePath(path)}`, Empty, { method: 'DELETE' }),

  /** The vocabulary the vault declares about itself, for the search filters. */
  propKeys: () =>
    request('/api/v1/map?limit=1', S.MapResponse),

  propValues: (key: string) =>
    request(`/api/v1/props/${encodePath(key)}`, S.PropValuesResponse),

  quickFind: (q: string) =>
    request(`/api/v1/quickfind?q=${encodeURIComponent(q)}`, S.QuickFindResponse),

  tags: () => request('/api/v1/tags', S.TagsResponse),

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
    request('/api/v1/bulk', S.BulkResponse, {
      method: 'POST',
      body: JSON.stringify({ action, paths, owner, ...extra }),
    }),

  links: (owner: string, path: string) =>
    request(
      `/api/v1/backlinks/${encodePath(path)}?owner=${encodeURIComponent(owner)}`,
      S.LinksResponse,
    ),

  overview: () => request('/api/v1/overview', S.OverviewResponse),

  graph: () => request('/api/v1/graph', S.GraphResponse),

  /**
   * What has happened since a moment. `now` comes back with it, so the next call
   * asks for exactly what has not been seen — without trusting the local clock,
   * which on a laptop that just woke up is routinely wrong.
   */
  pulse: (since?: number) =>
    request(`/api/v1/pulse${since === undefined ? '' : `?since=${since}`}`, S.PulseResponse),

  tidy: () => request('/api/v1/tidy', S.TidyResponse),

  // ---- files --------------------------------------------------------------
  //
  // The vault as it is on disk, notes and attachments together. Downloads and
  // the export deliberately do *not* go through `request()`: they are navigations
  // that hand a file to the browser, not JSON to parse, and routing them through
  // fetch would mean holding a whole vault in memory to hand it straight back.

  files: (owner?: string) =>
    request(
      `/api/v1/files${owner === undefined ? '' : `?owner=${encodeURIComponent(owner)}`}`,
      S.FilesResponse,
    ),

  /** The URL to download one file. Given to an anchor, never fetched. */
  fileUrl: (owner: string, path: string) =>
    `/api/v1/files/${encodePath(path)}?owner=${encodeURIComponent(owner)}`,

  /** The URL for the whole vault as a zip. Own vault only, by design. */
  exportUrl: () => '/api/v1/export',

  /**
   * Uploads one file, replacing whatever was there.
   *
   * One request per file rather than one multipart request for all of them: a
   * failure then names the file it belongs to, instead of collapsing a batch into
   * a single unhelpful error.
   */
  uploadFile: (owner: string, path: string, file: Blob) =>
    request(`/api/v1/files/${encodePath(path)}?owner=${encodeURIComponent(owner)}`, S.UploadResult, {
      method: 'POST',
      body: file,
      // Never empty: a `File` the browser cannot type reports `''`, and a request
      // with no content type is parsed as JSON, which the upload route refuses
      // because a parsed object can no longer produce the bytes that made it.
      headers: { 'content-type': file.type === '' ? 'application/octet-stream' : file.type },
    }),

  deleteFile: (owner: string, path: string) =>
    request(`/api/v1/files/${encodePath(path)}?owner=${encodeURIComponent(owner)}`, Empty, {
      method: 'DELETE',
    }),

  // ---- topics ---------------------------------------------------------------

  topics: () => request('/api/v1/topics', S.TopicsResponse),

  /** Names the notes, never the tags — the server re-derives those. */
  applyTopics: (paths: string[]) =>
    request('/api/v1/topics/apply', S.ApplyTopicsResponse, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),

  // ---- history --------------------------------------------------------------

  history: (owner: string, path: string) =>
    request(
      `/api/v1/history/${encodePath(path)}?owner=${encodeURIComponent(owner)}`,
      S.HistoryResponse,
    ),

  versionContent: (owner: string, path: string, version: string) =>
    request(
      `/api/v1/history/${encodePath(path)}?owner=${encodeURIComponent(owner)}` +
        `&version=${encodeURIComponent(version)}`,
      S.VersionContentResponse,
    ).then((result) => result.content),

  /** Writes an old version back as a new edit; never rewrites history. */
  restoreVersion: (owner: string, path: string, version: string) =>
    request('/api/v1/history/restore', S.RestoreResponse, {
      method: 'POST',
      body: JSON.stringify({ owner, path, version }),
    }),

  // ---- settings and account -------------------------------------------------

  settings: () => request('/api/v1/settings', S.SettingsResponse),

  saveSettings: (patch: { staleDays?: number }) =>
    request('/api/v1/settings', S.SettingsResponse, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  /** The current password is required even though a session is already held. */
  changePassword: (currentPassword: string, newPassword: string) =>
    request('/api/v1/account/password', S.OkResponse, {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  revokeSessions: () =>
    request('/api/v1/account/sessions/revoke', S.OkResponse, { method: 'POST' }),

  // ---- sharing ------------------------------------------------------------
  shares: () => request('/api/v1/shares', S.SharesResponse),

  /** Only ever opens a region of the caller's *own* vault — a held share is not theirs to pass on. */
  grantShare: (grantee: string, prefix: string, canWrite: boolean) =>
    request('/api/v1/shares', S.GrantShareResponse, {
      method: 'POST',
      body: JSON.stringify({ grantee, prefix, canWrite }),
    }),

  /** Withdraw as the owner, or decline as the grantee — the same call either way. */
  revokeShare: (id: string) =>
    request(`/api/v1/shares/${encodeURIComponent(id)}`, Empty, { method: 'DELETE' }),
};
