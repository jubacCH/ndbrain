/**
 * The shape of the API, written once and used by both sides.
 *
 * This file exists because the seam between the server and the browser was the
 * only part of the system nothing checked. The client did `return parsed as T` —
 * a cast, not a check, which TypeScript erases at build time. If the server ever
 * changed a field, everything still compiled and the interface died later, deep
 * inside a render, with an error naming a component that had nothing to do with
 * the cause.
 *
 * The rule now: **the server validates what comes in, the client validates what
 * comes back, and both read the same definition.** A drift between them stops
 * being a mystery at runtime and becomes a type error at build time.
 *
 * Kept dependency-light and framework-free on purpose. It is imported by a
 * Fastify server and by a browser bundle, so it may assume neither.
 *
 * A note on strictness: response schemas are *not* `.strict()`. A server that has
 * learned a new field must not break a browser tab that has not been reloaded
 * yet — new fields are ignored, missing or wrong ones are the error. Request
 * schemas are strict in the other direction: unknown keys in a request body are
 * rejected, since they are far more likely to be a typo in a field name that
 * would otherwise be silently dropped.
 */

import { z } from 'zod';

/* ---- primitives ---------------------------------------------------------- */

/** A vault-relative path. Emptiness is the one rule worth stating here; the
 *  server's `normalizeVaultPath` owns the rest, and duplicating it would create
 *  two sources of truth for what a legal path is. */
export const VaultPath = z.string().min(1).max(1024);

/** An account name, matching the server's `USER_ID_RE`. */
export const UserId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'not a valid account name');

const Timestamp = z.number();

/* ---- notes --------------------------------------------------------------- */

export const NoteRow = z.object({
  owner: z.string(),
  path: z.string(),
  title: z.string(),
  size: z.number(),
  mtimeMs: Timestamp,
});

export const Note = z.object({
  path: z.string(),
  title: z.string(),
  content: z.string(),
  size: z.number(),
  mtimeMs: Timestamp,
});

export const OpenNote = z.object({
  note: Note,
  owner: z.string(),
  canWrite: z.boolean(),
});

export const SearchHit = NoteRow.extend({
  snippet: z.string(),
});

export const LinkRow = z.object({
  owner: z.string(),
  source: z.string(),
  targetRaw: z.string(),
  targetPath: z.string().nullable(),
  heading: z.string().nullable(),
  alias: z.string().nullable(),
  offset: z.number(),
});

export const ConflictRow = NoteRow.extend({
  /** Path of the note the copy displaced, read back from the copy's own name. */
  originalPath: z.string(),
  /** Title of the original, when it can still be read. Null when gone or hidden. */
  originalTitle: z.string().nullable(),
  /** Whether that note still exists, in the caller's view. */
  originalExists: z.boolean(),
  /** The moment named in the copy's filename. */
  at: Timestamp,
});

export const TaskRow = z.object({
  owner: z.string(),
  path: z.string(),
  line: z.number(),
  done: z.boolean(),
  text: z.string(),
});

export const ActivityRow = z.object({
  owner: z.string(),
  path: z.string(),
  title: z.string(),
  actor: z.string(),
  action: z.enum(['create', 'update', 'delete', 'rename']),
  at: Timestamp,
  edits: z.number(),
  deleted: z.boolean(),
});

/* ---- responses ----------------------------------------------------------- */

/**
 * An owner in the caller's view, own account first: only owners the caller
 * holds at least one scope in, spaces without notes included.
 */
export const VisibleOwner = z.object({
  id: z.string(),
  kind: z.enum(['person', 'space']),
  displayName: z.string(),
});

export const TreeResponse = z.object({
  notes: z.array(NoteRow),
  dirs: z.array(z.object({ owner: z.string(), path: z.string() })),
  /** The owners of the roots above, with their kind and display name. */
  owners: z.array(VisibleOwner),
});

export const OverviewResponse = z.object({
  counts: z.object({
    notes: z.number(),
    orphans: z.number(),
    untagged: z.number(),
    deadLinks: z.number(),
    stale: z.number(),
    conflicts: z.number(),
    /** Distinct notes affected — not the sum of the five above, which overlap. */
    attention: z.number(),
    /** False where no note carries a tag, which makes "untagged" meaningless. */
    tagsInUse: z.boolean(),
  }),
  recent: z.array(NoteRow),
  tasks: z.array(TaskRow),
  tags: z.array(z.object({ tag: z.string(), count: z.number() })),
  activity: z.array(ActivityRow),
});

