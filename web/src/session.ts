/**
 * Which account this tab is signed in as, for the code that writes to the
 * browser's storage on that account's behalf.
 *
 * Forgetting an account on sign-out is only half of it. Whatever still runs
 * afterwards — a view saving its state as it unmounts, a timer, a tab that has
 * not yet heard the session ended — would write the forgotten entries straight
 * back. So every per-account write asks here first, and once the session has
 * ended nothing is written for anybody until the next sign-in.
 *
 * Deliberately permissive before any session was opened: a component rendered
 * on its own (a test, a future embed) has no shell around it to open one.
 */

let active: string | null | undefined;

/** A session begins; writes for this account, and only this one, are allowed. */
export function openSession(account: string): void {
  active = account;
}

/** The session ended; no per-account write is allowed until the next one opens. */
export function closeSession(): void {
  active = null;
}

export function mayWrite(account: string): boolean {
  return active === undefined || active === account;
}

/**
 * The storage key other tabs listen on to learn that the session changed.
 *
 * The value is a timestamp and nothing else — no account id, which would
 * leave behind exactly what signing out is meant to remove. A tab that hears
 * it asks the server who is signed in now.
 */
export const SESSION_SIGNAL_KEY = 'ndbrain.session';

export function announceSessionChange(): void {
  try {
    window.localStorage.setItem(SESSION_SIGNAL_KEY, String(Date.now()));
  } catch {
    // Blocked storage: other tabs find out on their next request instead.
  }
}
