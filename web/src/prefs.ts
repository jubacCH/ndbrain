/**
 * Preferences that belong to this browser.
 *
 * The split is deliberate and worth stating, because "put it in the database" is
 * the reflex. A theme, a text size and which view opens first are properties of
 * the screen somebody is sitting at: syncing those would make a phone and a
 * desktop overwrite each other's choices all day, and a dark theme chosen on a
 * laptop at night is not a statement about the vault.
 *
 * What lives on the server is only what changes the server's *answers* — so far
 * exactly one thing, the staleness threshold, which decides what gets reported
 * as needing attention. See `server/src/auth/settings.ts`.
 *
 * Several of these exist because earlier work made a decision on the user's
 * behalf and it should not have been permanent. Hiding numeric sort prefixes was
 * right for a vault using Johnny-Decimal folders and wrong for one where the
 * digits are the name; the honest resolution is a switch, defaulting to the
 * choice that suits most vaults.
 */

export type Theme = 'system' | 'light' | 'dark';
export type StartView = 'overview' | 'note' | 'search' | 'files';

export interface Prefs {
  theme: Theme;
  /** Multiplier on the base type size; everything else is sized in rem. */
  textScale: number;
  /** Which view opens on load. */
  startView: StartView;
  /** Hide `00_`-style prefixes in the tree and the breadcrumb. Display only. */
  hidePrefixes: boolean;
  /** How long typing pauses before a write, in milliseconds. */
  saveDelayMs: number;
  /** How many recently opened notes the sidebar lists; 0 hides the list. */
  recentCount: number;
  /**
   * The length chosen before the list was switched off.
   *
   * Without it, turning the list back on lands on a default rather than on the
   * number somebody had already decided they wanted — a small thing that makes a
   * toggle feel like it forgot.
   */
  lastRecentCount: number;
  /** Poll interval for the live pulse in the network views, in milliseconds. */
  pulseMs: number;
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  textScale: 1,
  startView: 'overview',
  hidePrefixes: true,
  saveDelayMs: 500,
  recentCount: 5,
  lastRecentCount: 5,
  pulseMs: 2000,
};

const KEY = 'ndbrain.prefs';
/** Read by the inline script in index.html, which cannot see this module. */
const THEME_KEY = 'ndbrain.theme';
const SCALE_KEY = 'ndbrain.textSize';

const LIMITS = {
  textScale: [0.85, 1.6],
  saveDelayMs: [200, 5000],
  recentCount: [0, 20],
  pulseMs: [1000, 30_000],
} as const;

function clamp(value: number, [min, max]: readonly [number, number], fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/**
 * Reads what is stored, and repairs whatever is not usable.
 *
 * Stored preferences are input that has been sitting in a browser for months,
 * possibly written by an older version of this file. A missing key, a string
 * where a number belongs, a save delay of zero — none of those may reach the
 * application, so every field is checked rather than spread in.
 */
export function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return { ...DEFAULT_PREFS };
    const stored = JSON.parse(raw) as Partial<Prefs>;

    return {
      theme:
        stored.theme === 'light' || stored.theme === 'dark' || stored.theme === 'system'
          ? stored.theme
          : DEFAULT_PREFS.theme,
      textScale: clamp(Number(stored.textScale), LIMITS.textScale, DEFAULT_PREFS.textScale),
      startView: (['overview', 'note', 'search', 'files'] as StartView[]).includes(
        stored.startView as StartView,
      )
        ? (stored.startView as StartView)
        : DEFAULT_PREFS.startView,
      hidePrefixes:
        typeof stored.hidePrefixes === 'boolean' ? stored.hidePrefixes : DEFAULT_PREFS.hidePrefixes,
      saveDelayMs: clamp(Number(stored.saveDelayMs), LIMITS.saveDelayMs, DEFAULT_PREFS.saveDelayMs),
      recentCount: Math.round(
        clamp(Number(stored.recentCount), LIMITS.recentCount, DEFAULT_PREFS.recentCount),
      ),
      lastRecentCount: Math.round(
        clamp(Number(stored.lastRecentCount), [1, 20], DEFAULT_PREFS.lastRecentCount),
      ),
      pulseMs: clamp(Number(stored.pulseMs), LIMITS.pulseMs, DEFAULT_PREFS.pulseMs),
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
    // Mirrored under their own keys for the inline script in index.html, which
    // runs before this bundle exists and must not have to parse the whole blob.
    if (prefs.theme === 'system') window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, prefs.theme);
    window.localStorage.setItem(SCALE_KEY, String(prefs.textScale));
  } catch {
    // Private browsing, a full quota. A tool that cannot remember a preference
    // is still a working tool; refusing to run would not be.
  }
}

/**
 * Puts the preferences on the document.
 *
 * `system` removes the attribute rather than setting it to a value, because the
 * stylesheet's rule is "no attribute means follow the media query" — writing
 * `data-theme="system"` would match neither branch and strand the page on the
 * light palette.
 */
export function applyPrefs(prefs: Prefs): void {
  const root = document.documentElement;
  if (prefs.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', prefs.theme);

  root.style.setProperty('--text-scale', String(prefs.textScale));

  // Keeps the browser's own chrome — the address bar on a phone — in step with
  // the choice, which the two <meta> tags alone cannot do once it is explicit.
  const dark =
    prefs.theme === 'dark' ||
    (prefs.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  for (const tag of document.querySelectorAll('meta[name="theme-color"]')) {
    tag.setAttribute('content', dark ? '#0b0c0f' : '#fbfbfc');
  }
}
