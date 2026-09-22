/**
 * Matching a path prefix in SQL, counted the way SQLite counts.
 *
 * Five places asked `substr(column, 1, ?) = ?` and passed `prefix.length` as
 * the count. That is wrong for any prefix holding a character outside the
 * basic plane — an emoji in a folder name, which `normalizeVaultPath` allows —
 * because SQLite's `substr` counts characters while JavaScript's `length`
 * counts UTF-16 code units, and the two differ by one per such character. The
 * query then asks for more characters than the prefix has and matches nothing.
 *
 * What that cost depended on the caller, and not all of it was harmless:
 * a folder share stopped being carried along by a move, and stopped being
 * removed by a delete. The second one leaves a share pointing at a path that
 * no longer exists, and a later folder of the same name inherits it.
 *
 * `substr` rather than `LIKE`, because `LIKE` folds ASCII case in SQLite and
 * paths here are case-sensitive. It exists as one function so that the count
 * and the string cannot be passed separately, which is how they drifted apart.
 */

import type { SqlValue } from './database.js';

/** `<column>` begins with `prefix`, as a condition and its two parameters. */
export function prefixSql(column: string, prefix: string): { sql: string; params: SqlValue[] } {
  return { sql: `substr(${column}, 1, ?) = ?`, params: [[...prefix].length, prefix] };
}

/** The count `substr` needs for `prefix`: characters, not code units. */
export function prefixLength(prefix: string): number {
  return [...prefix].length;
}
