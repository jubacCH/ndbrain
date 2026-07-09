/** Domain errors for note mutations, mapped to HTTP status codes by the error handler. */

/** Thrown when a mutation targets a note that does not exist (e.g. move/remove source). */
export class NoteNotFoundError extends Error {}

/** Thrown when a move would overwrite an existing target note. */
export class NoteExistsError extends Error {}

/** Thrown when editNote's `find` string does not occur in the note. */
export class EditTargetNotFoundError extends Error {}

/** Thrown when editNote's `find` string occurs more than once in the note. */
export class EditAmbiguousError extends Error {}
