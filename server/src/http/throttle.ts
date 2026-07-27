/**
 * Login throttling.
 *
 * A self-hosted service reachable from the internet gets credential-stuffed
 * whether or not anybody has heard of it — the scanners do not discriminate.
 * scrypt already makes each attempt expensive for the attacker, but it makes it
 * equally expensive for the server: 64 MiB and real CPU per try is itself a way
 * to take a 1 GiB container down. So attempts are capped before hashing happens.
 *
 * Deliberately in memory, not in the database. A restart clearing the counters is
 * an acceptable weakness for a single-process service, and it keeps a hostile
 * client from filling the disk with rows.
 */

export interface ThrottleOptions {
  /** Attempts allowed inside the window before the key is blocked. */
  limit?: number;
  windowMs?: number;
  /** Cap on tracked keys, so a flood of distinct addresses cannot exhaust memory. */
  maxKeys?: number;
}

interface Bucket {
  failures: number;
  resetAt: number;
}

export class LoginThrottle {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(options: ThrottleOptions = {}) {
    this.#limit = options.limit ?? 10;
    this.#windowMs = options.windowMs ?? 15 * 60 * 1000;
    this.#maxKeys = options.maxKeys ?? 10_000;
  }

  /** Seconds the caller must wait, or 0 when an attempt is allowed. */
  retryAfter(key: string, now = Date.now()): number {
    const bucket = this.#buckets.get(key);
    if (bucket === undefined) return 0;
    if (bucket.resetAt <= now) {
      this.#buckets.delete(key);
      return 0;
    }
    if (bucket.failures < this.#limit) return 0;
    return Math.ceil((bucket.resetAt - now) / 1000);
  }

  recordFailure(key: string, now = Date.now()): void {
    this.#sweep(now);

    const bucket = this.#buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      this.#buckets.set(key, { failures: 1, resetAt: now + this.#windowMs });
      return;
    }
    bucket.failures += 1;
  }

  recordSuccess(key: string): void {
    this.#buckets.delete(key);
  }

  #sweep(now: number): void {
    if (this.#buckets.size < this.#maxKeys) return;
    for (const [key, bucket] of this.#buckets) {
      if (bucket.resetAt <= now) this.#buckets.delete(key);
    }
    // Still full of live entries: drop the oldest rather than grow without bound.
    if (this.#buckets.size >= this.#maxKeys) {
      const oldest = this.#buckets.keys().next();
      if (!oldest.done) this.#buckets.delete(oldest.value);
    }
  }
}
