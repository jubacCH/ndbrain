import type { Database } from "../db/database.js";
import type { NoteService } from "../notes/service.js";
import type { Vault } from "../vault/files.js";
import { searchNotes as searchNotesIndex, type SearchHit } from "../index/search.js";
import { buildContext as buildContextIndex, type ContextResult } from "../index/context.js";
import { assertWritable, isPathInScope, type Scope } from "../keys/scope.js";
import { logAccess } from "../audit/log.js";

/** Identity of the calling agent for a single MCP tool invocation. */
export interface Caller {
  keyId: number;
  name: string;
  scope: Scope;
}

export interface ReadNoteResult {
  found: boolean;
  path?: string;
  content?: string;
}

export interface BuildContextResult {
  found: boolean;
  path?: string;
  content?: string;
  backlinks?: string[];
  related?: SearchHit[];
}

/**
 * The scoped, audited surface every MCP tool call goes through: one method per tool,
 * each enforcing the caller's `Scope` and logging exactly one `access_log` row.
 *
 * Security invariants (see Plan 2 Task 7):
 * - Every path-taking tool runs `vault.assertSafePath` BEFORE any scope check, so scope
 *   enforcement always sees the normalized path — a raw `myai/../other/x.md` (whose RAW
 *   string still starts with the "myai/" namespace prefix) must never reach
 *   `isPathInScope` unnormalized, or it would slip past the prefix check.
 * - Reads (`readNote`, `buildContext`) never distinguish "out of scope" from "does not
 *   exist" in their result — both come back as `{ found: false }` — so a scoped key
 *   cannot learn anything about paths outside its namespace.
 * - Mutations reject with the underlying typed error (`ScopeError`, `VaultPathError`, or
 *   a `NoteService` domain error) after logging the denial; the error is always one of
 *   the existing structured classes, never a raw/opaque throw, so callers (and T8's MCP
 *   error mapping) can branch on `instanceof`.
 * - `searchNotes` always forces `namespace = caller.scope.namespace`, ignoring any
 *   client-supplied namespace.
 * - `buildContext`'s backlinks are filtered to the caller's scope: `backlinksOf` itself
 *   has no namespace filter, so without this a scoped key could learn of the
 *   existence/path of out-of-scope notes that merely link into its namespace.
 * - An in-scope read of a nonexistent note is a permitted access, not a denial: once the
 *   scope check passes, `readNote`/`buildContext` log `allowed=1` regardless of whether
 *   the note exists, so an in-scope miss is never conflated with an out-of-scope probe
 *   (which still logs `allowed=0`) — conflating the two would blunt intrusion detection.
 * - Every tool call logs exactly one `access_log` row, including when the underlying
 *   read throws unexpectedly after the scope check: reads guard their core operation
 *   with a try/catch that logs `allowed=0` and rethrows, mirroring how `guardedMutation`
 *   already does this for mutations.
 */
export class NoteTools {
  private db: Database;
  private notes: NoteService;
  private vault: Vault;

  constructor(deps: { db: Database; notes: NoteService; vault: Vault }) {
    this.db = deps.db;
    this.notes = deps.notes;
    this.vault = deps.vault;
  }

  /** Full-text search, always scoped to the caller's namespace regardless of input. */
  searchNotes(caller: Caller, args: { query: string; limit?: number }): { hits: SearchHit[] } {
    let hits: SearchHit[];
    try {
      hits = searchNotesIndex(this.db, args.query, {
        namespace: caller.scope.namespace,
        limit: args.limit,
      });
    } catch (err) {
      logAccess(this.db, caller.keyId, "search_notes", null, false);
      throw err;
    }
    logAccess(this.db, caller.keyId, "search_notes", null, true);
    return { hits };
  }

  /** Reads a note. Out-of-scope and nonexistent paths both return `{ found: false }`. */
  async readNote(caller: Caller, args: { path: string }): Promise<ReadNoteResult> {
    let safePath: string;
    try {
      safePath = this.vault.assertSafePath(args.path);
    } catch (err) {
      logAccess(this.db, caller.keyId, "read_note", args.path, false);
      throw err;
    }
    if (!isPathInScope(caller.scope, safePath)) {
      logAccess(this.db, caller.keyId, "read_note", safePath, false);
      return { found: false };
    }
    let content: string | null;
    try {
      content = await this.notes.read(safePath);
    } catch (err) {
      logAccess(this.db, caller.keyId, "read_note", safePath, false);
      throw err;
    }
    logAccess(this.db, caller.keyId, "read_note", safePath, true);
    if (content === null) return { found: false };
    return { found: true, path: safePath, content };
  }

