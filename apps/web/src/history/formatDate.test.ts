import { describe, expect, it } from "vitest";
import { formatDate } from "./formatDate";

const NOW = new Date("2026-07-10T12:00:00.000Z");

describe("formatDate", () => {
  it("returns 'just now' for timestamps under 45 seconds old", () => {
    expect(formatDate("2026-07-10T11:59:30.000Z", NOW)).toBe("just now");
  });

  it("formats minutes ago", () => {
    expect(formatDate("2026-07-10T11:55:00.000Z", NOW)).toBe("5 minutes ago");
  });

  it("uses singular minute for exactly 1 minute", () => {
    expect(formatDate("2026-07-10T11:59:00.000Z", NOW)).toBe("1 minute ago");
  });

  it("formats hours ago", () => {
    expect(formatDate("2026-07-10T09:00:00.000Z", NOW)).toBe("3 hours ago");
  });

  it("uses singular hour for exactly 1 hour", () => {
    expect(formatDate("2026-07-10T11:00:00.000Z", NOW)).toBe("1 hour ago");
  });

  it("formats days ago", () => {
    expect(formatDate("2026-07-08T12:00:00.000Z", NOW)).toBe("2 days ago");
  });

  it("falls back to a locale date once a week or more has passed", () => {
    const eightDaysAgo = "2026-07-02T12:00:00.000Z";
    expect(formatDate(eightDaysAgo, NOW)).toBe(new Date(eightDaysAgo).toLocaleDateString());
  });

  it("falls back to a locale date for future/invalid clock skew", () => {
    const future = "2026-07-11T12:00:00.000Z";
    expect(formatDate(future, NOW)).toBe(new Date(future).toLocaleDateString());
  });

  it("returns the raw string for an unparseable date", () => {
    expect(formatDate("not-a-date", NOW)).toBe("not-a-date");
  });
});
