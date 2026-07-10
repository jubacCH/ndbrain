import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppStateProvider, useAppState } from "./AppState";

describe("AppState", () => {
  it("starts with no note selected", () => {
    const { result } = renderHook(() => useAppState(), {
      wrapper: ({ children }) => <AppStateProvider>{children}</AppStateProvider>,
    });

    expect(result.current.selectedPath).toBeNull();
  });

  it("setSelectedPath updates the shared selection", () => {
    const { result } = renderHook(() => useAppState(), {
      wrapper: ({ children }) => <AppStateProvider>{children}</AppStateProvider>,
    });

    act(() => result.current.setSelectedPath("notes/a.md"));

    expect(result.current.selectedPath).toBe("notes/a.md");
  });

  it("setSelectedPath(null) clears the selection", () => {
    const { result } = renderHook(() => useAppState(), {
      wrapper: ({ children }) => <AppStateProvider>{children}</AppStateProvider>,
    });

    act(() => result.current.setSelectedPath("notes/a.md"));
    act(() => result.current.setSelectedPath(null));

    expect(result.current.selectedPath).toBeNull();
  });

  it("throws when used outside an AppStateProvider", () => {
    expect(() => renderHook(() => useAppState())).toThrow(/AppStateProvider/);
  });
});