/**
 * A name several notes link to that no note answers.
 *
 * Not a finding about a note — there is no note. It is what the server's
 * `missingNotes` makes of the dead links: the names the vault keeps asking for,
 * each with the notes that ask, so the claim can be checked at its source.
 */
export const MissingNote = z.object({
  owner: z.string(),
  name: z.string(),
  /** Paths of the notes that link to it, each listed once. */
  asked: z.array(z.string()),
});

export const TidyResponse = z.object({
  orphans: z.array(NoteRow),
  untagged: z.array(NoteRow),
  deadLinks: z.array(LinkRow),
  stale: z.array(NoteRow),
  conflicts: z.array(ConflictRow),
  missing: z.array(MissingNote),
  /** True when any list was capped. Shown, never swallowed. */
  truncated: z.boolean(),
  /** The real counts, so a capped list still reports what it stands for. */
  totals: z.object({
    orphans: z.number(),
    untagged: z.number(),
    deadLinks: z.number(),
    stale: z.number(),
    conflicts: z.number(),
    missing: z.number(),
  }),
});

export const TasksResponse = z.object({
  tasks: z.array(TaskRow),
  /** The real count behind the (possibly capped) list — see `TidyResponse.totals`. */
  total: z.number(),
  /** True when `tasks` is fewer than `total`: shown, never swallowed. */
  truncated: z.boolean(),
});

export const SearchResponse = z.object({ hits: z.array(SearchHit) });

export const LinksResponse = z.object({
  backlinks: z.array(LinkRow),
  outgoing: z.array(LinkRow),
});

export const User = z.object({
  id: z.string(),
  displayName: z.string(),
  role: z.enum(['admin', 'user']),
});

export const MeResponse = z.object({ user: User });

export const TreeDirRow = z.object({ owner: z.string(), path: z.string() });

export const ShareKind = z.enum(['vault', 'folder', 'note']);

export const Share = z.object({
  id: z.string(),
  owner: z.string(),
  /** The whole vault, one folder, or exactly one note. */
  kind: ShareKind,
  /**
   * The stored region: `''` for the vault, the folder with a trailing `/`, or
   * the note's exact path. A note share matches that path only, never a longer
   * one that starts the same way.
   */
  prefix: z.string(),
  grantee: z.string(),
  canWrite: z.boolean(),
  createdAt: Timestamp,
});

export const SharesResponse = z.object({
  granted: z.array(Share),
  received: z.array(Share),
});

export const GraphResponse = z.object({
  nodes: z.array(
    z.object({
      owner: z.string(),
      path: z.string(),
      title: z.string(),
      folder: z.string(),
      links: z.number(),
      /**
       * Both required, and the view depends on it.
       *
       * They were introduced optional so that `GraphData` literals in test
       * files belonging to other strands would keep compiling through a
       * parallel build. That is over: the regions are named from the tags and
       * the warm accent is `updatedAt`, so a reply without them is not a reply
       * this view can draw. `queries.graph` has always sent both.
       */
      /** Case-preserved tags, gathered under the same view as the node itself. */
      tags: z.array(z.string()),
      /** Last-write time, same clock as everywhere else in the API. */
      updatedAt: Timestamp,
    }),
  ),
  edges: z.array(z.object({ owner: z.string(), from: z.string(), to: z.string() })),
});

export const PulseEvent = z.object({
  at: Timestamp,
  kind: z.enum(['read', 'write']),
  /** The edit action, or the MCP tool name. */
  what: z.string(),
  /** Null for activity without one note — a search, a listing, a vault map. */
  path: z.string().nullable(),
  /** Account name for a person, key name for an agent. */
  who: z.string(),
  agent: z.boolean(),
  /** Always the caller: the pulse never reports another vault. */
  owner: z.string(),
});

export const PulseResponse = z.object({
  events: z.array(PulseEvent),
  now: Timestamp,
});

/** One day of the caller's own activity, as counts of distinct notes and agent calls. */
export const ActivityDay = z.object({
  start: Timestamp,
  end: Timestamp,
  created: z.number(),
  /** Changed that day, and not also created that day. */
  edited: z.number(),
  deleted: z.number(),
  renamed: z.number(),
  touched: z.number(),
  agentReads: z.number(),
  agentWrites: z.number(),
});

/** Always the caller's own vault, like the pulse. Oldest day first. */
export const ActivityDaysResponse = z.object({
  days: z.array(ActivityDay),
});

