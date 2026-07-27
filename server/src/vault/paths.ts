/**
 * Path handling and the tenant boundary.
 *
 * Everything in here is pure: no filesystem access, no I/O. That makes the
 * security-critical rules exhaustively testable without a temp directory, and it
 * keeps the boundary in one small file that is worth reading in full.
 *
 * Two invariants this module exists to guarantee:
 *
 *   1. A resolved path always lies inside `<dataDir>/vaults/<userId>/`.
 *   2. There is no way to obtain a path without naming an owner.
 *
 * Symlinks can still escape a directory after the fact, so the filesystem layer
 * re-checks the real path once the file exists. Purity buys clarity here, not
 * completeness.
 */

import path from 'node:path';

import { InvalidPathError, InvalidUserError } from '../errors.js';

/**
 * User ids appear verbatim as a directory name, so they are restricted to a
 * conservative character set. Without this, a user id is a traversal vector that
 * bypasses every check applied to note paths.
 */
const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Names Windows refuses to create regardless of extension. The server targets
 * Linux, but a vault is meant to survive being copied, mounted or synced onto any
 * machine — a note called `aux.md` would not.
 */
const RESERVED_BASENAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** Characters that are illegal or ambiguous across the filesystems a vault may land on. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS_RE = /[\u0000-\u001F<>:"\\|?*]/;

export const NOTE_EXTENSION = '.md';

/** Rejects anything that cannot safely become a directory name. */
export function assertUserId(userId: string): void {
  if (!USER_ID_RE.test(userId)) {
    throw new InvalidUserError('user id is not a valid vault directory name');
  }
}

/** Absolute path to a user's vault root. The only place vault roots are constructed. */
export function vaultRoot(dataDir: string, userId: string): string {
  assertUserId(userId);
  return path.resolve(dataDir, 'vaults', userId);
}

/**
 * Canonicalises a vault-relative path and rejects everything unsafe.
 *
 * Returns a POSIX-style relative path with no leading slash, no `.`/`..`
 * segments, and no trailing slash. This is *the* canonical form: the index, link
 * resolution and case-collision checks all compare against it, so two spellings
 * of the same note must normalise to the same string.
 *
 * Backslashes are rejected rather than translated. On Linux a backslash is a
 * legal filename character, so silently treating it as a separator would let a
 * client address one file by two different names.
 */
export function normalizeVaultPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new InvalidPathError('path is empty');
  }
  if (FORBIDDEN_CHARS_RE.test(input)) {
    throw new InvalidPathError('path contains characters that are unsafe in a file name');
  }
  if (path.isAbsolute(input) || input.startsWith('/')) {
    throw new InvalidPathError('path must be relative to the vault root');
  }
  // Windows drive-relative forms such as `C:notes.md`; the colon is already
  // rejected above, but be explicit rather than rely on that ordering.
  if (/^[A-Za-z]:/.test(input)) {
    throw new InvalidPathError('path must be relative to the vault root');
  }

  const segments = input.split('/');
  const out: string[] = [];

  for (const raw of segments) {
    if (raw === '' || raw === '.') continue; // collapse `a//b` and `./a`
    if (raw === '..') {
      throw new InvalidPathError('path may not traverse upwards');
    }

    // A trailing dot or space is silently stripped by Windows, which would make
    // `note.md ` and `note.md` the same file there but not here.
    if (raw !== raw.trimEnd() || raw.endsWith('.')) {
      throw new InvalidPathError('path segment may not end in a space or a dot');
    }

    const stem = raw.split('.')[0] ?? '';
    if (RESERVED_BASENAMES.has(stem.toLowerCase())) {
      throw new InvalidPathError(`"${stem}" is a reserved name on some filesystems`);
    }

    out.push(raw);
  }

  if (out.length === 0) {
    throw new InvalidPathError('path resolves to the vault root itself');
  }

  return out.join('/');
}

/** True if the path names a note (rather than a directory or an attachment). */
export function isNotePath(vaultPath: string): boolean {
  return vaultPath.toLowerCase().endsWith(NOTE_EXTENSION);
}

/** Vault-relative path with the `.md` suffix removed — the note's title and link target. */
export function noteTitle(vaultPath: string): string {
  const base = vaultPath.slice(vaultPath.lastIndexOf('/') + 1);
  return isNotePath(base) ? base.slice(0, -NOTE_EXTENSION.length) : base;
}

/** Parent directory of a vault path, or `''` for a note at the vault root. */
export function parentDir(vaultPath: string): string {
  const i = vaultPath.lastIndexOf('/');
  return i === -1 ? '' : vaultPath.slice(0, i);
}

/**
 * Resolves a vault-relative path to an absolute one inside `userId`'s vault.
 *
 * The containment check after resolution is belt-and-braces: `normalizeVaultPath`
 * already rejects traversal, but this is the invariant that actually matters, so
 * it is asserted rather than assumed.
 */
export function resolveInVault(dataDir: string, userId: string, input: string): string {
  const root = vaultRoot(dataDir, userId);
  const relative = normalizeVaultPath(input);
  const resolved = path.resolve(root, relative);

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new InvalidPathError('path escapes the vault root');
  }

  return resolved;
}

/**
 * The comparison key for case-collision detection.
 *
 * Case folding alone is not enough: macOS stores file names as NFD and Linux
 * typically as NFC, so `Müller.md` typed on one machine and on the other are
 * different byte sequences for the same visible name. Normalising to NFC before
 * folding makes both collide, which is the intended outcome.
 */
export function caseKey(vaultPath: string): string {
  return vaultPath.normalize('NFC').toLowerCase();
}
