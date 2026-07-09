/** Domain errors for note mutations, mapped to HTTP status codes by the error handler. */

/** Thrown when a mutation targets a note that does not exist (e.g. move/remove source). */
export class NoteNotFoundError extends Error {}

/** Thrown when a move would overwrite an existing target note. */
export class NoteExistsError extends Error {}
