import { afterEach, describe, expect, it } from "vitest";
import { isTauri, withTauri } from "./tauri";

function setTauriFlag(value: boolean | undefined) {
  if (value === undefined) {
    delete (globalThis as { isTauri?: boolean }).isTauri;
    return;
  }
  (globalThis as { isTauri?: boolean }).isTauri = value;
}

describe("isTauri", () => {
  afterEach(() => {
    setTauriFlag(undefined);
  });

  it("returns false when the Tauri runtime marker is absent (plain browser)", () => {
    setTauriFlag(undefined);
    expect(isTauri()).toBe(false);
  });

  it("returns false when the runtime marker is explicitly false", () => {
    setTauriFlag(false);
    expect(isTauri()).toBe(false);
  });

  it("returns true when the Tauri runtime marker is present", () => {
    setTauriFlag(true);
    expect(isTauri()).toBe(true);
  });
});

describe("withTauri", () => {
  afterEach(() => {
    setTauriFlag(undefined);
  });

  it("does not invoke the callback outside Tauri (no-op in the browser)", () => {
    setTauriFlag(undefined);
    let called = false;
    const result = withTauri(() => {
      called = true;
      return "value";
    });
    expect(called).toBe(false);
    expect(result).toBeUndefined();
  });

  it("invokes the callback and returns its result inside Tauri", () => {
    setTauriFlag(true);
    const result = withTauri(() => "value");
    expect(result).toBe("value");
  });
});
