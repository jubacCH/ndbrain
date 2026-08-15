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

import { ZodError } from 'zod';

import {
  CaseCollisionError,
  InvalidPathError,
  InvalidUserError,
  NotAFileError,
  NoteExistsError,
  NoteNotFoundError,
  UnlinkableNameError,
} from '../errors.js';
import { UnknownUserError, UserExistsError } from '../auth/users.js';

export interface HttpProblem {
  status: number;
  /** Machine-readable, stable across releases. Clients switch on this, not on the message. */
  code: string;
  message: string;
}

export function toProblem(error: unknown): HttpProblem {
  // A request body that does not match its schema. Reported with the offending
  // field named: "invalid request" tells a caller nothing it can act on, and the
  // field name is the caller's own text, so it discloses nothing of ours.
  if (error instanceof ZodError) {
    const first = error.issues[0];
    const where = first === undefined ? '' : first.path.join('.');
    const why = first?.message ?? 'did not match the expected shape';
    return {
      status: 400,
      code: 'invalid_body',
      message: where === '' ? why : `${where}: ${why}`,
    };
  }
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
  // Its own code, not `invalid_path`: the UI has to be able to say *why* the
  // name was refused, and "unsafe path" would be a lie about a name that is
  // perfectly safe and merely unreachable.
  if (error instanceof UnlinkableNameError) {
    return { status: 400, code: 'unlinkable_name', message: error.message };
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
