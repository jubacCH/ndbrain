/** Domain errors for note mutations, mapped to HTTP status codes by the error handler. */

/** Thrown when a mutation targets a note that does not exist (e.g. move/remove source). */
export class NoteNotFoundError extends Error {}

/** Thrown when a move would overwrite an existing target note. */
export class NoteExistsError extends Error {}

/** Thrown when a mutation (`move`/`remove`) targets a note that is currently open in a
 *  live collaboration doc. Deleting/moving the on-disk file while a doc is still live
 *  under the old path would let the doc's own debounced store write the file straight
 *  back afterwards (undoing the delete, or leaving the note under both the old and new
 *  path after a move) and would desync the search index. Callers should retry once the
 *  note is no longer being edited live. */
export class NoteBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteBusyError";
  }
}

/** Thrown when editNote's `find` string does not occur in the note. */
export class EditTargetNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditTargetNotFoundError";
  }
}

/** Thrown when editNote's `find` string occurs more than once in the note. */
export class EditAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditAmbiguousError";
  }
}
