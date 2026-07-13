import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSearchPalette } from "./useSearchPalette";

function fireKeydown(init: KeyboardEventInit) {
  document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

describe("useSearchPalette", () => {
  it("starts closed", () => {
    const { result } = renderHook(() => useSearchPalette());
    expect(result.current.open).toBe(false);
  });

  it("opens on Cmd-K (metaKey)", () => {
    const { result } = renderHook(() => useSearchPalette());

    act(() => fireKeydown({ key: "k", metaKey: true }));

    expect(result.current.open).toBe(true);
  });

  it("opens on Ctrl-K (ctrlKey)", () => {
    const { result } = renderHook(() => useSearchPalette());

    act(() => fireKeydown({ key: "k", ctrlKey: true }));

    expect(result.current.open).toBe(true);
  });

  it("ignores a bare 'k' without a modifier", () => {
    const { result } = renderHook(() => useSearchPalette());

    act(() => fireKeydown({ key: "k" }));

    expect(result.current.open).toBe(false);
  });

  it("openPalette/closePalette toggle the open state directly", () => {
    const { result } = renderHook(() => useSearchPalette());

    act(() => result.current.openPalette());
    expect(result.current.open).toBe(true);

    act(() => result.current.closePalette());
    expect(result.current.open).toBe(false);
  });

  it("removes its keydown listener on unmount", () => {
    const { result, unmount } = renderHook(() => useSearchPalette());
    unmount();

    act(() => fireKeydown({ key: "k", metaKey: true }));

    expect(result.current.open).toBe(false);
  });
});
