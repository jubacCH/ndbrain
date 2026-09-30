/**
 * Agent keys.
 *
 * A key is not a second kind of account — it *acts as* a user and can only ever
 * see less than that user, never more. Two independent restrictions apply on
 * every call: the owner's vault boundary (unchanged, enforced where it always
 * was) and the key's own path prefix. A key with an empty scope still cannot
 * leave its owner's vault.
 *
 * This is what makes the MCP endpoint safe to hand to a third-party client: the
 * worst a leaked key can do is what its scope allows, and revoking it is one row.
 */

import { createHash, randomBytes } from 'node:crypto';

import { KEY_EXPIRY_WARNING_DAYS } from '../../../shared/schema.js';
import type { Database } from '../db/database.js';
import { NdbrainError } from '../errors.js';
import { normalizeVaultPath } from '../vault/paths.js';
import { inScope } from './shares.js';

export interface ApiKey {
  id: string;
  owner: string;
  name: string;
  /** Path prefix, `''` for the whole vault. Always ends in `/` when non-empty. */
  scope: string;
  canWrite: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  /**
   * When the key stops working, or null for one that was made to last.
   *
   * Null is not "not set yet": it is the answer for a key whose job outlives
   * any sensible deadline — the monthly cron run — and for every key that
   * existed before expiry did. See the v13 migration.
   */
  expiresAt: number | null;
  revoked: boolean;
}

export class UnknownKeyError extends NdbrainError {}

/** Recognisable prefix, so a leaked key is greppable in logs and repos. */
const KEY_PREFIX = 'ndb_';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a key lasts when nobody chooses.
 *
 * A year, and the default matters more than the number: a lifetime that has to
 * be asked for is a lifetime nobody asks for, which is how a key called
 * `Claude Macbook` was still valid months after being replaced. A year is long
 * enough that renewing is not a chore anybody routes around, and short enough
 * that a key forgotten in an old config file dies on its own.
 */
export const DEFAULT_LIFETIME_DAYS = 365;

/**
 * How far ahead `expiringSoon` looks.
 *
 * Two weeks, chosen against the thing being prevented rather than as a round
 * number: the warning has to survive somebody being away, and a key that
 * expires while nobody is reading the logs is the silent 401 this is here to
 * avoid.
 *
 * The number itself lives in `shared/schema.ts` because the admin table reads
 * the same edge to decide when to count days instead of showing a date.
 */
export const EXPIRY_WARNING_DAYS = KEY_EXPIRY_WARNING_DAYS;

