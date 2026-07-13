import { describe, expect, it } from "vitest";
import { formatTimestamp } from "./formatTimestamp";

describe("formatTimestamp", () => {
  it("returns the fallback for null", () => {
    expect(formatTimestamp(null)).toBe("—");
  });

  it("returns the fallback for undefined", () => {
    expect(formatTimestamp(undefined)).toBe("—");
  });

  it("returns the fallback for an empty string", () => {
    expect(formatTimestamp("")).toBe("—");
  });

  it("returns a custom fallback when given one", () => {
    expect(formatTimestamp(null, "Never")).toBe("Never");
  });

  it("returns the fallback for an unparsable date string", () => {
    expect(formatTimestamp("not-a-date")).toBe("—");
  });

  it("formats a valid ISO timestamp into a locale string containing the year", () => {
    const result = formatTimestamp("2026-03-15T10:30:00.000Z");
    expect(result).not.toBe("—");
    expect(result).toContain("2026");
  });
});
