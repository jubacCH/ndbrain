/**
 * Typed errors for the vault and note layers.
 *
 * Deliberate design: callers distinguish these by class, never by message text.
 * The HTTP layer (phase 2) maps them to status codes; nothing else is allowed to
 * leak an internal message to a client.
 */

export class NdbrainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A path was rejected before it ever reached the filesystem: traversal, an
 * absolute path, a backslash, a NUL byte, a reserved device name, or a target
 * that resolves outside the owner's vault.
 *
 * Cross-tenant access lands here too. That is intentional — see NoteNotFoundError.
 */
export class InvalidPathError extends NdbrainError {}

/** The user id itself was malformed, so no vault root could be derived from it. */
export class InvalidUserError extends NdbrainError {}

/**
 * The note does not exist *for this owner*.
 *
 * A note owned by somebody else must produce exactly this error, never a
 * "forbidden" of any kind: the difference between "does not exist" and "exists
 * but is not yours" is itself information about another user's vault.
 */
export class NoteNotFoundError extends NdbrainError {}

/** A note already exists at that path. */
export class NoteExistsError extends NdbrainError {}

/**
 * A different note already exists whose path differs only in letter case.
 *
 * Linux keeps `Homelab.md` and `homelab.md` apart; Windows and macOS fold them
 * together. Allowing both to exist server-side means a vault that silently loses
 * a file the moment it is mounted or synced from either of those systems, so the
 * write is refused instead of repaired.
 */
export class CaseCollisionError extends NdbrainError {}

/** The path pointed at a directory where a note was expected, or vice versa. */
export class NotAFileError extends NdbrainError {}
