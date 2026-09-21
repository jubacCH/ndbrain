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

/**
 * A task toggle no longer matches the line it was addressed at.
 *
 * The task list identifies a task by path and line number, and either can go
 * stale between the list being loaded and the click — the note may have been
 * edited from another tab, by an agent, or by the watcher. Rather than tick
 * whatever is now on that line, the write is refused; see `markdown/tasks.ts`.
 */
export class TaskChangedError extends NdbrainError {}

/**
 * A note name was chosen that no `[[wikilink]]` could ever point at.
 *
 * Its own class rather than an `InvalidPathError`, because the path is not
 * invalid — the file would be perfectly legal. What is broken is the note's
 * reachability, and the message has to say so or the refusal looks arbitrary.
 */
export class UnlinkableNameError extends NdbrainError {}

/**
 * What a failure before the server is listening looks like on the console.
 *
 * Everything that can stop a start is something a person has to act on: a
 * migration refusing a database it must not silently half-convert, a port
 * already taken, a data directory it cannot write. Those errors carry their
 * instructions in the message, and the message is the whole of what helps — a
 * stack trace only buries it. Left as an unhandled rejection it arrived with
 * one, and a container restarting in a loop printed the pile again every
 * second, which is how a clear sentence becomes unreadable.
 */
export function startupMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return `ndbrain cannot start: ${text}`;
}

/**
  * A deleted note the caller may bring back, with nothing to bring it back from:
 * the host keeps no history, or no saved version holds the note. Only ever
 * raised after the caller's right to restore there has been established — to
 * anybody else the note does not exist.
 */
export class NothingToRestoreError extends NdbrainError {}
