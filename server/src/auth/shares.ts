/**
 * Sharing: who may see into somebody else's vault.
 *
 * Up to here every user had a sealed vault and "owner" answered every access
 * question by itself. Sharing breaks that identity apart into two distinct
 * things, and keeping them apart is what makes this safe to reason about:
 *
 *  - the **caller** — the account making the request;
 *  - the **owner** — the account whose vault the note actually lives in.
 *
 * Every existing vault and index function keeps taking the *owner*, exactly as
 * before. Nothing below this layer learns what a share is. What this module adds
 * is a gate in front: given a caller, decide which owners' notes they may touch
 * and how. The tenant boundary is therefore not weakened by sharing — it is
 * still the same boundary, with an explicit, revocable list of doors in it.
 *
 * Two questions, two functions, and everything goes through one of them:
 *
 *  - `check(caller, owner, path, need)` — may this caller do this to this note?
 *  - `view(caller)` — which (owner, prefix) pairs may this caller read?
 *
 * A refused `check` throws `NoteNotFoundError`, never a "forbidden": a caller who
 * can tell the difference between "not shared with you" and "does not exist" can
 * map out the parts of somebody else's vault they were never shown.
 */

import { randomBytes } from 'node:crypto';

import type { Database, SqlValue } from '../db/database.js';
import { prefixSql } from '../db/prefix.js';
import { NdbrainError, NoteNotFoundError } from '../errors.js';
import { isNotePath, normalizeVaultPath } from '../vault/paths.js';

export type ShareKind = 'vault' | 'folder' | 'note';

export interface Share {
  id: string;
  owner: string;
  /** What the share covers: the whole vault, one folder, or exactly one note. */
  kind: ShareKind;
  /**
   * The stored region. `''` for the vault, the folder with a trailing `/`, or
   * the note's exact path. Read it through `inScope`, never by hand.
   */
  prefix: string;
  grantee: string;
  canWrite: boolean;
  createdAt: number;
  /** For a note share, when it came to name `prefix` — see `Region.since`. */
  boundAt: number | null;
}

/**
 * The part of a scope that says which paths it covers.
 *
 * `exact` is what makes a note share a note share: the prefix is then a whole
 * path that has to match in full, never the start of a longer one.
 */
export interface Region {
  prefix: string;
  exact: boolean;
  /**
   * For an exact region: the moment it came to name this path. What a path's
   * past holds from before then — history, edits — belongs to whatever had the
   * name earlier. Ignored for anything but time-stamped rows.
   */
  since?: number;
}

/** One region of one vault a caller may read. */
export interface Scope extends Region {
  owner: string;
  /** False for a region that may be read but not written. */
  canWrite: boolean;
}

/**
 * Everything a caller may read, own vault first.
 *
 * Never empty: the caller's own vault is always the first entry, so a view that
 * somehow lost its shares still shows the person their own notes rather than
 * nothing.
 */
export type View = Scope[];

/** An owner whose notes a caller can see, with what the interface calls it. */
export interface VisibleOwner {
  id: string;
  kind: 'person' | 'space';
  displayName: string;
}

export class UnknownShareError extends NdbrainError {}
export class InvalidShareError extends NdbrainError {}

export type Need = 'read' | 'write';

/**
 * Normalises a share prefix to a directory boundary.
 *
 * The trailing slash is load-bearing. Without it, sharing `Homelab` would also
 * share `Homelab2.md` and `Homelab-Privat/`, which is the difference between a
 * folder and a string that happens to start the same way.
 */
export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return '';
  return `${normalizeVaultPath(trimmed)}/`;
}

/**
 * True if `notePath` lies inside `region`. **The** scope rule.
 *
 * Every question of the form "is this path covered" is answered here or by
 * `regionSql`, its SQL twin directly below — shares, the view in every query,
 * the tree, agent keys and the list a rename reports. A note share ending up
 * behind a `startsWith` somewhere else would hand out `Plan.md.bak` and
 * `Plan.md/…` with it, which is exactly the class of leak the kind exists to
 * rule out.
 *
 * An exact region with an empty prefix covers nothing. It cannot be granted,
 * but if one ever arrived it must fail closed rather than read as the vault.
 */
