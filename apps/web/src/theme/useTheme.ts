/** Light/dark theme state: an explicit user override persisted to localStorage,
 *  falling back to the OS `prefers-color-scheme` when unset. Applies the override
 *  as `data-theme` on `<html>`, which `index.css` uses to win over the media query. */

import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | null;

const STORAGE_KEY = "ndbrain:theme";

function readStoredPreference(): ThemePreference {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === "light" || raw === "dark" ? raw : null;
}

function systemPrefersDark(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export interface UseThemeResult {
  /** Explicit user override; null means "follow the OS preference". */
  preference: ThemePreference;
  /** The theme actually in effect: the override, or the OS preference when unset. */
  resolvedTheme: "light" | "dark";
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

  const toggleTheme = useCallback(() => {
    setPreference((prev) => {
      const current = prev ?? (systemPrefersDark() ? "dark" : "light");
      const next = current === "dark" ? "light" : "dark";
      localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  }, []);

  const resolvedTheme = preference ?? (systemDark ? "dark" : "light");

  return { preference, resolvedTheme, toggleTheme };
}