export const PutNoteResponse = z.object({
  note: Note,
  created: z.boolean(),
  /** Set when this write displaced a version the writer had not seen; names the
   *  copy that version was kept in. Nothing was lost, but somebody has to be told. */
  conflictCopy: z.string().optional(),
});

export const TagsResponse = z.object({
  tags: z.array(z.object({ tag: z.string(), count: z.number() })),
});

export const PropValuesResponse = z.object({
  values: z.array(z.object({ value: z.string(), count: z.number() })),
});

export const BulkResponse = z.object({
  /** Final paths of the notes that succeeded — a move changes the path. */
  ok: z.array(z.string()),
  failed: z.array(z.object({ path: z.string(), reason: z.string() })),
});

export const CreateFolderResponse = z.object({ folder: z.string() });

export const RenameFolderResponse = z.object({
  folder: z.string(),
  movedNotes: z.array(z.string()),
  updatedLinks: z.array(z.string()),
});

export const RenameNoteResponse = z.object({
  note: Note,
  updatedLinks: z.array(z.string()),
});

export const QuickFindResponse = z.object({ notes: z.array(NoteRow) });

export const MapResponse = z.object({
  notes: z.array(z.unknown()),
  props: z.array(z.object({ key: z.string(), count: z.number() })),
});

export const GrantShareResponse = z.object({ share: Share });

export const LogoutResponse = z.object({ ok: z.boolean() });

/* ---- files --------------------------------------------------------------- */

/**
 * Everything in the vault, notes included.
 *
 * `isNote` rather than a separate listing: a vault is one folder of files, and
 * splitting it into "notes" and "the rest" in the API would invite the two to
 * drift apart. The file browser wants all of it; the tree filters.
 */
export const FileRow = z.object({
  owner: z.string(),
  path: z.string(),
  size: z.number(),
  mtimeMs: Timestamp,
  isNote: z.boolean(),
});

export const FilesResponse = z.object({
  files: z.array(FileRow),
  /** Folders too, so an empty one does not vanish from the browser. */
  dirs: z.array(z.string()),
  truncated: z.boolean(),
});

export const UploadResult = z.object({
  path: z.string(),
  size: z.number(),
  replaced: z.boolean(),
  ok: z.boolean(),
  error: z.string().optional(),
});

export const UploadResponse = z.object({ results: z.array(UploadResult) });

/* ---- topics -------------------------------------------------------------- */

export const TopicProposal = z.object({
  path: z.string(),
  title: z.string(),
  existing: z.array(z.string()),
  proposed: z.array(z.string()),
  /** The line it was read from, so a person can check the machine's reading. */
  source: z.string(),
});

export const TopicsResponse = z.object({ proposals: z.array(TopicProposal) });

/** Which notes, never which tags — the server re-derives those. */
export const ApplyTopicsRequest = z
  .object({ paths: z.array(VaultPath).min(1).max(5000) })
  .strict();

export const ApplyTopicsResponse = z.object({
  applied: z.array(z.object({ path: z.string(), added: z.array(z.string()) })),
});

/* ---- history ------------------------------------------------------------- */

export const Version = z.object({
  id: z.string(),
  at: Timestamp,
  subject: z.string(),
  size: z.number(),
});

export const HistoryResponse = z.object({
  /** False where the host has no sidecar repository — a deployment fact. */
  available: z.boolean(),
  versions: z.array(Version),
});

export const VersionContentResponse = z.object({ content: z.string() });

export const RestoreRequest = z
  .object({ owner: UserId, path: VaultPath, version: z.string().min(4).max(64) })
  .strict();

export const RestoreResponse = z.object({ note: Note, created: z.boolean() });

/* ---- recently deleted ---------------------------------------------------- */

/**
 * Why a deleted note can or cannot be brought back: a saved version exists; the
 * host keeps no history; it does but has recorded nothing yet; or no saved
 * version holds this note.
 */
export const RestoreState = z.enum(['ready', 'no-history', 'no-commit', 'no-version']);

export const DeletedNote = z.object({
  owner: z.string(),
  path: z.string(),
  title: z.string(),
  folder: z.string(),
  /** Who deleted it. */
  actor: z.string(),
  at: Timestamp,
  restore: RestoreState,
  /** When the version a restore brings back was saved; null unless `ready`. */
  savedAt: Timestamp.nullable(),
});

export const DeletedResponse = z.object({ notes: z.array(DeletedNote) });

export type DeletedNote = z.infer<typeof DeletedNote>;
export type RestoreState = z.infer<typeof RestoreState>;
export type DeletePreview = z.infer<typeof DeletePreviewResponse>;