export function inScope(region: Region, notePath: string): boolean {
  if (region.exact) return region.prefix !== '' && notePath === region.prefix;
  return region.prefix === '' || notePath.startsWith(region.prefix);
}

/**
 * `inScope` as a SQL condition on `column`, or `null` when it covers every path.
 *
 * Kept beside `inScope` so the two cannot drift: the same three cases, in the
 * same order, and `test/region-sql.test.ts` asks both about the same paths so
 * that a drift is a failing test rather than a quiet difference. `substr`
 * rather than `LIKE`, because `LIKE` folds ASCII case in SQLite and paths here
 * are case-sensitive. An exact region compares with `=`, which is
 * case-sensitive too.
 */
export function regionSql(
  column: string,
  region: Region,
  timeColumn?: string,
): { sql: string | null; params: SqlValue[] } {
  if (region.exact) {
    // Same guard as `inScope`: an exact region with no prefix covers nothing.
    // Without it the fragment reads as `column = ''`, which is a path nothing
    // in the vault has but every table would happily be asked about.
    if (region.prefix === '') return { sql: '1 = 0', params: [] };
    // A time-stamped row (an edit) of this path counts only from the moment the
    // region came to name it; see `Region.since`.
    if (timeColumn !== undefined && region.since !== undefined) {
      return { sql: `(${column} = ? AND ${timeColumn} >= ?)`, params: [region.prefix, region.since] };
    }
    return { sql: `${column} = ?`, params: [region.prefix] };
  }
  if (region.prefix === '') return { sql: null, params: [] };
  // Counted in code points, not in `String.length`: SQLite's `substr` counts
  // characters, JavaScript counts UTF-16 code units, and the two disagree by
  // one for every character outside the basic plane. A folder named with an
  // emoji would otherwise ask for more characters than its prefix has and
  // match nothing at all, so the share would silently show an empty folder.
  return prefixSql(column, region.prefix);
}

/** The region a share row covers. */
export function regionOf(share: Pick<Share, 'kind' | 'prefix' | 'boundAt'>): Region {
  if (share.kind !== 'note') return { prefix: share.prefix, exact: false };
  // A note share without a binding moment would reach its path's whole past;
  // the creation time is the latest moment it can certainly claim.
  return { prefix: share.prefix, exact: true, since: share.boundAt ?? Number.MAX_SAFE_INTEGER };
}

function toKind(value: unknown, prefix: string): ShareKind {
  if (value === 'note' || value === 'folder' || value === 'vault') return value;
  return prefix === '' ? 'vault' : 'folder';
}

function toShare(row: Record<string, unknown>): Share {
  const prefix = String(row['prefix']);
  return {
    id: String(row['id']),
    owner: String(row['owner']),
    kind: toKind(row['kind'], prefix),
    prefix,
    grantee: String(row['grantee']),
    canWrite: Number(row['can_write']) === 1,
    createdAt: Number(row['created_at']),
    boundAt: row['bound_at'] === null || row['bound_at'] === undefined ? null : Number(row['bound_at']),
  };
}

/**
 * Turns what a client asked to share into the stored region.
 *
 * A bare string is the form every share was granted in before kinds existed,
 * and it keeps meaning what it meant: empty is the vault, anything else a
 * folder. A note has to be named as one, and has to look like one.
 */
