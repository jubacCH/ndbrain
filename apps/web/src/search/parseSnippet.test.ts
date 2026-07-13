import { describe, expect, it } from "vitest";
import { parseSnippet } from "./parseSnippet";

describe("parseSnippet", () => {
  it("returns an empty array for an empty snippet", () => {
    expect(parseSnippet("")).toEqual([]);
  });

  it("returns a single plain segment when there are no bold markers", () => {
    expect(parseSnippet("no markers here")).toEqual([{ text: "no markers here", bold: false }]);
  });

  it("splits a single bold span out of surrounding plain text", () => {
    expect(parseSnippet("foo **bar** baz")).toEqual([
      { text: "foo ", bold: false },
      { text: "bar", bold: true },
      { text: " baz", bold: false },
    ]);
  });

  it("handles a snippet that is entirely bold", () => {
    expect(parseSnippet("**bar**")).toEqual([{ text: "bar", bold: true }]);
  });

  it("handles multiple bold spans", () => {
    expect(parseSnippet("**one** and **two** and **three**")).toEqual([
      { text: "one", bold: true },
      { text: " and ", bold: false },
      { text: "two", bold: true },
      { text: " and ", bold: false },
      { text: "three", bold: true },
    ]);
  });

  it("handles adjacent bold spans with no gap between them", () => {
    expect(parseSnippet("**a****b**")).toEqual([
      { text: "a", bold: true },
      { text: "b", bold: true },
    ]);
  });

  it("treats a stray unmatched ** as literal text instead of throwing", () => {
    expect(parseSnippet("a ** b")).toEqual([{ text: "a ** b", bold: false }]);
  });

  it("is safe to call twice in a row (regex lastIndex does not leak state)", () => {
    expect(parseSnippet("**bar**")).toEqual([{ text: "bar", bold: true }]);
    expect(parseSnippet("**bar**")).toEqual([{ text: "bar", bold: true }]);
  });
});
