/**
 * Password hashing.
 *
 * Uses Node's built-in scrypt rather than argon2. Argon2 is the first choice in
 * OWASP's guidance and scrypt is the listed alternative, so this trades a small
 * amount of theoretical strength for something the project values more: no native
 * dependency. A prebuilt argon2 binary works on the platforms its publisher
 * targets and fails on the rest, and "self-hosting never needs a toolchain" is a
 * promise the README makes.
 *
 * Parameters follow OWASP's accepted alternative configuration N=2^16, r=8, p=2 —
 * 64 MiB per hash. The stronger N=2^17 would want 128 MiB, which is a poor fit
 * for a container that runs in 1 GiB alongside everything else.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

// `promisify` picks the overload without options, which is the one we never use.
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

const N = 65_536; // CPU/memory cost
const R = 8; // block size
const P = 2; // parallelisation
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

// scrypt needs roughly 128 * N * r bytes; Node refuses to exceed `maxmem`, and its
// 32 MiB default is far below what these parameters require.
const MAX_MEM = 128 * N * R * 2;

/** Encoded as `scrypt$N$r$p$salt$hash`, so parameters can change without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
  assertUsablePassword(password);

  const salt = randomBytes(SALT_LENGTH);
  const derived = (await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEM,
  })) as Buffer;

  return ['scrypt', N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
}

/**
 * Checks a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupt row must read
 * as "wrong password", never as a crash that tells an attacker something.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64');
    expected = Buffer.from(parts[5] ?? '', 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = (await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: Math.max(MAX_MEM, 128 * n * r * 2),
    })) as Buffer;
  } catch {
    return false;
  }

  // Constant-time: a length-dependent early return would leak the key length.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Rejects passwords that are too short to be worth hashing.
 *
 * Length only — no character-class rules. Those push people towards `Passwort1!`
 * and are no longer recommended; the 8-character floor is the NIST minimum.
 */
export function assertUsablePassword(password: string): void {
  if (typeof password !== 'string' || password.normalize('NFKC').length < 8) {
    throw new Error('password must be at least 8 characters');
  }
  if (Buffer.byteLength(password, 'utf8') > 4096) {
    throw new Error('password is implausibly long');
  }
}