export function shareTarget(target: string | { kind: ShareKind; path: string }): {
  kind: ShareKind;
  prefix: string;
} {
  if (typeof target === 'string') {
    const prefix = normalizePrefix(target);
    return { kind: prefix === '' ? 'vault' : 'folder', prefix };
  }

  switch (target.kind) {
    case 'vault':
      if (target.path.trim().replace(/^\/+|\/+$/g, '') !== '') {
        throw new InvalidShareError('a vault share takes no path');
      }
      return { kind: 'vault', prefix: '' };
    case 'folder': {
      const prefix = normalizePrefix(target.path);
      if (prefix === '') throw new InvalidShareError('name the folder to share');
      return { kind: 'folder', prefix };
    }
    case 'note': {
      const trimmed = target.path.trim();
      if (trimmed === '') throw new InvalidShareError('name the note to share');
      const prefix = normalizeVaultPath(trimmed);
      if (!isNotePath(prefix)) throw new InvalidShareError('a note share names a note');
      return { kind: 'note', prefix };
    }
    default:
      throw new InvalidShareError('unknown share kind');
  }
}

/**
 * What the note write path tells the shares about, from inside its lock.
 *
 * Synchronous on purpose: these are single statements against the same
 * database, and nothing may interleave between the file moving and the share
 * moving with it.
 */
export interface NoteLifecycle {
  /** A note came into being where none was. Nothing may be inherited. */
  created(owner: string, notePath: string): void;
  /** A note was renamed or moved. Its note shares go with it. */
  moved(owner: string, from: string, to: string): void;
  /** A note is gone. Its note shares are withdrawn, not reinterpreted. */
  removed(owner: string, notePath: string): void;
  /**
   * About to write over or move an existing note: withdraws the note shares
   * given for some other file than the one there now, and returns the identity
   * the rest are bound to (null when none are left). See `NoteBindings.confirm`.
   */
  confirm(owner: string, notePath: string): Promise<string | null>;
  /**
   * A write or a move has put a new file at `notePath`: the shares bound to
   * `confirmed` follow it, and no others. See `NoteBindings.rebind`.
   */
  rebind(owner: string, notePath: string, confirmed: string | null): Promise<void>;
}

/** What a note share was last confirmed against: the file, and its content. */
export interface NoteBinding {
  file: string | null;
  hash: string | null;
}

export class ShareService {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Grants (or re-grants) access to a region of `owner`'s vault.
   *
   * Re-granting the same region to the same person changes the right instead of
   * adding a second row. Two rows for one grant would mean the resolver has to
   * decide which wins, and revoking one of them would look like it did nothing.
   *
   * `target` is either the legacy prefix string or `{ kind, path }`. Whether a
   * note share names a note that exists is not decided here — that needs the
   * vault and its lock, see `App.grantShare`.
   */
  grant(
    owner: string,
    target: string | { kind: ShareKind; path: string },
    grantee: string,
    canWrite = false,
  ): Share {
    if (owner === grantee) {
      // Not an error worth tolerating quietly: it would create a row that can be
      // revoked, implying the owner could lose access to their own vault.
      throw new InvalidShareError('a vault cannot be shared with its own owner');
    }

    // Only a person can be given a share. A space signs nobody in, so a share
    // to one would be a row no request could ever use — and a space's own keys
    // see its own vault only, never what is shared with it.
    const recipient = this.#db.get('SELECT kind FROM users WHERE id = ?', grantee);
    if (recipient !== undefined && String(recipient['kind']) !== 'person') {
      throw new InvalidShareError('a share is granted to a person');
    }

    const { kind, prefix } = shareTarget(target);
    const existing = this.#db.get(
      'SELECT * FROM shares WHERE owner = ? AND prefix = ? AND grantee = ?',
      owner,
      prefix,
      grantee,
    );

