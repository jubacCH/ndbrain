/**
 * The login brake, and the address it cannot believe.
 *
 * Attempts are counted per `${request.ip}|${account}`. Behind a reverse proxy
 * `request.ip` is whatever `X-Forwarded-For` says, because `trustProxy` is on —
 * and it has to be, or every request would look like it came from the proxy and
 * one person's failures would lock out everybody else.
 *
 * The consequence is that the address is a claim, not a fact. Anybody who can
 * reach the port directly picks a new one per attempt and gets a fresh bucket
 * every time, so the brake never closes. That matters more than it sounds:
 * `authenticate` runs scrypt at 64 MiB, and the container it runs in has one
 * gigabyte. Unlimited attempts are not only unlimited guesses, they are a way
 * to push the process into swap from outside.
 *
 * Docker is why the address cannot simply be pinned to the proxy: published
 * ports arrive from the bridge, so from inside the container the real source is
 * gone either way. The brake therefore stops relying on the address alone.
 *
 * The second budget is per account and deliberately much larger than the first.
 * It has to be: an account is a name anybody can type, so a tight budget would
 * let a stranger lock somebody out of their own notes. Wide enough to never
 * meet a person who mistypes a password, narrow enough that guessing stops.
 */

import { Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LoginThrottle } from '../src/http/throttle.js';
import { startHarness, type Harness } from './support/harness.js';

let h: Harness;

/**
 * Small budgets, so the test spends seconds rather than minutes.
 *
 * Every failed attempt that gets past the brake runs scrypt at 64 MiB — which
 * is the whole reason the brake matters, and the reason a test may not make
 * eighty of them. The numbers are scaled, the behaviour is not: the second
 * budget is several times the first, exactly as in production.
 */
const SMALL = { limit: 2, accountLimit: 4 };

/**
 * Longer than vitest's default, because these attempts are real ones.
 *
 * Each failure that reaches the password check runs scrypt at 64 MiB, which is
 * the cost this whole file exists to bound. Under a loaded machine a handful of
 * them passes five seconds, and the test would report a flake where the code is
 * fine. The budgets above are kept as small as the behaviour allows for the
 * same reason: the account budget still has to be the wider of the two.
 */
const SLOW = 30_000;

beforeEach(async () => {
  h = await startHarness('throttle', {}, { throttle: new LoginThrottle(SMALL) });
  await h.runtime.users.create('julian', 'ein gutes passwort');
});

afterEach(async () => {
  await h.close();
});

/** One login attempt, claiming to come from `from`. */
async function attempt(user: string, password: string, from: string) {
  return h.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': from },
    payload: { user, password },
  });
}

/** A fresh address for every call, the way somebody rotating them would. */
function addresses(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `203.0.113.${i % 254}`);
}

describe('guessing from one address', () => {
  it('is stopped once its budget is spent', async () => {
    const from = '203.0.113.7';
    for (let i = 0; i < SMALL.limit; i += 1) {
      expect((await attempt('julian', 'falsch', from)).statusCode).toBe(401);
    }

    const blocked = await attempt('julian', 'falsch', from);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  }, SLOW);

  it('lets the right password through again once it succeeds', async () => {
    const from = '203.0.113.8';
    await attempt('julian', 'falsch', from);
    expect((await attempt('julian', 'ein gutes passwort', from)).statusCode).toBe(200);

    // The bucket is cleared by the success, so the next mistype starts over.
    for (let i = 0; i < SMALL.limit; i += 1) {
      expect((await attempt('julian', 'falsch', from)).statusCode).toBe(401);
    }
    expect((await attempt('julian', 'falsch', from)).statusCode).toBe(429);
  }, SLOW);
});

