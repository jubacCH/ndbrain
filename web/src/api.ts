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
  ActivityDay,
  ActivityRow,
  ConflictRow,
  FileRow,
  GraphData,
  LinkRow,
  Note,
  NoteRow,
  OpenNote,
  Overview,
  PulseEvent,
  SearchHit,
  TaskRow,
  Tasks,
  Tidy,
  AdminUser,
  ApiKey,
  TopicProposal,
  UploadResult,
  User,
  Version,
  DeletedNote,
  RestoreState,
} from '../../shared/schema';

/** What it takes to name one note: which vault, and where in it. */
export interface Ref {
  owner: string;
  path: string;
}

/**
 * A stable identity for a note. Defined without dependencies in `./refkey`, so
 * the brain's graph model can use it without pulling in this module's schemas;
 * re-exported here because this is still the door the rest of the app uses.
 */
export { refKey } from './refkey';




/** A folder in the tree, with the vault it belongs to. */
export interface DirRow {
  owner: string;
  path: string;
}

/* ---- sharing and spaces (phase 8) -------------------------------------------
 *
 * Declared here rather than in `shared/schema.ts`, which the server strand owns
 * while both halves are built side by side against the written contract. Every
 * schema below is that contract as this page reads it; where the contract left
 * a shape open, the parser accepts each reading it allows and says so.
 */

/** What a share opens: a whole vault, a folder with everything under it, or one note. */
export const ShareKind = z.enum(['vault', 'folder', 'note']);
export type ShareKind = z.infer<typeof ShareKind>;

/**
 * One share.
 *
 * `prefix` is `''` for a vault, a folder path ending in `/` for a folder, and
 * the exact note path (no trailing slash) for a note. `kind` is required: a
 * note share read as a folder would widen what this page believes is covered.
 */
export const ShareSchema = S.Share.extend({ kind: ShareKind });
export type Share = z.infer<typeof ShareSchema>;

export const SharesResponse = z.object({
  granted: z.array(ShareSchema),
  received: z.array(ShareSchema),
});

/** A vault is a person's or a space's. A space cannot sign in. */
export const OwnerKind = z.enum(['person', 'space']);
export type OwnerKind = z.infer<typeof OwnerKind>;

/** One vault the caller can see into, with what it is and what to call it. */
export const OwnerInfo = z.object({
  id: z.string(),
  kind: OwnerKind,
  displayName: z.string(),
});
export type OwnerInfo = z.infer<typeof OwnerInfo>;

/**
 * The tree, with the vaults it spans.
 *
 * `owners` is optional so a server without it still draws every vault, only
 * without a space's name and icon.
 */
export const TreeResponse = S.TreeResponse.extend({
  owners: z.array(OwnerInfo).optional(),
});
export type TreeData = z.infer<typeof TreeResponse>;

export const AdminSpace = z.object({
  id: z.string(),
  displayName: z.string(),
  disabled: z.boolean(),
  noteCount: z.number(),
  members: z.number(),
});
export type AdminSpace = z.infer<typeof AdminSpace>;

/** The contract writes a bare list; the rest of the API wraps lists. Both are read. */
const AdminSpacesResponse = z.union([
  z.array(AdminSpace),
  z.object({ spaces: z.array(AdminSpace) }).transform((reply) => reply.spaces),
]);

/**
 * One member of a space: a share whose owner is the space.
 *
 * The contract names the region `path` here and `prefix` on `/shares`; either
 * is read, and the row comes out in the same shape as every other share so one
 * rule (`rights.ts`) and one table serve both.
 */
const SpaceMemberRow = z
  .object({
    id: z.string(),
    grantee: z.string(),
    kind: ShareKind,
    canWrite: z.boolean(),
    path: z.string().optional(),
    prefix: z.string().optional(),
    createdAt: z.number().optional(),
  })
  .refine((row) => row.path !== undefined || row.prefix !== undefined, 'path is missing');

function memberRows(space: string) {
  const rows = z.array(SpaceMemberRow);
  return z
    .union([rows, z.object({ members: rows }).transform((reply) => reply.members)])
    .transform((list): Share[] =>
      list.map((row) => ({
        id: row.id,
        owner: space,
        prefix: row.path ?? row.prefix ?? '',
        grantee: row.grantee,
        kind: row.kind,
        canWrite: row.canWrite,
        createdAt: row.createdAt ?? 0,
      })),
    );
}

