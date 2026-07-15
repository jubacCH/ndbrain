/** The theme registry — the single source of truth for which colour themes
 *  exist. Adding a theme is two steps: (1) add a `[data-theme="<id>"]` block in
 *  `index.css` with the palette, (2) add an entry here. The theme picker and
 *  `useTheme` are driven entirely off this list, so a new theme then shows up
 *  everywhere automatically. `kind` tells non-CSS consumers (e.g. the graph
 *  canvas) whether a theme is dark or light without hardcoding ids. */

export type ThemeKind = "dark" | "light";

export interface ThemeDef {
  /** Matches the `data-theme` attribute value and the `[data-theme="…"]` block. */
  id: string;
  /** Human-readable name shown in the theme picker. */
  label: string;
  kind: ThemeKind;
}

export const THEMES: ThemeDef[] = [
  { id: "graphite-dark", label: "Graphite Dark", kind: "dark" },
  { id: "graphite-light", label: "Graphite Light", kind: "light" },
  { id: "duplex", label: "Duplex", kind: "light" },
];

/** Themes used when the user follows the OS preference (no explicit pick). */
export const DEFAULT_DARK_THEME = "graphite-dark";
export const DEFAULT_LIGHT_THEME = "graphite-light";

export function themeById(id: string | null | undefined): ThemeDef | undefined {
  return THEMES.find((theme) => theme.id === id);
}
