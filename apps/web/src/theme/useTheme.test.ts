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
  });

  it("toggling flips the resolved theme and sets data-theme on <html>", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolvedTheme).toBe("light");

    act(() => result.current.toggleTheme());

    expect(result.current.preference).toBe("dark");
    expect(result.current.resolvedTheme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("persists the override to localStorage and reads it back on next mount", () => {
    stubMatchMedia(false);
    const first = renderHook(() => useTheme());
    act(() => first.result.current.toggleTheme());
    expect(localStorage.getItem("ndbrain:theme")).toBe("dark");

    const second = renderHook(() => useTheme());
    expect(second.result.current.preference).toBe("dark");
    expect(second.result.current.resolvedTheme).toBe("dark");
  });

  it("toggling twice returns to the opposite-of-original state explicitly (no longer follows OS)", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useTheme());

    act(() => result.current.toggleTheme());
    expect(result.current.preference).toBe("light");
    act(() => result.current.toggleTheme());
    expect(result.current.preference).toBe("dark");
  });
});
