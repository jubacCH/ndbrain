/**
 * What `/api/v1/health` actually checks.
 *
 * The endpoint used to be `async () => ({ status: 'ok' })`, which answers one
 * question — is a Node process accepting connections — and lets every failure
 * this server can suffer through: a data directory that never got mounted, a
 * bind mount that came back read-only, a database file that cannot be read, an
 * index quietly drifting away from the vault. All four report themselves as
 * healthy to a supervisor and as "ndbrain is broken" to the person using it.
 *
 * **It answers before anybody has signed in.** That is the constraint every
 * verdict here is shaped by: the reply says whether the server works and
 * roughly what is wrong, and nothing else. No paths, no account names, no
 * counts, no timestamps — nothing an unauthenticated reader could measure a
 * vault with, and nothing that changes as notes are added. The verdicts are a
 * closed vocabulary of words for exactly that reason.
 */

import { access, constants } from 'node:fs/promises';
import path from 'node:path';

import type { UserService } from '../auth/users.js';
import type { Config } from '../config.js';
import type { Database } from '../db/database.js';
import type { ReconcileState } from '../index/watcher.js';
import type { History } from '../vault/history.js';

export interface HealthChecks {
  database: 'ok' | 'unreachable';
  vault: 'ok' | 'unwritable';
  history: 'ok' | 'unavailable';
  /** `unwatched`: reconciliation is configured, but nothing is running it. */
  reconcile: ReconcileState | 'unwatched';
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'failing';
  checks: HealthChecks;
}

export interface HealthDeps {
  db: Database;
  users: UserService;
  history: History;
  config: Config;
  /** The watcher, when one is running. Absent in the API-only configuration. */
  watcher?: { reconcileState(now?: number): ReconcileState };
}

/**
 * How long a history probe is reused.
 *
 * `History.available` spawns git. On an endpoint that needs no session, one
 * subprocess per request is a way to load the machine from the outside, and the
 * answer is a deployment property that does not change minute to minute.
 */
const HISTORY_TTL_MS = 60_000;

export class HealthProbe {
  readonly #deps: HealthDeps;
  #history: { at: number; value: HealthChecks['history'] } | null = null;

  constructor(deps: HealthDeps) {
    this.#deps = deps;
  }

  async check(now = Date.now()): Promise<HealthReport> {
    const database = this.#database();
    const vault = await this.#vault();
    const history = await this.#historyCached(now);
    const reconcile = this.#reconcile(now);

    // Failing means "do not send traffic here": the server cannot read its own
    // database or cannot write the vault, so every request that matters will
    // fail. Degraded is deliberately still a 200 — an index falling behind is
    // something the operator has to fix, but taking the server out of a load
    // balancer over it would turn a stale search result into an outage.
    const status =
      database !== 'ok' || vault !== 'ok'
        ? 'failing'
        : reconcile === 'stale' || reconcile === 'unwatched'
          ? 'degraded'
          : 'ok';

    return { status, checks: { database, vault, history, reconcile } };
  }

  /** The cheapest read there is: it proves the file opens and the page cache answers. */
  #database(): HealthChecks['database'] {
    try {
      this.#deps.db.get('SELECT 1 AS ok');
      return 'ok';
    } catch {
      return 'unreachable';
    }
  }

  /**
   * Whether notes could be written at all.
   *
   * Both bits matter: without `X_OK` the directory cannot be walked, and
   * without `W_OK` nothing can be saved into it. A missing directory fails the
   * same way on purpose — an unmounted volume and a read-only one are the same
   * problem to whoever has to fix it, and telling them apart would mean saying
   * which path was looked at.
   */
  async #vault(): Promise<HealthChecks['vault']> {
    try {
      await access(path.join(this.#deps.config.dataDir, 'vaults'), constants.W_OK | constants.X_OK);
      return 'ok';
    } catch {
      return 'unwritable';
    }
  }

  async #historyCached(now: number): Promise<HealthChecks['history']> {
    const cached = this.#history;
    if (cached !== null && now - cached.at < HISTORY_TTL_MS) return cached.value;

    const value = await this.#historyProbe();
    this.#history = { at: now, value };
    return value;
  }

  /**
   * Whether the sidecar repository answers for a vault that exists.
   *
   * Asked of one account rather than all of them: the question is whether the
   * host's history timer is set up at all, which is the same answer for every
   * vault, and asking once keeps this to a single subprocess.
   */
  async #historyProbe(): Promise<HealthChecks['history']> {
    try {
      const first = this.#deps.users.list()[0];
      if (first === undefined) return 'unavailable';
      return (await this.#deps.history.available(first.id)) ? 'ok' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  #reconcile(now: number): HealthChecks['reconcile'] {
    const watcher = this.#deps.watcher;
    if (watcher !== undefined) return watcher.reconcileState(now);
    return this.#deps.config.reconcileIntervalMs > 0 ? 'unwatched' : 'disabled';
  }
}
