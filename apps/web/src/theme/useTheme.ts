/** Theme state: an explicit user override (a theme id from the registry)
 *  persisted to localStorage, falling back to the OS `prefers-color-scheme`
 *  when unset. Applies the override as `data-theme` on `<html>`, which
 *  `index.css` uses to win over the media query. Themes are defined in
 *  `theme/themes.ts` — this hook never hardcodes a palette or a theme id
 *  beyond the OS-fallback defaults. */

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  THEMES,
  themeById,
  type ThemeDef,
  type ThemeKind,
} from "./themes";

/** A registered theme id, or `null` to follow the OS preference. */
export type ThemePreference = string | null;

const STORAGE_KEY = "ndbrain:theme";

function readStoredPreference(): ThemePreference {
  const raw = localStorage.getItem(STORAGE_KEY);
  // Ignore unknown/legacy values (e.g. an old bare "light"/"dark") — they fall
  // back to following the OS rather than stamping an id no theme block matches.
  return raw && themeById(raw) ? raw : null;
}

function systemPrefersDark(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export interface UseThemeResult {
  /** Explicit override (a theme id); `null` means "follow the OS preference". */
  preference: ThemePreference;
  /** The theme id actually in effect (override, or the OS-fallback default). */
  themeId: string;
  /** The kind of the active theme — "dark" or "light". Non-CSS consumers
   *  (graph canvas, toggle icon) branch on this instead of on a theme id. */
  resolvedTheme: ThemeKind;
  /** All registered themes, for building a picker. */
  themes: ThemeDef[];
  /** Pick a theme by id, or pass `null` to go back to following the OS. */
  setTheme: (id: ThemePreference) => void;
  /** Quick flip between the default dark and light themes. */
  toggleTheme: () => void;
}

export function useTheme(): UseThemeResult {
  const [preference, setPreference] = useState<ThemePreference>(() => readStoredPreference());
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark());

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (preference) {
      root.dataset.theme = preference;
    } else {
      delete root.dataset.theme;
    }
  }, [preference]);

  const setTheme = useCallback((id: ThemePreference) => {
    if (id === null) {
      localStorage.removeItem(STORAGE_KEY);
      setPreference(null);
      return;
    }
    if (!themeById(id)) return;
    localStorage.setItem(STORAGE_KEY, id);
    setPreference(id);
  }, []);

  const toggleTheme = useCallback(() => {
    setPreference((prev) => {
      const currentId = prev ?? (systemPrefersDark() ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME);
      const currentKind = themeById(currentId)?.kind ?? "dark";
      const next = currentKind === "dark" ? DEFAULT_LIGHT_THEME : DEFAULT_DARK_THEME;
      localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  }, []);

  const themeId = preference ?? (systemDark ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME);
  const resolvedTheme: ThemeKind = themeById(themeId)?.kind ?? (systemDark ? "dark" : "light");

  return { preference, themeId, resolvedTheme, themes: THEMES, setTheme, toggleTheme };
}