function hashKey(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Normalises a scope to a directory prefix.
 *
 * The trailing slash is what stops `Homelab` from also matching `Homelab2` —
 * the same bug the folder filter has, and the same fix.
 */
export function normalizeScope(scope: string): string {
  const trimmed = scope.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return '';
  return `${normalizeVaultPath(trimmed)}/`;
}

function toKey(row: Record<string, unknown>): ApiKey {
  return {
    id: String(row['id']),
    owner: String(row['owner']),
    name: String(row['name']),
    scope: String(row['scope']),
    canWrite: Number(row['can_write']) === 1,
    createdAt: Number(row['created_at']),
    lastUsedAt: row['last_used_at'] === null || row['last_used_at'] === undefined
      ? null
      : Number(row['last_used_at']),
    expiresAt: row['expires_at'] === null || row['expires_at'] === undefined
      ? null
      : Number(row['expires_at']),
    revoked: row['revoked_at'] !== null && row['revoked_at'] !== undefined,
  };
}

export class ApiKeyService {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Returns the secret exactly once; only its hash is stored.
   *
   * `expiresInDays` has three meanings on purpose: left out it takes
   * `DEFAULT_LIFETIME_DAYS`, a number is that many days, and `null` is a key
   * with no deadline. Three values rather than a magic zero because "never
   * expires" is a decision somebody makes for a reason, and a decision written
   * as `0` is one a reader has to look up.
   */
  create(
    owner: string,
    name: string,
    options: { scope?: string; canWrite?: boolean; expiresInDays?: number | null } = {},
    now = Date.now(),
  ): { key: ApiKey; secret: string } {
    const secret = `${KEY_PREFIX}${randomBytes(32).toString('hex')}`;
    const id = `key_${randomBytes(8).toString('hex')}`;
    const scope = normalizeScope(options.scope ?? '');

    const days = options.expiresInDays === undefined ? DEFAULT_LIFETIME_DAYS : options.expiresInDays;
    const expiresAt = days === null ? null : now + days * DAY_MS;

    this.#db.run(
      `INSERT INTO api_keys (id, key_hash, owner, name, scope, can_write, created_at, last_used_at, revoked_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      id,
      hashKey(secret),
      owner,
      name,
      scope,
      options.canWrite === true ? 1 : 0,
      now,
      expiresAt,
    );

    const key = this.get(id);
    if (key === undefined) throw new NdbrainError('key vanished immediately after creation');
    return { key, secret };
  }

  get(id: string): ApiKey | undefined {
    const row = this.#db.get('SELECT * FROM api_keys WHERE id = ?', id);
    return row ? toKey(row) : undefined;
  }

  list(owner: string): ApiKey[] {
    return this.#db
      .all('SELECT * FROM api_keys WHERE owner = ? ORDER BY created_at DESC', owner)
      .map(toKey);
  }

  /**
   * Resolves a presented secret. Null for unknown, revoked, expired or
   * malformed keys — the four are one answer, deliberately.
   */
  resolve(secret: string, now = Date.now()): ApiKey | null {
    if (typeof secret !== 'string' || !secret.startsWith(KEY_PREFIX)) return null;

    // A key of a disabled account answers like an unknown key, whether the
    // account is a person or a space: switching an account off has to stop its
    // agents too, not only its sessions or its members.
    const row = this.#db.get(
      `SELECT k.* FROM api_keys k JOIN users u ON u.id = k.owner
        WHERE k.key_hash = ? AND u.disabled_at IS NULL`,
      hashKey(secret),
    );
    if (!row) return null;

    const key = toKey(row);
    if (key.revoked) return null;

    // Past its date, and nothing about the answer says so. The refusal has to be
    // indistinguishable from the one an unknown key gets, down to `last_used_at`
    // staying put: a timestamp that moved would tell whoever presented the
    // string — the finder of an old config file, say — that they had a real key
    // rather than a wrong one, which is the difference between a dead end and a
    // reason to keep looking. Same rule as the scope refusals in `mcp/tools.ts`.
    if (key.expiresAt !== null && key.expiresAt <= now) return null;

    // One write per call is acceptable for an audit-relevant field, and "when was
    // this key last used" is the first question asked when one is suspected.
    this.#db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', now, key.id);
    return { ...key, lastUsedAt: now };
  }

  /**
   * Keys that are about to stop working, soonest first.
   *
   * The other half of an expiry, and the half that decides whether it is an
   * improvement: a key that dies overnight with nothing said beforehand is an
   * agent getting a 401 in the morning for no visible reason, which is the same
   * shape of failure as a history nobody could see. The daily sweep calls this
   * and the start-up log says it out loud; the admin view shows the date per
   * key, so the answer is in two places rather than in a log nobody tails.
   *
   * Only keys somebody can still do something about: a revoked key is already
   * dead, one that has expired is past helping, one with no deadline has
   * nothing to warn about, and a disabled account's keys stopped when the
   * account did.
   */
  expiringSoon(now = Date.now()): ApiKey[] {
    return this.#db
      .all(
        `SELECT k.* FROM api_keys k JOIN users u ON u.id = k.owner
          WHERE u.disabled_at IS NULL
            AND k.revoked_at IS NULL
            AND k.expires_at IS NOT NULL
            AND k.expires_at > ?
            AND k.expires_at <= ?
          ORDER BY k.expires_at, k.id`,
        now,
        now + EXPIRY_WARNING_DAYS * DAY_MS,
      )
      .map(toKey);
  }

  /** Soft revoke — the row stays so the access log keeps a readable name. */
  revoke(id: string): void {
    const key = this.get(id);
    if (key === undefined) throw new UnknownKeyError('no such key');
    this.#db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ?', Date.now(), id);
  }

  /** Records one line per tool call, allowed or not. */
  log(key: ApiKey, tool: string, path: string | null, allowed: boolean): void {
    try {
      this.#db.run(
        'INSERT INTO access_log (key_id, owner, tool, path, allowed, at) VALUES (?, ?, ?, ?, ?, ?)',
        key.id,
        key.owner,
        tool,
        path,
        allowed ? 1 : 0,
        Date.now(),
      );
    } catch {
      // Logging must never fail a call that was otherwise allowed.
    }
  }

  /**
   * How long a call stays in the access log.
   *
   * Ninety days, and the number is not a compromise between remembering and
   * forgetting: nothing can read past it. `recentAccess` asks for the newest
   * rows and `Queries.pulse` for a window, and the activity views above them
   * reach back a fortnight. A row older than this horizon has no query that
   * could name it.
   *
   * Why it needs a horizon at all: every MCP call takes a row, reads included,
   * because a read leaves no other trace anywhere. On the live instance that
   * had grown to 529 904 rows and 69.9 MB of a 71.9 MB database in two months —
   * the log was ninety-seven per cent of the file, and the nightly database
   * backup carried all of it.
   */
  static readonly LOG_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;

  /** Drops log rows past the horizon. Returns how many went. */
  purgeLog(now = Date.now()): number {
    const before = this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM access_log');
    this.#db.run('DELETE FROM access_log WHERE at < ?', now - ApiKeyService.LOG_HORIZON_MS);
    const after = this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM access_log');
    return Number(before?.n ?? 0) - Number(after?.n ?? 0);
  }

  recentAccess(owner: string, limit = 100): Array<{
    keyId: string;
    tool: string;
    path: string | null;
    allowed: boolean;
    at: number;
  }> {
    return this.#db
      .all(
        'SELECT key_id, tool, path, allowed, at FROM access_log WHERE owner = ? ORDER BY at DESC LIMIT ?',
        owner,
        Math.trunc(limit),
      )
      .map((row) => ({
        keyId: String(row['key_id']),
        tool: String(row['tool']),
        path: row['path'] === null || row['path'] === undefined ? null : String(row['path']),
        allowed: Number(row['allowed']) === 1,
        at: Number(row['at']),
      }));
  }
}

/**
 * True if `notePath` lies inside the key's scope.
 *
 * Case-sensitive on purpose: the vault refuses names that differ only in case, so
 * a case-insensitive comparison here would widen the scope for no benefit.
 */
export function withinScope(key: ApiKey, notePath: string): boolean {
  // A key's scope is always a folder or the whole vault; the rule itself is the
  // one every share goes through, not a second copy of it.
  return inScope({ prefix: key.scope, exact: false }, notePath);
}
