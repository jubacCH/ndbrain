/**
 * Maps domain errors onto HTTP responses.
 *
 * Two rules the rest of the server depends on:
 *
 *  1. **Nothing unrecognised reaches the client.** An unexpected error becomes a
 *     bare 500 with a fixed message; its details go to the log. Stack traces and
 *     driver messages have a habit of naming paths and table structure.
 *  2. **"Not yours" is indistinguishable from "not there".** Because every vault
 *     call is owner-scoped, another user's note simply does not exist for this
 *     caller, and the 404 here is literally the same response. There is no 403
 *     for notes — a 403 would confirm the note exists.
 */

import {
  CaseCollisionError,
  InvalidPathError,
  InvalidUserError,
  NotAFileError,
  NoteExistsError,
  NoteNotFoundError,
} from '../errors.js';
import { UnknownUserError, UserExistsError } from '../auth/users.js';

export interface HttpProblem {
  status: number;
  /** Machine-readable, stable across releases. Clients switch on this, not on the message. */
  code: string;
  message: string;
}

export function toProblem(error: unknown): HttpProblem {
  if (error instanceof NoteNotFoundError) {
    return { status: 404, code: 'not_found', message: 'note does not exist' };
  }
  if (error instanceof NoteExistsError) {
    return { status: 409, code: 'exists', message: 'a note already exists at that path' };
  }
  if (error instanceof CaseCollisionError) {
    return { status: 409, code: 'case_collision', message: error.message };
  }
  if (error instanceof InvalidPathError || error instanceof NotAFileError) {
    return { status: 400, code: 'invalid_path', message: error.message };
  }
  if (error instanceof InvalidUserError) {
    return { status: 400, code: 'invalid_user', message: error.message };
  }
  if (error instanceof UserExistsError) {
    return { status: 409, code: 'user_exists', message: error.message };
  }
  if (error instanceof UnknownUserError) {
    return { status: 404, code: 'unknown_user', message: 'no such user' };
  }

  return { status: 500, code: 'internal', message: 'internal error' };
}

/** True when the error is one we deliberately expose; anything else must be logged. */
export function isExpected(error: unknown): boolean {
  return toProblem(error).status !== 500;
}
