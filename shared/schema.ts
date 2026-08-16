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
  rank: z.number(),
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

export const TreeResponse = z.object({
  notes: z.array(NoteRow),
  dirs: z.array(z.object({ owner: z.string(), path: z.string() })),
});

export const OverviewResponse = z.object({
  counts: z.object({
    notes: z.number(),
    orphans: z.number(),
    untagged: z.number(),
    deadLinks: z.number(),
    stale: z.number(),
    /** Distinct notes affected — not the sum of the four above, which overlap. */
    attention: z.number(),
    /** False where no note carries a tag, which makes "untagged" meaningless. */
    tagsInUse: z.boolean(),
  }),
  recent: z.array(NoteRow),
  tasks: z.array(TaskRow),
  tags: z.array(z.object({ tag: z.string(), count: z.number() })),
  activity: z.array(ActivityRow),
});

export const TidyResponse = z.object({
  orphans: z.array(NoteRow),
  untagged: z.array(NoteRow),
  deadLinks: z.array(LinkRow),
  stale: z.array(NoteRow),
  /** True when any list was capped. Shown, never swallowed. */
  truncated: z.boolean(),
  /** The real counts, so a capped list still reports what it stands for. */
  totals: z.object({
    orphans: z.number(),
    untagged: z.number(),
    deadLinks: z.number(),
    stale: z.number(),
  }),
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

export const Share = z.object({
  id: z.string(),
  owner: z.string(),
  /** Path prefix, `''` for the whole vault. Ends in `/` when it names a folder. */
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
  })
  .strict();

export const RenameNoteRequest = z
  .object({ owner: UserId.optional(), from: VaultPath, to: VaultPath })
  .strict();

export const CreateFolderRequest = z.object({ path: VaultPath }).strict();

export const RenameFolderRequest = z.object({ from: VaultPath, to: VaultPath }).strict();

export const BulkRequest = z
  .object({
    owner: UserId,
    paths: z.array(VaultPath).min(1).max(1000),
    action: z.enum(['move', 'tag', 'untag', 'delete']),
    dir: z.string().optional(),
    tag: z.string().optional(),
  })
  .strict();

export const GrantShareRequest = z
  .object({ grantee: UserId, prefix: z.string(), canWrite: z.boolean() })
  .strict();

/* ---- inferred types ------------------------------------------------------ */

export type NoteRow = z.infer<typeof NoteRow>;
export type Note = z.infer<typeof Note>;
export type OpenNote = z.infer<typeof OpenNote>;
export type SearchHit = z.infer<typeof SearchHit>;
export type LinkRow = z.infer<typeof LinkRow>;
export type TaskRow = z.infer<typeof TaskRow>;
export type ActivityRow = z.infer<typeof ActivityRow>;
export type Overview = z.infer<typeof OverviewResponse>;
export type Tidy = z.infer<typeof TidyResponse>;
export type User = z.infer<typeof User>;
export type Share = z.infer<typeof Share>;
export type GraphData = z.infer<typeof GraphResponse>;
export type PulseEvent = z.infer<typeof PulseEvent>;
export type FileRow = z.infer<typeof FileRow>;
export type UserSettings = z.infer<typeof UserSettings>;
export type Version = z.infer<typeof Version>;
export type TopicProposal = z.infer<typeof TopicProposal>;
export type FilesResponse = z.infer<typeof FilesResponse>;
export type UploadResult = z.infer<typeof UploadResult>;
