/**
 * Thin wrapper around the SQLite driver.
 *
 * We use Node's built-in `node:sqlite` rather than `better-sqlite3`. The reason is
 * install friction, and it is a product decision, not a taste one: better-sqlite3
 * ships no prebuilt binary for current Node and falls back to compiling with
 * node-gyp. That fails on any machine without a C++ toolchain — which, for a tool
 * meant to be self-hosted by strangers, is a support burden on every platform we
 * do not test. The built-in driver works wherever Node works.
 *
 * The cost is that `node:sqlite` is still flagged experimental, so its API may
 * change. That is why everything goes through this file: the surface we depend on
 * is a handful of methods, and swapping the driver later means rewriting one
 * module rather than every query.
 *
 * The experimental warning is silenced by the runner (`--disable-warning`), not
 * here — users should not see it, and we should not hide it from ourselves while
 * developing.
 */

import { DatabaseSync } from 'node:sqlite';

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface Row {
  [column: string]: SqlValue;
}

export class Database {
  readonly #db: DatabaseSync;

  constructor(location: string) {
    this.#db = new DatabaseSync(location);

    // WAL lets the watcher read while a write is in flight. NORMAL synchronous is
    // the usual companion: a crash can lose the last transaction, and since the
    // index is a rebuildable cache, that is an acceptable trade for the speed.
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  run(sql: string, ...params: SqlValue[]): void {
    this.#db.prepare(sql).run(...params);
  }

  get<T extends Row = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.#db.prepare(sql).get(...params) as T | undefined;
  }

  all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.#db.prepare(sql).all(...params) as T[];
  }

  /**
   * Runs `fn` inside a transaction.
   *
   * Indexing a note touches four tables; a half-applied update would leave the
   * index disagreeing with the file, which is worse than not indexing at all.
   */
  transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  get userVersion(): number {
    const row = this.get<{ user_version: number }>('PRAGMA user_version');
    return Number(row?.user_version ?? 0);
  }

  set userVersion(version: number) {
    // PRAGMA does not accept bound parameters, hence the interpolation; the value
    // is an integer we control, never user input.
    this.#db.exec(`PRAGMA user_version = ${Math.trunc(version)}`);
  }

  close(): void {
    this.#db.close();
  }
}
