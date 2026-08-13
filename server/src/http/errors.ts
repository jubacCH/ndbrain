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

  const malformed = asBadRequest(error);
  if (malformed !== null) return malformed;

  return { status: 500, code: 'internal', message: 'internal error' };
}

/**
 * Fastify's own request-level complaints: unparseable JSON, a JSON content type
 * with an empty body, a payload over the limit.
 *
 * They already carry a 4xx of their own, and they are about the request rather
 * than about this server. Letting them fall through to the 500 below said "we
 * broke" when the client did, logged every one of them as an unhandled error,
 * and threw away the one sentence that says how to fix the call.
 *
 * Rule 1 above still holds: only errors the framework raises *about the request*
 * are passed on, and their messages describe the request rather than anything
 * behind it. Anything else keeps collapsing to a bare 500.
 */
function asBadRequest(error: unknown): HttpProblem | null {
  if (typeof error !== 'object' || error === null) return null;

  const candidate = error as { code?: unknown; statusCode?: unknown; message?: unknown };
  if (typeof candidate.code !== 'string' || !candidate.code.startsWith('FST_')) return null;
  if (typeof candidate.statusCode !== 'number') return null;
  if (candidate.statusCode < 400 || candidate.statusCode >= 500) return null;

  return {
    status: candidate.statusCode,
    // One stable code for the whole class. The status carries the nuance; a
    // client that needs more can read the message, and a client that switches on
    // the code should not have to learn Fastify's internal names.
    code: 'bad_request',
    message: typeof candidate.message === 'string' ? candidate.message : 'malformed request',
  };
}

/** True when the error is one we deliberately expose; anything else must be logged. */
export function isExpected(error: unknown): boolean {
  return toProblem(error).status !== 500;
}
