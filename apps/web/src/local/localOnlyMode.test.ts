import { afterEach, describe, expect, it, vi } from "vitest";
import { isLocalOnly, setLocalOnly } from "./localOnlyMode";

describe("localOnlyMode", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to false when nothing has been persisted", () => {
    expect(isLocalOnly()).toBe(false);
  });

  it("persists true across calls", () => {
    setLocalOnly(true);
    expect(isLocalOnly()).toBe(true);
  });

  it("persists false (clearing a previously set flag)", () => {
    setLocalOnly(true);
    setLocalOnly(false);
    expect(isLocalOnly()).toBe(false);
  });

  it("survives being read by a fresh call after persisting (simulates a remount)", () => {
    setLocalOnly(true);
    // No in-memory state in this module - re-reading must reflect localStorage,
    // not a cached value from the `setLocalOnly` call above.
    expect(isLocalOnly()).toBe(true);
  });

  it("is a no-op and defaults to false when localStorage is unavailable", () => {
    const original = globalThis.localStorage;
    // @ts-expect-error - deliberately simulating an environment without localStorage
    delete globalThis.localStorage;
    try {
      expect(isLocalOnly()).toBe(false);
      expect(() => setLocalOnly(true)).not.toThrow();
    } finally {
      vi.stubGlobal("localStorage", original);
    }
  });
});
