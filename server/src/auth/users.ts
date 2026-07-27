/**
 * Accounts and sessions.
 *
 * There is no self-registration. A self-hosted service reachable from the
 * internet with an open sign-up form collects strangers' data on the owner's
 * disk; an administrator creates accounts instead. That is a deliberate
 * restriction, not a missing feature.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Database } from '../db/database.js';
import { NdbrainError } from '../errors.js';
import { hashPassword, verifyPassword } from './password.js';
import { assertUserId } from '../vault/paths.js';
import type { Vault } from '../vault/fs.js';

export type Role = 'admin' | 'user';

export interface User {
  id: string;
  displayName: string;
  role: Role;
  createdAt: number;
  disabled: boolean;
}

export interface Session {
  userId: string;
  expiresAt: number;
}

export class UserExistsError extends NdbrainError {}
export class UnknownUserError extends NdbrainError {}

/** Thirty days. Long enough not to be annoying on a personal tool, short enough to expire. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Renew rather than rewrite on every request — one write per day per session is plenty. */
const TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function toUser(row: Record<string, unknown>): User {
  return {
    id: String(row['id']),
    displayName: String(row['display_name']),
    role: String(row['role']) === 'admin' ? 'admin' : 'user',
    createdAt: Number(row['created_at']),
    disabled: row['disabled_at'] !== null && row['disabled_at'] !== undefined,
  };
}

export class UserService {
  readonly #db: Database;
  readonly #vault: Vault;

  constructor(db: Database, vault: Vault) {
    this.#db = db;
    this.#vault = vault;
  }

  count(): number {
    const row = this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
    return Number(row?.n ?? 0);
  }

  list(): User[] {
    return this.#db.all('SELECT * FROM users ORDER BY id').map(toUser);
  }

  get(id: string): User | undefined {
    const row = this.#db.get('SELECT * FROM users WHERE id = ?', id);
    return row ? toUser(row) : undefined;
  }

  /** Creates an account and its vault directory. */
  async create(
    id: string,
    password: string,
    options: { displayName?: string; role?: Role } = {},
  ): Promise<User> {
    // The id becomes a directory name, so it goes through the same validation the
    // vault layer applies — otherwise an account name is a traversal vector.
    assertUserId(id);

    if (this.get(id) !== undefined) {
      throw new UserExistsError('a user with that name already exists');
    }

    const hash = await hashPassword(password);
    this.#db.run(
      `INSERT INTO users (id, display_name, password_hash, role, created_at, disabled_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      id,
      options.displayName ?? id,
      hash,
      options.role ?? 'user',
      Date.now(),
    );

    await this.#vault.ensureVault(id);

    const created = this.get(id);
    if (created === undefined) throw new NdbrainError('user vanished immediately after creation');
    return created;
  }

  async setPassword(id: string, password: string): Promise<void> {
    if (this.get(id) === undefined) throw new UnknownUserError('no such user');
    this.#db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password), id);
    // Changing a password ends every session: that is the whole point of doing it
    // after a suspected compromise.
    this.#db.run('DELETE FROM sessions WHERE user_id = ?', id);
  }

  setDisabled(id: string, disabled: boolean): void {
    if (this.get(id) === undefined) throw new UnknownUserError('no such user');
    this.#db.run('UPDATE users SET disabled_at = ? WHERE id = ?', disabled ? Date.now() : null, id);
    if (disabled) this.#db.run('DELETE FROM sessions WHERE user_id = ?', id);
  }

  /**
   * Verifies credentials.
   *
   * Always runs a hash comparison, even when the user does not exist, so that the
   * response time does not reveal which account names are real.
   */
  async authenticate(id: string, password: string): Promise<User | null> {
    const row = this.#db.get('SELECT * FROM users WHERE id = ?', id);
    const storedHash = row ? String(row['password_hash']) : DUMMY_HASH;

    const ok = await verifyPassword(password, storedHash);
    if (!row || !ok) return null;

    const user = toUser(row);
    return user.disabled ? null : user;
  }
}

/**
 * A real hash of a value nobody knows, used to keep the timing of a failed login
 * against a non-existent account the same as against a real one.
 */
const DUMMY_HASH =
  'scrypt$65536$8$2$AAAAAAAAAAAAAAAAAAAAAA==$' +
  'ZG8gbm90IG1hdGNoIGFueXRoaW5nIGF0IGFsbCEhIQ==';

export class SessionService {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Returns the raw token; only its hash is stored. */
  create(userId: string, now = Date.now()): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + SESSION_TTL_MS;

    this.#db.run(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
      tokenHash(token),
      userId,
      now,
      expiresAt,
      now,
    );

    return { token, expiresAt };
  }

  /** Resolves a cookie value to a session, or null if it is unknown or expired. */
  resolve(token: string, now = Date.now()): Session | null {
    if (typeof token !== 'string' || token.length === 0) return null;

    const row = this.#db.get(
      'SELECT user_id, expires_at, last_seen_at FROM sessions WHERE token_hash = ?',
      tokenHash(token),
    );
    if (!row) return null;

    const expiresAt = Number(row['expires_at']);
    if (expiresAt <= now) {
      this.#db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash(token));
      return null;
    }

    if (now - Number(row['last_seen_at']) > TOUCH_INTERVAL_MS) {
      this.#db.run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', now, tokenHash(token));
    }

    return { userId: String(row['user_id']), expiresAt };
  }

  destroy(token: string): void {
    this.#db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash(token));
  }

  destroyAllFor(userId: string): void {
    this.#db.run('DELETE FROM sessions WHERE user_id = ?', userId);
  }

  /** Drops expired rows. Called on start and periodically. */
  purgeExpired(now = Date.now()): number {
    const before = this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions');
    this.#db.run('DELETE FROM sessions WHERE expires_at <= ?', now);
    const after = this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions');
    return Number(before?.n ?? 0) - Number(after?.n ?? 0);
  }
}

/** Compares two secrets without leaking their relationship through timing. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
