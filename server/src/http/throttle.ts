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
 *
 * **Two budgets, because the address is a claim.** `trustProxy` is on, so the
 * address is whatever `X-Forwarded-For` says — it has to be, or everything
 * would look as if it came from the proxy and one person's mistakes would lock
 * out everybody. Behind Docker the real source is gone regardless: published
 * ports arrive from the bridge. So counting per address alone caps nobody who
 * picks a new one each time, and the hashing this exists to prevent happens
 * anyway.
 *
 * The second budget is per account and several times wider. It has to be wider:
 * an account name is something anybody can type, so a tight budget would hand a
 * stranger the power to shut somebody out of their own notes. Wide enough never
 * to meet a person mistyping a password, narrow enough that guessing stops.
 * A correct password is never refused by it — only failures are counted, and a
 * success clears them.
 */

export interface ThrottleOptions {
  /** Failures allowed from one address, for one account, inside the window. */
  limit?: number;
  /**
   * Failures allowed against one account from all addresses together.
   *
   * Several times `limit`, so that rotating addresses runs out while somebody
   * fumbling their own password never does.
   */
  accountLimit?: number;
  windowMs?: number;
  /** Cap on tracked keys, so a flood of distinct addresses cannot exhaust memory. */
  maxKeys?: number;
}

/**
 * The two key spaces, kept apart by construction.
 *
 * An account called `1.2.3.4|julian` must not be able to reach into the bucket
 * of that address and account, so the prefixes differ rather than relying on
 * account names never looking like a pair.
 */
function pairKey(address: string, account: string): string {
  return `a:${address}|${account}`;
}

function accountKey(account: string): string {
  return `u:${account}`;
}

interface Bucket {
  failures: number;
  resetAt: number;
}

export class LoginThrottle {
  readonly #limit: number;
  readonly #accountLimit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(options: ThrottleOptions = {}) {
    this.#limit = options.limit ?? 10;
    this.#accountLimit = options.accountLimit ?? 60;
    this.#windowMs = options.windowMs ?? 15 * 60 * 1000;
    this.#maxKeys = options.maxKeys ?? 10_000;
  }

  /**
   * Seconds the caller must wait, or 0 when an attempt is allowed.
   *
   * Both budgets are asked and the longer wait wins: an address that has spent
   * its own is blocked even while the account has room, and an account under
   * guessing is blocked even from an address that has never tried.
   */
  retryAfter(address: string, account: string, now = Date.now()): number {
    return Math.max(
      this.#waitOn(pairKey(address, account), this.#limit, now),
      this.#waitOn(accountKey(account), this.#accountLimit, now),
    );
  }

  recordFailure(address: string, account: string, now = Date.now()): void {
    this.#sweep(now);
    this.#fail(pairKey(address, account), now);
    this.#fail(accountKey(account), now);
  }

  /**
   * Clears what the attempt spent.
   *
   * Both budgets, and that is the point of the account one being clearable at
   * all: whoever knows the password empties it, so a stranger cannot hold
   * somebody out by spending it from elsewhere.
   */
  recordSuccess(address: string, account: string): void {
    this.#buckets.delete(pairKey(address, account));
    this.#buckets.delete(accountKey(account));
  }

  #waitOn(key: string, limit: number, now: number): number {
    const bucket = this.#buckets.get(key);
    if (bucket === undefined) return 0;
    if (bucket.resetAt <= now) {
      this.#buckets.delete(key);
      return 0;
    }
    if (bucket.failures < limit) return 0;
    return Math.ceil((bucket.resetAt - now) / 1000);
  }

  #fail(key: string, now: number): void {
    const bucket = this.#buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      this.#buckets.set(key, { failures: 1, resetAt: now + this.#windowMs });
      return;
    }
    bucket.failures += 1;
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
