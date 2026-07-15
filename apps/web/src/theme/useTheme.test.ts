import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./useTheme";

function stubMatchMedia(initialMatches: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches: initialMatches,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, listener: (e: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_: string, listener: (e: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue(mql),
  );
  return {
    fireChange(matches: boolean) {
      mql.matches = matches;
      for (const listener of listeners) listener({ matches } as MediaQueryListEvent);
    },
  };
}

describe("useTheme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("data-theme");
  });

  it("resolves to the OS preference when no override is stored", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useTheme());

    expect(result.current.preference).toBeNull();
    expect(result.current.resolvedTheme).toBe("dark");
    expect(result.current.themeId).toBe("graphite-dark");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("toggling flips the resolved kind and stamps the theme id on <html>", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolvedTheme).toBe("light");

    act(() => result.current.toggleTheme());

    expect(result.current.preference).toBe("graphite-dark");
    expect(result.current.resolvedTheme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("graphite-dark");
  });

  it("setTheme picks a named theme by id, stamps it, and reports its kind", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setTheme("duplex"));

    expect(result.current.preference).toBe("duplex");
    expect(result.current.themeId).toBe("duplex");
    expect(result.current.resolvedTheme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("duplex");
    expect(localStorage.getItem("ndbrain:theme")).toBe("duplex");
  });

  it("setTheme(null) clears the override and follows the OS again", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme("duplex"));

    act(() => result.current.setTheme(null));

    expect(result.current.preference).toBeNull();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem("ndbrain:theme")).toBeNull();
  });

  it("ignores an unknown theme id", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setTheme("not-a-real-theme"));

    expect(result.current.preference).toBeNull();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("exposes the registry so a picker can list every theme", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());

    expect(result.current.themes.map((t) => t.id)).toContain("graphite-dark");
    expect(result.current.themes.map((t) => t.id)).toContain("duplex");
  });

  it("persists the override to localStorage and reads it back on next mount", () => {
    stubMatchMedia(false);
    const first = renderHook(() => useTheme());
    act(() => first.result.current.toggleTheme());
    expect(localStorage.getItem("ndbrain:theme")).toBe("graphite-dark");

    const second = renderHook(() => useTheme());
    expect(second.result.current.preference).toBe("graphite-dark");
    expect(second.result.current.resolvedTheme).toBe("dark");
  });

  it("ignores a legacy bare light/dark value in storage", () => {
    localStorage.setItem("ndbrain:theme", "dark");
    stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());

    // Unknown/legacy id → follow OS, not a stamped data-theme.
    expect(result.current.preference).toBeNull();
    expect(result.current.resolvedTheme).toBe("light");
  });

  it("toggling twice returns to the opposite-of-original state explicitly (no longer follows OS)", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useTheme());

    act(() => result.current.toggleTheme());
    expect(result.current.preference).toBe("graphite-light");
    act(() => result.current.toggleTheme());
    expect(result.current.preference).toBe("graphite-dark");
  });
});
