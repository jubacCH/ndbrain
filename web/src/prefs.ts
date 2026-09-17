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
export type StartView = 'overview' | 'journal' | 'note' | 'search' | 'files';
/** How wide a line of prose may get before it wraps. */
export type Measure = 'narrow' | 'medium' | 'wide';
/** How the whole network is shown: the brain, a table, or a map of the folders. */
export type NetworkView = 'graph' | 'list' | 'map';

/** The views the network switcher offers, in the order it shows them. */
export const NETWORK_VIEWS: readonly NetworkView[] = ['graph', 'list', 'map'];

export interface Prefs {
  theme: Theme;
  /** Multiplier on the base type size; everything else is sized in rem. */
  textScale: number;
  /**
   * The reading measure.
   *
   * 45–75 characters is where continuous prose reads best, and a vault that
   * is mostly tables is not continuous prose — so this is a judgement about
   * somebody's notes rather than about typography, and it is theirs.
   */
  measure: Measure;
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
  /**
   * Whether the sidebar is folded down to its icons.
   *
   * A property of this screen like the theme: a wide monitor wants the tree
   * open, a laptop beside a second window may not. Ignored on a phone, where
   * the sidebar is a drawer and has no folded state.
   */
  sidebarCollapsed: boolean;
  /** Which of the network's three views was last chosen. */
  networkView: NetworkView;
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  textScale: 1,
  measure: 'medium',
  startView: 'overview',
  hidePrefixes: true,
  saveDelayMs: 500,
  recentCount: 6,
  lastRecentCount: 6,
  pulseMs: 2000,
  sidebarCollapsed: false,
  networkView: 'graph',
};

/**
 * The browser chrome's colour — the address bar, the iOS status bar area.
 *
 * Kept in step by hand with three places that cannot import this: the two
 * `theme-color` tags and the inline theme script in `index.html`, and
 * `public/manifest.webmanifest` (dark, the app's own look, since a manifest has
 * one colour for both schemes). `test/pwa-colours.test.ts` holds them together.
 */
export const THEME_COLOR = { light: '#f3f7f8', dark: '#050b0e' } as const;

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

const START_VIEWS: readonly StartView[] = ['overview', 'journal', 'note', 'search', 'files'];

/**
 * A stored start view the app still has.
 *
 * Tasks used to be a view of its own and now sits beside the calendar in the
 * journal, so a browser that remembered it opens there rather than falling
 * back to the overview as if the choice had never been made.
 */
function startViewOf(stored: unknown): StartView {
  if (stored === 'tasks') return 'journal';
  return START_VIEWS.includes(stored as StartView) ? (stored as StartView) : DEFAULT_PREFS.startView;
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
      measure: (['narrow', 'medium', 'wide'] as Measure[]).includes(stored.measure as Measure)
        ? (stored.measure as Measure)
        : DEFAULT_PREFS.measure,
      startView: startViewOf(stored.startView),
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
      sidebarCollapsed:
        typeof stored.sidebarCollapsed === 'boolean'
          ? stored.sidebarCollapsed
          : DEFAULT_PREFS.sidebarCollapsed,
      networkView: NETWORK_VIEWS.includes(stored.networkView as NetworkView)
        ? (stored.networkView as NetworkView)
        : DEFAULT_PREFS.networkView,
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
  root.style.setProperty(
    '--measure',
    prefs.measure === 'narrow' ? '68ch' : prefs.measure === 'medium' ? '92ch' : 'none',
  );

  // Keeps the browser's own chrome — the address bar on a phone — in step with
  // the choice, which the two <meta> tags alone cannot do once it is explicit.
  const dark =
    prefs.theme === 'dark' ||
    (prefs.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  for (const tag of document.querySelectorAll('meta[name="theme-color"]')) {
    tag.setAttribute('content', dark ? THEME_COLOR.dark : THEME_COLOR.light);
  }
}