describe('guessing from a new address every time', () => {
  it('is stopped as well, because the account has its own budget', async () => {
    // Every attempt claims an address nobody has used before, so the per-address
    // bucket is empty at each one. Without a second budget this loop would run
    // as long as somebody cares to run it.
    const seen = new Set<number>();
    for (const from of addresses(SMALL.accountLimit + 2)) {
      seen.add((await attempt('julian', 'falsch', from)).statusCode);
    }

    expect(seen).toContain(429);
  }, SLOW);

  it('leaves a line in the log, because nobody else would see it', async () => {
    // The reply says "later" and nothing more, on purpose. That leaves nobody
    // able to tell a locked-out account from a forgotten password — unless the
    // server says so on its own, which is what this checks.
    const said: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        said.push(String(chunk));
        done();
      },
    });

    const own = await startHarness('throttle-log', {}, {
      throttle: new LoginThrottle(SMALL),
      logStream: sink,
    });
    try {
      await own.runtime.users.create('julian', 'ein gutes passwort');
      const from = '203.0.113.9';
      const tryOnce = () =>
        own.server.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { 'x-forwarded-for': from },
          payload: { user: 'julian', password: 'falsch' },
        });

      for (let i = 0; i < SMALL.limit; i += 1) await tryOnce();
      expect((await tryOnce()).statusCode).toBe(429);

      const refusal = said.find((line) => line.includes('login refused'));
      expect(refusal).toBeDefined();
      // The account is named, so an operator knows who is shut out. The
      // password is not, and must never be.
      expect(refusal).toContain('"account":"julian"');
      expect(said.join('')).not.toContain('falsch');
    } finally {
      await own.close();
    }
  }, SLOW);

  it('shuts the owner out too, and says for how long', async () => {
    // The uncomfortable half of the trade, written down rather than wished
    // away. The brake answers before the password is checked — that is the
    // whole point, since checking is the 64 MiB — so it cannot tell the owner
    // from the guesser. Somebody who can keep the budget spent can therefore
    // keep the owner out for as long as they keep it up.
    //
    // Accepted, because the alternatives are worse: hashing every attempt to
    // find out who is asking hands over exactly the resource being defended,
    // and a budget nobody ever reaches defends nothing. The window bounds the
    // damage, the answer says when to come back, and the operator has
    // `ndbrain-user` on the host either way.
    for (const from of addresses(SMALL.accountLimit + 2)) await attempt('julian', 'falsch', from);

    const owner = await attempt('julian', 'ein gutes passwort', '198.51.100.4');
    expect(owner.statusCode).toBe(429);
    expect(Number(owner.headers['retry-after'])).toBeGreaterThan(0);
  }, SLOW);

  it('does not let one account spend another account\'s budget', async () => {
    await h.runtime.users.create('anna', 'ihr gutes passwort');
    for (const from of addresses(SMALL.accountLimit + 2)) await attempt('julian', 'falsch', from);

    // Anna has not been guessed at, so her first attempt is hers to make.
    expect((await attempt('anna', 'ihr gutes passwort', '198.51.100.5')).statusCode).toBe(200);
  }, SLOW);
});

describe('the budgets themselves', () => {
  // Straight at the brake, with the clock handed in. Going through HTTP here
  // would mean paying scrypt for every attempt just to watch a window expire,
  // and the window would elapse while the attempts were still being made.
  const account = 'julian';

  it('refills, so one burst of guessing cannot lock an account for good', () => {
    const brake = new LoginThrottle({ limit: 3, accountLimit: 8, windowMs: 1000 });
    for (let i = 0; i < 9; i += 1) brake.recordFailure(`203.0.113.${i}`, account, 0);

    expect(brake.retryAfter('198.51.100.1', account, 500)).toBeGreaterThan(0);
    expect(brake.retryAfter('198.51.100.1', account, 1001)).toBe(0);
  });

  it('says how many seconds are left, not merely that it is closed', () => {
    const brake = new LoginThrottle({ limit: 1, accountLimit: 99, windowMs: 10_000 });
    brake.recordFailure('203.0.113.1', account, 0);

    expect(brake.retryAfter('203.0.113.1', account, 2000)).toBe(8);
  });

  it('keeps an address budget and an account budget apart', () => {
    // An account literally named like an address-and-account pair must not be
    // able to reach into that pair's bucket. Both limits are 1, so a collision
    // shows: without distinct prefixes the two names produce one key, and the
    // failure recorded for the pair would close the door on the account.
    const brake = new LoginThrottle({ limit: 1, accountLimit: 1 });
    brake.recordFailure('1.2.3.4', 'julian', 0);

    expect(brake.retryAfter('1.2.3.4', 'julian', 1)).toBeGreaterThan(0);
    expect(brake.retryAfter('9.9.9.9', '1.2.3.4|julian', 1)).toBe(0);
  });

  it('lets a success clear the account budget, not only the address one', () => {
    // Why the account budget is clearable at all: somebody spending it from
    // elsewhere would otherwise keep the owner out for the whole window even
    // though the owner just proved, with the password, that they are there.
    const brake = new LoginThrottle({ limit: 3, accountLimit: 4, windowMs: 10_000 });
    for (let i = 0; i < 4; i += 1) brake.recordFailure(`203.0.113.${i}`, account, 0);
    expect(brake.retryAfter('198.51.100.1', account, 1)).toBeGreaterThan(0);

    brake.recordSuccess('198.51.100.2', account);

    expect(brake.retryAfter('198.51.100.1', account, 2)).toBe(0);
  });
});
