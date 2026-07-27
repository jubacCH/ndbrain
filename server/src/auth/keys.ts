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

import type { Database } from '../db/database.js';
import { NdbrainError } from '../errors.js';
import { normalizeVaultPath } from '../vault/paths.js';

export interface ApiKey {
  id: string;
  owner: string;
  name: string;
  /** Path prefix, `''` for the whole vault. Always ends in `/` when non-empty. */
  scope: string;
  canWrite: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
}

export class UnknownKeyError extends NdbrainError {}

/** Recognisable prefix, so a leaked key is greppable in logs and repos. */
const KEY_PREFIX = 'ndb_';

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
    revoked: row['revoked_at'] !== null && row['revoked_at'] !== undefined,
  };
}

export class ApiKeyService {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Returns the secret exactly once; only its hash is stored. */
  create(
    owner: string,
    name: string,
    options: { scope?: string; canWrite?: boolean } = {},
  ): { key: ApiKey; secret: string } {
    const secret = `${KEY_PREFIX}${randomBytes(32).toString('hex')}`;
    const id = `key_${randomBytes(8).toString('hex')}`;
    const scope = normalizeScope(options.scope ?? '');

    this.#db.run(
      `INSERT INTO api_keys (id, key_hash, owner, name, scope, can_write, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      id,
      hashKey(secret),
      owner,
      name,
      scope,
      options.canWrite === true ? 1 : 0,
      Date.now(),
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

  /** Resolves a presented secret. Returns null for unknown, revoked, or malformed keys. */
  resolve(secret: string, now = Date.now()): ApiKey | null {
    if (typeof secret !== 'string' || !secret.startsWith(KEY_PREFIX)) return null;

    const row = this.#db.get('SELECT * FROM api_keys WHERE key_hash = ?', hashKey(secret));
    if (!row) return null;

    const key = toKey(row);
    if (key.revoked) return null;

    // One write per call is acceptable for an audit-relevant field, and "when was
    // this key last used" is the first question asked when one is suspected.
    this.#db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', now, key.id);
    return { ...key, lastUsedAt: now };
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
  if (key.scope === '') return true;
  return notePath.startsWith(key.scope);
}
