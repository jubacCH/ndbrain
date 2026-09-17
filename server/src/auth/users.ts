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
import { InvalidUserError, NdbrainError } from '../errors.js';
import { hashPassword, verifyPassword } from './password.js';
import { assertUserId } from '../vault/paths.js';
import type { Vault } from '../vault/fs.js';

export type Role = 'admin' | 'user';

/**
 * A person signs in; a space is a shared vault nobody signs in to.
 *
 * Both are rows in the same table because both own a vault, and one table is
 * what gives them one namespace: the account id is the vault's directory name,
 * so a space and a person of the same name would be the same folder.
 */
export type AccountKind = 'person' | 'space';

export interface User {
  id: string;
  displayName: string;
  role: Role;
  kind: AccountKind;
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
    // Anything but an explicit person is treated as a space: the kind that can
    // do less is the safe reading of a value this build does not recognise.
    kind: String(row['kind'] ?? 'person') === 'person' ? 'person' : 'space',
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

  /**
   * Refuses a name another account already has in any letter case.
   *
   * The id is the vault's directory name, and on macOS and Windows `Julian`
   * and `julian` are the same directory: a space `Julian` beside the person
   * `julian` would hand its members julian's notes. Every lookup by id is exact
   * (no `NOCASE` anywhere), so the one place two spellings can meet is the
   * filesystem — and that is closed here, for people and spaces alike, from the
   * interface, the API and the command line, which all create through this
   * service. Ids that already exist stay as they are.
   */
  #assertNameFree(id: string): void {
    // `lower` folds ASCII only, which is all an id may contain (`assertUserId`).
    if (this.#db.get('SELECT id FROM users WHERE lower(id) = lower(?)', id) !== undefined) {
      throw new UserExistsError('a user with that name already exists');
    }
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

    this.#assertNameFree(id);

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

  /**
   * Creates a space: an account with a vault and no way to sign in.
   *
   * The same name rules and the same namespace as a person, because the id is
   * a vault directory either way. The stored password hash is not a hash at
   * all, so no password can ever match it — and `authenticate` does not even
   * try, see there.
   */
  async createSpace(id: string, displayName?: string): Promise<User> {
    assertUserId(id);

    this.#assertNameFree(id);

    const name = displayName === undefined ? id : checkedDisplayName(displayName);
    this.#db.run(
      `INSERT INTO users (id, display_name, password_hash, role, kind, created_at, disabled_at)
       VALUES (?, ?, '!space', 'user', 'space', ?, NULL)`,
      id,
      name,
      Date.now(),
    );

    await this.#vault.ensureVault(id);

    const created = this.get(id);
    if (created === undefined) throw new NdbrainError('space vanished immediately after creation');
    return created;
  }

  /**
   * Changes the name the interface calls somebody.
   *
   * Only ever a label — the account id stays what it was. That separation is the
   * point: the id is the vault's directory name and the key every share, session
   * and API key hangs off, so renaming *it* is a migration. Wanting to be called
   * "Julian" rather than "julian" is not.
   */
  setDisplayName(id: string, displayName: string): User {
    const name = checkedDisplayName(displayName);

    // Checked before the write rather than inferred from it: `run` reports
    // nothing about how many rows it touched, so an update against a missing id
    // would succeed silently and hand back a user that does not exist.
    if (this.get(id) === undefined) throw new UnknownUserError(`no such user: ${id}`);

    this.#db.run('UPDATE users SET display_name = ? WHERE id = ?', name, id);

    const user = this.get(id);
    if (user === undefined) throw new UnknownUserError(`no such user: ${id}`);
    return user;
  }

  async setPassword(id: string, password: string): Promise<void> {
    // A space has no password to set; giving it one would not let anybody in,
    // but it would make "spaces cannot sign in" depend on a check elsewhere.
    if (this.get(id)?.kind !== 'person') throw new UnknownUserError('no such user');
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
    const user = row ? toUser(row) : undefined;
    // A space is compared against the dummy hash, exactly like a name that does
    // not exist, and refused whatever came back: same work, same answer, so
    // the login form cannot be used to find out which names are spaces.
    const storedHash = user?.kind === 'person' ? String(row?.['password_hash']) : DUMMY_HASH;

    const ok = await verifyPassword(password, storedHash);
    if (user === undefined || user.kind !== 'person' || !ok) return null;

    return user.disabled ? null : user;
  }
}

/** Trims and checks a display name; the one rule for people and spaces. */
function checkedDisplayName(displayName: string): string {
  const name = displayName.trim();
  if (name === '' || name.length > 64) {
    throw new InvalidUserError('a display name is between 1 and 64 characters');
  }
  // Control characters would let a name break the layout it appears in.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(name)) {
    throw new InvalidUserError('a display name may not contain control characters');
  }
  return name;
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
