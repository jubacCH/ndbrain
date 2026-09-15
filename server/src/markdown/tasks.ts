/**
 * Flipping one task's checkbox, and nothing else in the file.
 *
 * The task list addresses a task by path and **line number**, and a line number
 * goes stale the moment the note changes underneath it — from another tab, from
 * an agent over MCP, from a watcher picking up an external edit. Writing
 * blindly at that line would tick the wrong box or, worse, splice a checkbox
 * character into the middle of an unrelated sentence.
 *
 * `toggleTask` refuses instead of guessing: it re-parses the note fresh and
 * checks that the line still holds the exact task — same text, same done state
 * — the caller last saw. Only then does it touch the file, and even then it
 * changes a single character. Everything else, byte for byte, stays as it was.
 * This is the same posture `edit_note` already takes for MCP edits: verify the
 * target, or refuse rather than risk the wrong line.
 */

import { parseNote } from './parse.js';

/**
 * Matches a task line in three pieces: everything up to and including the
 * opening `[`, the checkbox character itself, and everything from the closing
 * `]` onward. Reconstructing the line from these three groups with only the
 * middle one changed is what keeps the rest of the line — indentation, list
 * marker, trailing text — byte-identical.
 *
 * Deliberately a second regex rather than reusing `TASK_RE` from `parse.ts`:
 * that one captures the checkbox state and the trimmed text for indexing, not
 * the byte offsets a safe rewrite needs.
 */
const TASK_TOGGLE_RE = /^([ \t]*[-*+][ \t]+\[)([ xX])(\][ \t]+.*)$/;

export interface TaskExpectation {
  done: boolean;
  text: string;
}

export type ToggleTaskResult =
  | { ok: true; content: string }
  | {
      ok: false;
      /** Why the write was refused — always because the line no longer matches. */
      reason: 'changed';
    };

/**
 * Sets one task's done state by file-relative line number, verified against
 * the task the caller expects to still be there.
 *
 * The verification re-parses `content` with the exact same parser that
 * produced the list in the first place, rather than re-deriving line numbers
 * or masking rules independently — two implementations of "what counts as a
 * task on this line" would drift, and the drift is exactly the bug this
 * function exists to prevent. `parseNote`'s line numbers are already
 * file-relative and frontmatter-inclusive, which is what makes matching by
 * `line` alone safe here.
 *
 * Returns the unmodified content, still `ok: true`, when the task is already
 * in the requested state — toggling twice from two tabs must not turn into two
 * conflicting writes of the same outcome.
 */
export function toggleTask(
  content: string,
  line: number,
  expected: TaskExpectation,
  done: boolean,
): ToggleTaskResult {
  const current = parseNote(content).tasks.find((task) => task.line === line);
  if (current === undefined || current.done !== expected.done || current.text !== expected.text) {
    return { ok: false, reason: 'changed' };
  }

  if (current.done === done) return { ok: true, content };

  const lines = content.split('\n');
  const raw = lines[line - 1];
  // Cannot happen once `current` was found above — `parseNote` only ever
  // reports lines that exist — but a raw index is still an index, not a proof.
  if (raw === undefined) return { ok: false, reason: 'changed' };

  const hasCR = raw.endsWith('\r');
  const body = hasCR ? raw.slice(0, -1) : raw;
  const match = TASK_TOGGLE_RE.exec(body);
  if (match === null) return { ok: false, reason: 'changed' };

  const rewritten = `${match[1]}${done ? 'x' : ' '}${match[3]}`;
  lines[line - 1] = hasCR ? `${rewritten}\r` : rewritten;

  return { ok: true, content: lines.join('\n') };
}
