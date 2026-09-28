/**
 * Text changes as Yjs operations, and merging a stale writer into live text.
 *
 * Pure: no I/O and no room state, so every rule about bytes can be tested with
 * nothing but strings.
 *
 * `fast-diff` works in UTF-16 code units, which is also what `Y.Text` counts
 * in, so an index from one is an index in the other. It keeps surrogate pairs
 * together, which is what the astral-character cases in the tests pin.
 */

import diff from 'fast-diff';
import { diff3Merge } from 'node-diff3';
import type * as Y from 'yjs';

/**
 * Applies the smallest set of inserts and deletes that turns `from` into `to`.
 *
 * Several small operations rather than one replacement of the changed middle:
 * a remote cursor sitting between two edited places stays where it was, and a
 * concurrent insert elsewhere merges instead of being overwritten.
 *
 * Must run inside a transaction, and `text` must hold exactly `from`.
 */
export function applyTextChange(text: Y.Text, from: string, to: string): number | null {
  if (from === to) return null;

  let index = 0;
  let last: number | null = null;
  for (const [op, chunk] of diff(from, to)) {
    if (op === diff.EQUAL) {
      index += chunk.length;
    } else if (op === diff.DELETE) {
      text.delete(index, chunk.length);
      last = index;
    } else {
      text.insert(index, chunk);
      index += chunk.length;
      last = index;
    }
  }
  return last;
}

/** Lines with their line endings kept, so joining gives back the exact text. */
function lines(text: string): string[] {
  return text === '' ? [] : text.split(/(?<=\n)/);
}

/**
 * Merges what a stale writer changed (base → incoming) into the live text.
 *
 * Line-based diff3. The same change made on both sides is one change, not two;
 * a block both sides changed differently keeps the live side, because that is
 * what everybody in the room is looking at, and reports `clean: false` so the
 * caller can keep the incoming text as a conflict copy.
 */
export function threeWay(base: string, incoming: string, live: string): { text: string; clean: boolean } {
  if (incoming === base || incoming === live) return { text: live, clean: true };
  if (live === base) return { text: incoming, clean: true };

  let clean = true;
  const out: string[] = [];
  for (const block of diff3Merge(lines(incoming), lines(base), lines(live))) {
    if ('ok' in block && block.ok !== undefined) {
      out.push(...block.ok);
    } else if ('conflict' in block && block.conflict !== undefined) {
      clean = false;
      out.push(...block.conflict.b);
    }
  }
  return { text: out.join(''), clean };
}
