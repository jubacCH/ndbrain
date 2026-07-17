/** Shared sun/moon glyph for the theme-toggle button, so every shell's toggle
 *  looks identical instead of each one carrying its own emoji (🌙/☀️) or
 *  hand-drawn SVG paths.
 *
 *  Purely presentational — the toggle's `aria-label` (what
 *  `AppShell.test.tsx` actually asserts against) stays owned by each button,
 *  not this icon. */

import type { ThemeKind } from "../theme/themes";

export interface ThemeToggleIconProps {
  /** The theme currently in effect — determines which glyph is shown as
   *  the "switch to the other theme" affordance (sun in dark mode, moon in
   *  light mode), matching `useTheme()`'s `resolvedTheme`. */
  resolvedTheme: ThemeKind;
}

export function ThemeToggleIcon({ resolvedTheme }: ThemeToggleIconProps) {
  return resolvedTheme === "dark" ? (
    // Sun — shown in dark mode as the affordance to switch to light.
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <circle cx="7.5" cy="7.5" r="3" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M7.5 1v1.6M7.5 12.4V14M14 7.5h-1.6M2.6 7.5H1M12.34 2.66l-1.13 1.13M3.79 11.21l-1.13 1.13M12.34 12.34l-1.13-1.13M3.79 3.79 2.66 2.66"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  ) : (
    // Crescent moon — shown in light mode as the affordance to switch to dark.
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path
        d="M11.5 8.7A4.6 4.6 0 1 1 6.3 3.5a3.7 3.7 0 0 0 5.2 5.2Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
