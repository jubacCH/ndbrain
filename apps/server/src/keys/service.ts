import { createHash, randomBytes } from "node:crypto";
import type { Database } from "../db/database.js";
import type { Scope } from "./scope.js";

/** Thrown when a key name contains characters unsafe for git --author interpolation. */
export class InvalidKeyNameError extends Error {}

/** Thrown when a key name is already in use. */
export class DuplicateKeyNameError extends Error {}

/** Key names double as the git commit author (see VaultGit), so the same pattern applies. */
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface ApiKeyListEntry {
  id: number;
  name: string;
  namespace: string;
  canWrite: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface ValidateResult {
  keyId: number;
  name: string;
  scope: Scope;
}

interface ApiKeyRow {
  id: number;
  name: string;
  key_hash: string;
  namespace: string;
  can_write: number;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

/**
 * Manages the lifecycle of agent API keys: creation, validation and revocation.
 *
 * KEY DESIGN DECISION: keys are looked up by sha256(key), not argon2. Password hashes
 * (argon2) are deliberately slow and non-indexable, which is right for low-entropy
 * human-chosen secrets but wrong here: API keys are 256-bit high-entropy random values
 * (`ndb_<64 hex>` = 32 random bytes), so brute-forcing the hash is infeasible regardless
 * of hash speed. Storing sha256(key) in an indexed column lets validate() do a direct
 * `WHERE key_hash = ?` lookup (O(1)) instead of loading every row to run argon2.verify
 * against each one.
 */
export class ApiKeyService {
  constructor(private db: Database) {}

  async create(name: string, namespace: string, canWrite: boolean, expiresAt?: string): Promise<string> {
    if (!NAME_PATTERN.test(name)) {
      throw new InvalidKeyNameError(`invalid key name: ${name}`);
    }
    const existing = this.db.prepare("SELECT 1 FROM api_keys WHERE name = ?").get(name);
    if (existing) {
      throw new DuplicateKeyNameError(`key name already exists: ${name}`);
    }

    // Normalize a non-empty namespace to always end with "/". isPathInScope does a plain
    // string-prefix match, so a bare "myai" would also match sibling paths like
    // "myaixyz.md" — a scope escape. An empty namespace means "whole vault" and stays
    // empty. Normalizing here (rather than trusting callers) closes the footgun at the
    // one place every key is created.
    const normalizedNamespace = namespace !== "" && !namespace.endsWith("/") ? `${namespace}/` : namespace;

    const key = `ndb_${randomBytes(32).toString("hex")}`;
    const keyHash = hash(key);

    // Normalize expiresAt to UTC ISO string for timezone-robust comparison in validate().
    const normalizedExpiresAt = expiresAt ? new Date(expiresAt).toISOString() : null;

    try {
      this.db
        .prepare(
          "INSERT INTO api_keys (name, key_hash, namespace, can_write, expires_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(name, keyHash, normalizedNamespace, canWrite ? 1 : 0, normalizedExpiresAt);
    } catch (error) {
      // Map UNIQUE constraint violation to DuplicateKeyNameError for consistent caller handling.
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw new DuplicateKeyNameError(`key name already exists: ${name}`);
      }
      throw error;
    }

    return key;
  }

  async validate(presentedKey: string): Promise<ValidateResult | null> {
    const keyHash = hash(presentedKey);
    const row = this.db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(keyHash) as
      | ApiKeyRow
      | undefined;
    if (!row) return null;
    if (row.revoked_at !== null) return null;
    if (row.expires_at !== null && new Date(row.expires_at).getTime() <= Date.now()) {
      return null;
    }

    this.db
      .prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?")
      .run(row.id);

    return {
      keyId: row.id,
      name: row.name,
      scope: { namespace: row.namespace, canWrite: row.can_write === 1 },
    };
  }

  /** Lists non-revoked keys only. Revoked rows are hard-hidden here (matching the old
   *  hard-delete behavior for this call) but deliberately survive in the table itself —
   *  see `revoke()` — so `access_log.key_id` stays resolvable and the name stays blamed. */
  list(): ApiKeyListEntry[] {
    const rows = this.db
      .prepare(
        "SELECT id, name, namespace, can_write, created_at, expires_at, last_used_at FROM api_keys WHERE revoked_at IS NULL ORDER BY id",
      )
      .all() as Omit<ApiKeyRow, "key_hash" | "revoked_at">[];

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      namespace: row.namespace,
      canWrite: row.can_write === 1,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
    }));
  }

  /**
   * Soft-revoke: stamps `revoked_at` instead of deleting the row. A hard DELETE would
   * dangle `access_log.key_id` (the audit trail would point at nothing, and the key
   * name — used as the git commit author, see VaultGit — would become unresolvable),
   * and would free the UNIQUE(name) slot for reuse, letting a new key inherit an old
   * key's blame. The UNIQUE constraint deliberately keeps a revoked name unavailable.
   *
   * Returns true only if a currently-active (non-revoked) key with this name existed.
   */
  revoke(name: string): boolean {
    const result = this.db
      .prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE name = ? AND revoked_at IS NULL")
      .run(name);
    return result.changes > 0;
  }
}

function hash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
