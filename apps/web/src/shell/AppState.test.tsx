import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppStateProvider, useAppState } from "./AppState";

describe("AppState", () => {
  it("starts with no note selected", () => {
    const { result } = renderHook(() => useAppState(), {
      wrapper: ({ children }) => <AppStateProvider>{children}</AppStateProvider>,
    });

    expect(result.current.selection).toBeNull();
  });

  it("setSelection updates the shared selection with a source-scoped path", () => {
    const { result } = renderHook(() => useAppState(), {
      wrapper: ({ children }) => <AppStateProvider>{children}</AppStateProvider>,
    });

    act(() => result.current.setSelection({ sourceId: "origin", path: "notes/a.md" }));

    expect(result.current.selection).toEqual({ sourceId: "origin", path: "notes/a.md" });
  });

  it("setSelection(null) clears the selection", () => {
    const { result } = renderHook(() => useAppState(), {
      wrapper: ({ children }) => <AppStateProvider>{children}</AppStateProvider>,
    });

    act(() => result.current.setSelection({ sourceId: "origin", path: "notes/a.md" }));
    act(() => result.current.setSelection(null));

    expect(result.current.selection).toBeNull();
  });

  it("throws when used outside an AppStateProvider", () => {
    expect(() => renderHook(() => useAppState())).toThrow(/AppStateProvider/);
  });
});