export const RestoreDeletedRequest = z.object({ owner: UserId, path: VaultPath }).strict();

export const RestoreDeletedResponse = z.object({
  note: Note,
  /** False when the old path was taken and the note came back under another name. */
  samePath: z.boolean(),
});

export const DeletePreviewRequest = z
  .object({ owner: UserId, paths: z.array(VaultPath).min(1).max(10_000) })
  .strict();

export const DeletePreviewResponse = z.object({
  restorable: z.number(),
  unsaved: z.number(),
  notYours: z.number(),
  history: z.boolean(),
});

/* ---- administration ------------------------------------------------------ */

export const AdminUser = z.object({
  id: z.string(),
  displayName: z.string(),
  role: z.enum(['admin', 'user']),
  disabled: z.boolean(),
  createdAt: Timestamp,
  notes: z.number(),
  keys: z.number(),
});

export const AdminUsersResponse = z.object({ users: z.array(AdminUser) });

/**
 * A shared vault nobody signs in to. `members` counts its shares; the shares
 * themselves come from `/admin/spaces/:id/members`.
 */
export const AdminSpace = z.object({
  id: z.string(),
  displayName: z.string(),
  disabled: z.boolean(),
  noteCount: z.number(),
  members: z.number(),
});

export const AdminSpacesResponse = z.object({ spaces: z.array(AdminSpace) });

export const CreateSpaceRequest = z
  .object({ id: UserId, displayName: z.string().min(1).max(64).optional() })
  .strict();

export const UpdateSpaceRequest = z
  .object({ displayName: z.string().min(1).max(64).optional(), disabled: z.boolean().optional() })
  .strict();

/** The members of a space: shares whose owner is the space. */
export const SpaceMembersResponse = z.object({ members: z.array(Share) });

/** A space's folders and notes as paths and titles, for choosing what to grant. */
export const AdminSpaceTreeResponse = z.object({
  dirs: z.array(z.string()),
  notes: z.array(z.object({ path: z.string(), title: z.string() })),
});

export const CreateUserRequest = z
  .object({
    id: UserId,
    // Length beats composition rules, which mostly teach people to put an
    // exclamation mark at the end.
    password: z.string().min(10).max(1024),
    displayName: z.string().min(1).max(64).optional(),
    role: z.enum(['admin', 'user']).optional(),
  })
  .strict();

export const AdminPasswordRequest = z.object({ password: z.string().min(10).max(1024) }).strict();

export const DisableUserRequest = z.object({ disabled: z.boolean() }).strict();

export const ApiKey = z.object({
  id: z.string(),
  owner: z.string(),
  name: z.string(),
  /** Path prefix the key may read; `''` is the whole vault. */
  scope: z.string(),
  canWrite: z.boolean(),
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
  revoked: z.boolean(),
});

export const AdminKeysResponse = z.object({ keys: z.array(ApiKey) });

export const CreateKeyRequest = z
  .object({
    owner: UserId,
    name: z.string().min(1).max(64),
    scope: z.string().max(1024).optional(),
    canWrite: z.boolean().optional(),
  })
  .strict();

/** The one response that carries a secret; it is never retrievable again. */
export const CreatedKeyResponse = ApiKey.extend({ secret: z.string() });

/* ---- settings and account ------------------------------------------------ */

export const UserSettings = z.object({
  /** Days a note may sit untouched before the tidy view calls it stale. */
  staleDays: z.number().int().min(1).max(3650),
});

export const SettingsResponse = z.object({ settings: UserSettings });

/** Partial on purpose: two tabs on this page must not undo each other. */
export const SettingsRequest = UserSettings.partial().strict();

export const ProfileRequest = z.object({ displayName: z.string().min(1).max(64) }).strict();

export const ChangePasswordRequest = z
  .object({
    /** Required even though the caller holds a session — see the route. */
    currentPassword: z.string().min(1),
    // The same floor the CLI enforces. Length beats composition rules, which
    // mostly teach people to put an exclamation mark at the end.
    newPassword: z.string().min(10).max(1024),
  })
  .strict();

export const OkResponse = z.object({ ok: z.boolean() });

/* ---- requests ------------------------------------------------------------ */

export const LoginRequest = z
  .object({ user: z.string().min(1), password: z.string().min(1) })
  .strict();

