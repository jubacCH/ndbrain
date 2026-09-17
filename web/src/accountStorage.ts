/**
 * What this browser remembers about one account, and forgetting it again.
 *
 * Some of what the shell keeps in `localStorage` is not about the screen but
 * about what somebody read: the notes opened lately, which folders were open,
 * where the notes of their brain lay. Two people signing in on the same browser
 * must not see each other's, and neither should be readable from the storage
 * after signing out. So every such entry is keyed by account, and signing out
 * removes that account's entries.
 *
 * What stays browser-wide is `prefs.ts`: a theme, a text size, which network
 * view was last chosen. Those describe the screen, not a vault.
 */

import { forgetPositions } from './brain/positions';
import { mayWrite } from './session';

/** The first shapes, shared by every account on the browser. Removed on sight. */
const LEGACY_KEYS = ['ndbrain.recents', 'ndbrain.openFolders'];

/**
 * The storage key for one account's entry.
 *
 * The id is the last part and is compared as a whole key, never as a prefix,
 * so no account id can name another's entry. Encoded so that the key stays
 * printable whatever the id holds.
 */
function keyFor(base: string, account: string): string {
  return `${base}.${encodeURIComponent(account)}`;
}

export const recentsKey = (account: string): string => keyFor('ndbrain.recents', account);
export const openFoldersKey = (account: string): string => keyFor('ndbrain.openFolders', account);

/** The most the settings page offers to show; see `LIMITS.recentCount` in prefs. */
const RECENTS_KEPT = 20;

export interface Recent {
  owner: string;
  path: string;
}

/**
 * Removes the account-less entries of earlier builds.
 *
 * Once, in effect: after the first run there is nothing left to remove. They
 * are dropped rather than handed to whoever signs in next, because there is no
 * telling whose they were.
 */
export function discardLegacy(): void {
  try {
    for (const key of LEGACY_KEYS) window.localStorage.removeItem(key);
  } catch {
    // Blocked storage has nothing in it to leak.
  }
}

export function loadRecents(account: string): Recent[] {
  try {
    const raw = window.localStorage.getItem(recentsKey(account));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is Recent =>
        r !== null && typeof r === 'object' && typeof r.owner === 'string' && typeof r.path === 'string',
    );
  } catch {
    return [];
  }
}

export function pushRecent(account: string, owner: string, path: string): void {
  if (!mayWrite(account)) return;
  try {
    const next = [{ owner, path }, ...loadRecents(account).filter((r) => !(r.owner === owner && r.path === path))];
    // As many as the settings page lets the sidebar show, so raising the number
    // there shows more straight away rather than after twenty more opens.
    window.localStorage.setItem(recentsKey(account), JSON.stringify(next.slice(0, RECENTS_KEPT)));
  } catch {
    // Private browsing, a full quota — none of it is worth an error message.
  }
}

/** Takes a deleted note out of the list, so it is not offered again. */
export function dropRecent(account: string, owner: string, path: string): void {
  if (!mayWrite(account)) return;
  try {
    const kept = loadRecents(account).filter((r) => !(r.owner === owner && r.path === path));
    window.localStorage.setItem(recentsKey(account), JSON.stringify(kept));
  } catch {
    // As above: a list that cannot be rewritten still resolves against the tree.
  }
}

export function loadOpenFolders(account: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(openFoldersKey(account));
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveOpenFolders(account: string, open: ReadonlySet<string>): void {
  if (!mayWrite(account)) return;
  try {
    window.localStorage.setItem(openFoldersKey(account), JSON.stringify([...open]));
  } catch {
    // A vault that cannot remember which folders were open is still usable.
  }
}

/** Everything this browser keeps about one account: gone, on signing out. */
export function forgetAccount(account: string): void {
  try {
    window.localStorage.removeItem(recentsKey(account));
    window.localStorage.removeItem(openFoldersKey(account));
  } catch {
    // Nothing stored, nothing to forget.
  }
  forgetPositions(account);
}