    if (existing) {
      this.#db.run(
        'UPDATE shares SET can_write = ? WHERE id = ?',
        canWrite ? 1 : 0,
        String(existing['id']),
      );
      return { ...toShare(existing), canWrite };
    }

    const id = `shr_${randomBytes(8).toString('hex')}`;
    const now = Date.now();
    this.#db.run(
      'INSERT INTO shares (id, owner, kind, prefix, grantee, can_write, created_at, bound_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      owner,
      kind,
      prefix,
      grantee,
      canWrite ? 1 : 0,
      now,
      kind === 'note' ? now : null,
    );

    const share = this.get(id);
    if (share === undefined) throw new NdbrainError('share vanished immediately after creation');
    return share;
  }

  get(id: string): Share | undefined {
    const row = this.#db.get('SELECT * FROM shares WHERE id = ?', id);
    return row ? toShare(row) : undefined;
  }

  /**
   * Withdraws a grant. Hard delete, not a soft revoke.
   *
   * The opposite of `api_keys`, and for a reason: a key row is kept after revoking
   * so the access log still has a readable name to show. A share has no log
   * behind it, and a withdrawn permission that lingers as a row is exactly the
   * kind of thing that gets read back as still granted.
   */
  revoke(id: string): void {
    const share = this.get(id);
    if (share === undefined) throw new UnknownShareError('no such share');
    this.#db.run('DELETE FROM shares WHERE id = ?', id);
  }

  /** What this owner has shared out — for a space, its members. */
  byOwner(owner: string): Share[] {
    return this.#db
      .all('SELECT * FROM shares WHERE owner = ? ORDER BY grantee, prefix', owner)
      .map(toShare);
  }

  /**
   * What has been shared with this user and is in force.
   *
   * The one place a disabled space drops out, so the list, the view and
   * `check` cannot disagree about it: its members stop seeing it the moment it
   * is switched off, and see it again, with the same grants, when it is back.
   * A disabled *person* who shared something is left as it always was.
   */
  toGrantee(grantee: string): Share[] {
    return this.#db
      .all(
        `SELECT s.* FROM shares s JOIN users u ON u.id = s.owner
          WHERE s.grantee = ?
            AND NOT (u.kind = 'space' AND u.disabled_at IS NOT NULL)
          ORDER BY s.owner, s.prefix`,
        grantee,
      )
      .map(toShare);
  }

  /**
   * Everything `caller` may read, own vault first.
   *
   * Read directly from the table on every call rather than cached. A cache here
   * would be a permission cache, and a revoked share that keeps working until
   * some TTL expires is not a performance detail — the plan requires that
   * withdrawing access ends it immediately.
   */
  view(caller: string): View {
    const own: Scope = { owner: caller, prefix: '', exact: false, canWrite: true };
    const shared = this.toGrantee(caller).map((share) => ({
      owner: share.owner,
      ...regionOf(share),
      canWrite: share.canWrite,
    }));
    return [own, ...shared];
  }

  /**
   * The owners behind a caller's view, own account first, with their kind and
   * the name to show.
   *
   * Only owners the caller already holds a share from, so this names nobody
   * the shares list does not already name.
   */
  visibleOwners(caller: string): VisibleOwner[] {
    const ids = [caller, ...new Set(this.toGrantee(caller).map((share) => share.owner))];
    const out: VisibleOwner[] = [];
    for (const id of new Set(ids)) {
      const row = this.#db.get('SELECT id, kind, display_name FROM users WHERE id = ?', id);
      if (row === undefined) continue;
      out.push({
        id: String(row['id']),
        kind: String(row['kind']) === 'space' ? 'space' : 'person',
        displayName: String(row['display_name']),
      });
    }
    return out;
  }

  /**
   * The single permission decision. Throws rather than returning false, so a
   * caller cannot forget to look at the answer.
   *
   * A caller in their own vault never touches the shares table at all — the
   * common path stays exactly what it was before sharing existed.
   */
  check(caller: string, owner: string, notePath: string, need: Need = 'read'): void {
    if (caller === owner) return;

    const path = normalizeVaultPath(notePath);
    const permitted = this.toGrantee(caller).some(
      (share) =>
        share.owner === owner &&
        inScope(regionOf(share), path) &&
        (need === 'read' || share.canWrite),
    );

    // Read and write refusals are the same answer on purpose. Distinguishing them
    // would confirm the note exists to somebody holding read-only access to a
    // sibling folder.
    if (!permitted) throw new NoteNotFoundError('note does not exist');
  }

  /**
   * `check` for a folder path: only a vault or folder share can cover one.
   *
   * A note share is an exact region, and an exact region matched against a
   * folder path would grant the folder whenever its name equals the shared
   * note's path. Same refusal as `check`.
   */
  checkFolder(caller: string, owner: string, dirPath: string, need: Need = 'read'): void {
    if (caller === owner) return;

    const path = normalizeVaultPath(dirPath);
    const permitted = this.toGrantee(caller).some((share) => {
      const region = regionOf(share);
      return share.owner === owner && !region.exact && inScope(region, path) && (need === 'read' || share.canWrite);
    });
    if (!permitted) throw new NoteNotFoundError('note does not exist');
  }

  /**
   * From when on `caller` may see the past of `notePath` — its history and its
   * edits. Zero for the owner and for anybody a vault or folder share reaches
   * the path through: those name places, and the place's past is theirs. For
   * somebody who holds only a note share, the moment that share came to name
   * the path. Call it after `check`; it grants nothing by itself.
   */
  pastVisibleFrom(caller: string, owner: string, notePath: string): number {
    if (caller === owner) return 0;
    const path = normalizeVaultPath(notePath);
    let from = Number.MAX_SAFE_INTEGER;
    for (const share of this.toGrantee(caller)) {
      if (share.owner !== owner) continue;
      const region = regionOf(share);
      if (!inScope(region, path)) continue;
      if (!region.exact) return 0;
      from = Math.min(from, region.since ?? Number.MAX_SAFE_INTEGER);
    }
    return from;
  }

  /**
   * Whether `caller` holds a note share on exactly this path.
   *
   * Asked before a read confirms a binding, because confirming costs a lock, a
   * `stat` and a hash of the file while an unshared path costs one query — and
   * a difference in cost is a difference anybody can measure. Only a caller who
   * holds a note share has anything to gain from the confirmation, and for her
   * the cost says nothing she does not already know.
   */
  hasNoteShare(caller: string, owner: string, notePath: string): boolean {
    return this.noteSharePaths(caller, owner).includes(normalizeVaultPath(notePath));
  }

  /** The paths of the note shares `caller` holds in `owner`'s vault. */
  noteSharePaths(caller: string, owner: string): string[] {
    if (caller === owner) return [];
    return this.toGrantee(caller)
      .filter((share) => share.owner === owner && share.kind === 'note')
      .map((share) => share.prefix);
  }

  /** Non-throwing form, for filtering lists rather than gating one access. */
  allows(caller: string, owner: string, notePath: string, need: Need = 'read'): boolean {
    try {
      this.check(caller, owner, notePath, need);
      return true;
    } catch {
      return false;
    }
  }

  /* ---- following the notes ----------------------------------------------
   *
   * A folder share names a place; a note share names a note. The difference
   * shows when a note moves: the place stays where it is, the note share has to
   * go along — and when a note disappears, the share must not wait there for
   * the next note that happens to get the same name.
   */

  /** The paths of every note share into `owner`'s vault. */
  notePaths(owner: string): string[] {
    return this.#db
      .all("SELECT DISTINCT prefix FROM shares WHERE owner = ? AND kind = 'note' ORDER BY prefix", owner)
      .map((row) => String(row['prefix']));
  }

  /**
   * Moves note shares from `from` to `to`.
   *
   * Whatever pointed at `to` before is withdrawn first. The target was free, or
   * the move would have been refused — so a share still naming it belongs to a
   * note that is gone, and letting the moved note inherit it would give a
   * stranger's grant to a note nobody shared with them.
   */
  moveNote(owner: string, from: string, to: string): void {
    if (from === to) return;
    this.#db.transaction(() => {
      this.#db.run("DELETE FROM shares WHERE owner = ? AND kind = 'note' AND prefix = ?", owner, to);
      // Bound anew: the path's past before this moment is another note's.
      this.#db.run(
        "UPDATE shares SET prefix = ?, bound_at = ? WHERE owner = ? AND kind = 'note' AND prefix = ?",
        to,
        Date.now(),
        owner,
        from,
      );
    });
  }

  /** The distinct bindings of the note shares on `notePath`; empty when there are none. */
  noteBindings(owner: string, notePath: string): NoteBinding[] {
    return this.#db
      .all(
        "SELECT DISTINCT bound_file, bound_hash FROM shares WHERE owner = ? AND kind = 'note' AND prefix = ?",
        owner,
        notePath,
      )
      .map((row) => ({
        file: row['bound_file'] === null || row['bound_file'] === undefined ? null : String(row['bound_file']),
        hash: row['bound_hash'] === null || row['bound_hash'] === undefined ? null : String(row['bound_hash']),
      }));
  }

  /** Binds every note share on `notePath` to this file and content. */
  bindNote(owner: string, notePath: string, file: string, hash: string): void {
    this.#db.run(
      "UPDATE shares SET bound_file = ?, bound_hash = ? WHERE owner = ? AND kind = 'note' AND prefix = ?",
      file,
      hash,
      owner,
      notePath,
    );
  }

  /** Moves the note shares on `notePath` bound to `from` onto `file` and `hash`. */
  rebindNote(owner: string, notePath: string, from: string, file: string, hash: string): void {
    this.#db.run(
      "UPDATE shares SET bound_file = ?, bound_hash = ? WHERE owner = ? AND kind = 'note' AND prefix = ? AND bound_file = ?",
      file,
      hash,
      owner,
      notePath,
      from,
    );
  }

  /** Withdraws the note shares on `notePath` that were bound to `file`. */
  dropNoteBoundTo(owner: string, notePath: string, file: string): void {
    this.#db.run(
      "DELETE FROM shares WHERE owner = ? AND kind = 'note' AND prefix = ? AND bound_file = ?",
      owner,
      notePath,
      file,
    );
  }

  /** Withdraws every note share on `notePath`. */
  dropNote(owner: string, notePath: string): void {
    this.#db.run("DELETE FROM shares WHERE owner = ? AND kind = 'note' AND prefix = ?", owner, notePath);
  }

  /**
   * Moves folder shares at or below `from` to the same place below `to`.
   *
   * A grantee who already holds a share on the destination keeps that one and
   * the moving one is withdrawn: two grants for one region cannot both stand
   * (see `grant`), and the one that was given for that name is the one somebody
   * decided on.
   */
  moveFolder(owner: string, from: string, to: string): void {
    const source = normalizePrefix(from);
    const target = normalizePrefix(to);
    if (source === '' || target === '' || source === target) return;

    this.#db.transaction(() => {
      // `prefixSql` for the query, but `source.length` for the rewrite below:
      // SQLite counts characters and `slice` counts code units, so each side
      // needs its own arithmetic. Passing one count to both is the bug this
      // pair of counts exists to avoid.
      const match = prefixSql('prefix', source);
      const moving = this.#db.all(
        `SELECT id, prefix, grantee FROM shares WHERE owner = ? AND kind = 'folder' AND ${match.sql}`,
        owner,
        ...match.params,
      );
      for (const row of moving) {
        const next = `${target}${String(row['prefix']).slice(source.length)}`;
        const taken = this.#db.get(
          'SELECT id FROM shares WHERE owner = ? AND prefix = ? AND grantee = ?',
          owner,
          next,
          String(row['grantee']),
        );
        if (taken !== undefined) {
          this.#db.run('DELETE FROM shares WHERE id = ?', String(row['id']));
        } else {
          this.#db.run('UPDATE shares SET prefix = ? WHERE id = ?', next, String(row['id']));
        }
      }
    });
  }

  /** Withdraws folder shares on `dir` and anything below it. */
  dropFolder(owner: string, dir: string): void {
    const prefix = normalizePrefix(dir);
    if (prefix === '') return;
    const match = prefixSql('prefix', prefix);
    this.#db.run(
      `DELETE FROM shares WHERE owner = ? AND kind = 'folder' AND ${match.sql}`,
      owner,
      ...match.params,
    );
  }
}