  /** Lists all vault paths visible to the caller, filtered to their namespace. */
  async listNotes(caller: Caller): Promise<{ paths: string[] }> {
    let all: string[];
    try {
      all = await this.vault.list();
    } catch (err) {
      logAccess(this.db, caller.keyId, "list_notes", null, false);
      throw err;
    }
    const paths = all.filter((p) => isPathInScope(caller.scope, p));
    logAccess(this.db, caller.keyId, "list_notes", null, true);
    return { paths };
  }

  /** Assembles a note with backlinks and related notes; backlinks are filtered to the
   *  caller's scope (see class docstring) since `backlinksOf` itself is unfiltered. */
  async buildContext(caller: Caller, args: { path: string }): Promise<BuildContextResult> {
    let safePath: string;
    try {
      safePath = this.vault.assertSafePath(args.path);
    } catch (err) {
      logAccess(this.db, caller.keyId, "build_context", args.path, false);
      throw err;
    }
    if (!isPathInScope(caller.scope, safePath)) {
      logAccess(this.db, caller.keyId, "build_context", safePath, false);
      return { found: false };
    }
    let result: ContextResult | null;
    try {
      result = await buildContextIndex(
        { db: this.db, read: (p) => this.notes.read(p) },
        safePath,
        { namespace: caller.scope.namespace },
      );
    } catch (err) {
      logAccess(this.db, caller.keyId, "build_context", safePath, false);
      throw err;
    }
    // An in-scope call is logged as allowed regardless of whether the note exists —
    // "in scope but missing" is a permitted access, not a denial, and conflating the
    // two with an out-of-scope probe (also allowed=0) would blunt intrusion detection.
    logAccess(this.db, caller.keyId, "build_context", safePath, true);
    if (result === null) return { found: false };
    return {
      found: true,
      path: result.path,
      content: result.content,
      backlinks: result.backlinks.filter((b) => isPathInScope(caller.scope, b)),
      related: result.related,
    };
  }

  writeNote(caller: Caller, args: { path: string; content: string }): Promise<{ ok: true }> {
    return this.guardedMutation(caller, "write_note", args.path, async () => {
      const safePath = this.vault.assertSafePath(args.path);
      assertWritable(caller.scope, safePath);
      await this.notes.write(safePath, args.content, caller.name);
      return { ok: true as const };
    });
  }

  editNote(caller: Caller, args: { path: string; find: string; replace: string }): Promise<{ ok: true }> {
    return this.guardedMutation(caller, "edit_note", args.path, async () => {
      const safePath = this.vault.assertSafePath(args.path);
      assertWritable(caller.scope, safePath);
      await this.notes.editNote(safePath, args.find, args.replace, caller.name);
      return { ok: true as const };
    });
  }

  appendNote(caller: Caller, args: { path: string; content: string }): Promise<{ ok: true }> {
    return this.guardedMutation(caller, "append_note", args.path, async () => {
      const safePath = this.vault.assertSafePath(args.path);
      assertWritable(caller.scope, safePath);
      await this.notes.appendNote(safePath, args.content, caller.name);
      return { ok: true as const };
    });
  }

  /** Both `from` and `to` must be safe paths, in scope and writable. */
  moveNote(caller: Caller, args: { from: string; to: string }): Promise<{ ok: true }> {
    return this.guardedMutation(caller, "move_note", `${args.from} -> ${args.to}`, async () => {
      const safeFrom = this.vault.assertSafePath(args.from);
      const safeTo = this.vault.assertSafePath(args.to);
      assertWritable(caller.scope, safeFrom);
      assertWritable(caller.scope, safeTo);
      await this.notes.move(safeFrom, safeTo, caller.name);
      return { ok: true as const };
    });
  }

  deleteNote(caller: Caller, args: { path: string }): Promise<{ ok: true; removed: boolean }> {
    return this.guardedMutation(caller, "delete_note", args.path, async () => {
      const safePath = this.vault.assertSafePath(args.path);
      assertWritable(caller.scope, safePath);
      const removed = await this.notes.remove(safePath, caller.name);
      return { ok: true as const, removed };
    });
  }

  /** Runs a mutation, logging exactly one access_log row: allowed=1 on success,
   *  allowed=0 (and rethrow) on any failure — scope violation, unsafe path or a
   *  NoteService domain error (not-found/exists/ambiguous). The thrown error is always
   *  the original typed class, never swallowed into a generic/opaque error. */
  private async guardedMutation<T>(
    caller: Caller,
    tool: string,
    target: string | null,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await fn();
      logAccess(this.db, caller.keyId, tool, target, true);
      return result;
    } catch (err) {
      logAccess(this.db, caller.keyId, tool, target, false);
      throw err;
    }
  }
}
