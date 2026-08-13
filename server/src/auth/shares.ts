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

import type { Database } from '../db/database.js';
import { NdbrainError, NoteNotFoundError } from '../errors.js';
import { normalizeVaultPath } from '../vault/paths.js';

export interface Share {
  id: string;
  owner: string;
  /** Path prefix, `''` for the whole vault. Always ends in `/` when non-empty. */
  prefix: string;
  grantee: string;
  canWrite: boolean;
  createdAt: number;
}

/** One region of one vault a caller may read. */
export interface Scope {
  owner: string;
  /** `''` means the whole vault. */
  prefix: string;
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

/** True if `notePath` lies inside `prefix`. */
export function withinPrefix(prefix: string, notePath: string): boolean {
  return prefix === '' || notePath.startsWith(prefix);
}

function toShare(row: Record<string, unknown>): Share {
  return {
    id: String(row['id']),
    owner: String(row['owner']),
    prefix: String(row['prefix']),
    grantee: String(row['grantee']),
    canWrite: Number(row['can_write']) === 1,
    createdAt: Number(row['created_at']),
  };
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
   */
  grant(owner: string, prefix: string, grantee: string, canWrite = false): Share {
    if (owner === grantee) {
      // Not an error worth tolerating quietly: it would create a row that can be
      // revoked, implying the owner could lose access to their own vault.
      throw new InvalidShareError('a vault cannot be shared with its own owner');
    }

    const normalized = normalizePrefix(prefix);
    const existing = this.#db.get(
      'SELECT * FROM shares WHERE owner = ? AND prefix = ? AND grantee = ?',
      owner,
      normalized,
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
    this.#db.run(
      'INSERT INTO shares (id, owner, prefix, grantee, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      owner,
      normalized,
      grantee,
      canWrite ? 1 : 0,
      Date.now(),
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

  /** What this user has shared out. */
  byOwner(owner: string): Share[] {
    return this.#db
      .all('SELECT * FROM shares WHERE owner = ? ORDER BY grantee, prefix', owner)
      .map(toShare);
  }

  /** What has been shared with this user. */
  toGrantee(grantee: string): Share[] {
    return this.#db
      .all('SELECT * FROM shares WHERE grantee = ? ORDER BY owner, prefix', grantee)
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
    const own: Scope = { owner: caller, prefix: '', canWrite: true };
    const shared = this.toGrantee(caller).map((share) => ({
      owner: share.owner,
      prefix: share.prefix,
      canWrite: share.canWrite,
    }));
    return [own, ...shared];
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
        withinPrefix(share.prefix, path) &&
        (need === 'read' || share.canWrite),
    );

    // Read and write refusals are the same answer on purpose. Distinguishing them
    // would confirm the note exists to somebody holding read-only access to a
    // sibling folder.
    if (!permitted) throw new NoteNotFoundError('note does not exist');
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
}