/** For writes whose reply this page does not read: it re-reads the list instead. */
const Ignored = z.unknown().transform(() => undefined);













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

const unauthenticatedListeners = new Set<() => void>();

/**
 * Called whenever the server answers that nobody is signed in.
 *
 * The listener decides what that means: before sign-in it is the login page
 * asking `/auth/me`, and nothing should happen. Returns the unsubscribe.
 */
export function onUnauthenticated(listener: () => void): () => void {
  unauthenticatedListeners.add(listener);
  return () => {
    unauthenticatedListeners.delete(listener);
  };
}

/** Tells every listener the session is gone. Exported for tests that stand in for `request`. */
export function reportUnauthenticated(): void {
  for (const listener of [...unauthenticatedListeners]) listener();
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
    // The session is gone (expired, revoked, signed out in another tab). Said
    // once, centrally, so the shell can end it instead of every caller
    // showing its own error over a screen full of the old account's data.
    // A wrong password is `invalid_credentials` and does not count.
    if (response.status === 401 && problem.code === 'unauthenticated') {
      reportUnauthenticated();
    }
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

  tree: () => request('/api/v1/tree', TreeResponse),

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

  /**
   * Makes sure a note exists, creating it with `content` only if it does not.
   *
   * Never writes over anything: an existing note comes back untouched with
   * `created: false`. Safe to call twice at once — from a double click, a
   * shortcut and a button, or two tabs — because the server decides under its
   * write lock, not this page from a tree that may be a second old.
   */
  ensureNote: (owner: string, path: string, content: string) =>
    request(`/api/v1/notes/${encodePath(path)}`, S.PutNoteResponse, {
      method: 'PUT',
      body: JSON.stringify({ content, owner, ifAbsent: true }),
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

  /**
   * The caller's own activity per day. `bounds` are local midnights, ascending:
   * n + 1 of them make n days. Never another vault, shared or not.
   */
  activityDays: (bounds: number[]) =>
    request(`/api/v1/activity/days?bounds=${bounds.map((b) => Math.trunc(b)).join(',')}`, S.ActivityDaysResponse),

  tidy: () => request('/api/v1/tidy', S.TidyResponse),

  /** The full task list behind the overview tile's `slice(0, 8)`. */
  tasks: (filters: { dir?: string; includeDone?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (filters.dir !== undefined) params.set('dir', filters.dir);
    if (filters.includeDone === true) params.set('includeDone', 'true');
    const qs = params.toString();
    return request(`/api/v1/tasks${qs === '' ? '' : `?${qs}`}`, S.TasksResponse);
  },

  /**
   * Ticks or unticks one task, verified server-side against the exact text and
   * done state the client last saw at that line — see `App.toggleTask`. A
   * mismatch (the note changed underneath the list) comes back as a 409 rather
   * than silently hitting the wrong line.
   */
  toggleTask: (owner: string, task: { path: string; line: number; text: string; done: boolean }, done: boolean) =>
    request('/api/v1/tasks/toggle', S.PutNoteResponse, {
      method: 'POST',
      body: JSON.stringify({
        owner,
        path: task.path,
        line: task.line,
        expectedText: task.text,
        expectedDone: task.done,
        done,
      }),
    }),

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

  // ---- administration -------------------------------------------------------
  //
  // Every one of these is admin-only at the server. Nothing here relies on the
  // menu entry being hidden — a view that is not rendered is not a permission.

  adminUsers: () => request('/api/v1/admin/users', S.AdminUsersResponse),

  createUser: (id: string, password: string, displayName: string, role: 'admin' | 'user') =>
    request('/api/v1/admin/users', S.MeResponse, {
      method: 'POST',
      body: JSON.stringify({ id, password, displayName, role }),
    }),

  adminSetPassword: (id: string, password: string) =>
    request(`/api/v1/admin/users/${encodeURIComponent(id)}/password`, S.OkResponse, {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  adminSetDisabled: (id: string, disabled: boolean) =>
    request(`/api/v1/admin/users/${encodeURIComponent(id)}/disabled`, S.OkResponse, {
      method: 'POST',
      body: JSON.stringify({ disabled }),
    }),

  adminKeys: (owner: string) =>
    request(`/api/v1/admin/keys?owner=${encodeURIComponent(owner)}`, S.AdminKeysResponse),

  /** The only call that ever returns a key secret. It cannot be asked for again. */
  createKey: (owner: string, name: string, scope: string, canWrite: boolean) =>
    request('/api/v1/admin/keys', S.CreatedKeyResponse, {
      method: 'POST',
      body: JSON.stringify({ owner, name, ...(scope === '' ? {} : { scope }), canWrite }),
    }),

  // ---- spaces -----------------------------------------------------------------
  //
  // A space is a vault nobody signs in to. Admin-only like the rest of this
  // block; its members are ordinary shares whose owner is the space.

  adminSpaces: () => request('/api/v1/admin/spaces', AdminSpacesResponse),

  createSpace: (id: string, displayName: string) =>
    request('/api/v1/admin/spaces', Ignored, {
      method: 'POST',
      body: JSON.stringify({ id, displayName }),
    }),

  updateSpace: (id: string, patch: { displayName?: string; disabled?: boolean }) =>
    request(`/api/v1/admin/spaces/${encodeURIComponent(id)}`, Ignored, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  spaceMembers: (id: string) =>
    request(`/api/v1/admin/spaces/${encodeURIComponent(id)}/members`, memberRows(id)),

  /**
   * The folders and notes of a space, by path and title only, so the member
   * picker can offer them to an administrator who is not a member.
   */
  spaceTree: (id: string) =>
    request(`/api/v1/admin/spaces/${encodeURIComponent(id)}/tree`, S.AdminSpaceTreeResponse),

  addSpaceMember: (id: string, grantee: string, kind: ShareKind, path: string, canWrite: boolean) =>
    request(`/api/v1/admin/spaces/${encodeURIComponent(id)}/members`, Ignored, {
      method: 'POST',
      body: JSON.stringify({ grantee, kind, path, canWrite }),
    }),

  removeSpaceMember: (id: string, shareId: string) =>
    request(
      `/api/v1/admin/spaces/${encodeURIComponent(id)}/members/${encodeURIComponent(shareId)}`,
      Empty,
      { method: 'DELETE' },
    ),

  revokeKey: (id: string) =>
    request(`/api/v1/admin/keys/${encodeURIComponent(id)}`, Empty, { method: 'DELETE' }),

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

  // ---- recently deleted -----------------------------------------------------

  /** Deleted notes of the last 30 days the caller may bring back. */
  deleted: () => request('/api/v1/deleted', S.DeletedResponse),

  /** Brings one back at its old path, or beside it when the path is taken. */
  restoreDeleted: (owner: string, path: string) =>
    request('/api/v1/deleted/restore', S.RestoreDeletedResponse, {
      method: 'POST',
      body: JSON.stringify({ owner, path }),
    }),

  /** Whether notes about to be deleted could be brought back afterwards. */
  deletePreview: (owner: string, paths: string[]) =>
    request('/api/v1/deleted/preview', S.DeletePreviewResponse, {
      method: 'POST',
      body: JSON.stringify({ owner, paths }),
    }),

  // ---- settings and account -------------------------------------------------

  settings: () => request('/api/v1/settings', S.SettingsResponse),

  saveSettings: (patch: { staleDays?: number }) =>
    request('/api/v1/settings', S.SettingsResponse, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  /** Only a label — the account id, which names the vault directory, is untouched. */
  setDisplayName: (displayName: string) =>
    request('/api/v1/account/profile', S.MeResponse, {
      method: 'PUT',
      body: JSON.stringify({ displayName }),
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
  shares: () => request('/api/v1/shares', SharesResponse),

  /**
   * Only ever opens a region of the caller's *own* vault — a held share is not
   * theirs to pass on. `path` is `''` for the vault, a folder, or one note.
   */
  grantShare: (grantee: string, kind: ShareKind, path: string, canWrite: boolean) =>
    request('/api/v1/shares', z.object({ share: ShareSchema }), {
      method: 'POST',
      body: JSON.stringify({ grantee, kind, path, canWrite }),
    }),

  /** Withdraw as the owner, or decline as the grantee — the same call either way. */
  revokeShare: (id: string) =>
    request(`/api/v1/shares/${encodeURIComponent(id)}`, Empty, { method: 'DELETE' }),
};