export const PutNoteRequest = z
  .object({
    content: z.string(),
    /** Which vault. Also accepted in the query string; the route reads both. */
    owner: UserId.optional(),
    /** The version the editor started from; drives conflict detection. */
    baseMtimeMs: z.number().optional(),
    /**
     * Create the note only if it is not there. An existing note is returned
     * untouched with `created: false`: no write, no conflict copy.
     */
    ifAbsent: z.boolean().optional(),
  })
  .strict();

/**
 * Add text to a note without rewriting it.
 *
 * Deliberately not a `PutNoteRequest` with a flag: an append carries no
 * `baseMtimeMs`, because it displaces no version, and a request that could
 * carry one would invite a caller to send the whole note with it.
 */
export const AppendNoteRequest = z
  .object({
    content: z.string().min(1),
    /** Which vault. Also accepted in the query string; the route reads both. */
    owner: UserId.optional(),
    /**
     * The heading the text goes under, by its own words — `Notizen` for the
     * daily note. Left out, the text goes at the end of the note; a heading the
     * note does not have falls back to the same place rather than refusing.
     */
    section: z.string().min(1).max(200).optional(),
    /**
     * What the note is created with when it is not there yet. Without it an
     * absent note is answered like any other missing note.
     */
    ifAbsent: z.string().optional(),
  })
  .strict();

export const RenameNoteRequest = z
  .object({ owner: UserId.optional(), from: VaultPath, to: VaultPath })
  .strict();

/** `owner` names another vault — a space — under a share with write access. */
export const CreateFolderRequest = z.object({ path: VaultPath, owner: UserId.optional() }).strict();

export const RenameFolderRequest = z
  .object({ from: VaultPath, to: VaultPath, owner: UserId.optional() })
  .strict();

export const BulkRequest = z
  .object({
    owner: UserId,
    paths: z.array(VaultPath).min(1).max(1000),
    action: z.enum(['move', 'tag', 'untag', 'delete']),
    dir: z.string().optional(),
    tag: z.string().optional(),
  })
  .strict();

/**
 * `{ grantee, kind, path, canWrite }`. `prefix` without `kind` is the form
 * sent before kinds existed and still means a folder, or the vault when empty.
 */
export const GrantShareRequest = z
  .object({
    grantee: z.string().max(64),
    kind: ShareKind.optional(),
    path: z.string().max(1024).optional(),
    prefix: z.string().max(1024).optional(),
    canWrite: z.boolean().optional(),
  })
  .strict();

export const ToggleTaskRequest = z
  .object({
    owner: UserId.optional(),
    path: VaultPath,
    /** 1-based, file-relative — exactly what `TaskRow.line` reports. */
    line: z.number().int().positive(),
    /** The task text and done state the client last saw at that line. */
    expectedText: z.string(),
    expectedDone: z.boolean(),
    /** The state to set it to. */
    done: z.boolean(),
  })
  .strict();

/* ---- inferred types ------------------------------------------------------ */

export type NoteRow = z.infer<typeof NoteRow>;
export type Note = z.infer<typeof Note>;
export type OpenNote = z.infer<typeof OpenNote>;
export type SearchHit = z.infer<typeof SearchHit>;
export type LinkRow = z.infer<typeof LinkRow>;
export type ConflictRow = z.infer<typeof ConflictRow>;
export type MissingNote = z.infer<typeof MissingNote>;
export type TaskRow = z.infer<typeof TaskRow>;
export type ActivityRow = z.infer<typeof ActivityRow>;
export type Overview = z.infer<typeof OverviewResponse>;
export type Tidy = z.infer<typeof TidyResponse>;
export type Tasks = z.infer<typeof TasksResponse>;
export type User = z.infer<typeof User>;
export type Share = z.infer<typeof Share>;
export type ShareKind = z.infer<typeof ShareKind>;
export type VisibleOwner = z.infer<typeof VisibleOwner>;
export type GraphData = z.infer<typeof GraphResponse>;
export type PulseEvent = z.infer<typeof PulseEvent>;
export type ActivityDay = z.infer<typeof ActivityDay>;
export type FileRow = z.infer<typeof FileRow>;
export type UserSettings = z.infer<typeof UserSettings>;
export type AdminUser = z.infer<typeof AdminUser>;
export type AdminSpace = z.infer<typeof AdminSpace>;
export type ApiKey = z.infer<typeof ApiKey>;
export type Version = z.infer<typeof Version>;
export type TopicProposal = z.infer<typeof TopicProposal>;
export type FilesResponse = z.infer<typeof FilesResponse>;
export type UploadResult = z.infer<typeof UploadResult>;
