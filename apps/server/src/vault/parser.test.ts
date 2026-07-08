import { describe, expect, it } from "vitest";
import { parseNote } from "./parser.js";

describe("parseNote", () => {
  it("extracts frontmatter and body", () => {
    const p = parseNote("---\ntags: [a]\n---\n# Hello\nWorld");
    expect(p.frontmatter).toEqual({ tags: ["a"] });
    expect(p.body).toBe("# Hello\nWorld");
  });

  it("derives title from first heading, else null", () => {
    expect(parseNote("# My Title\ntext").title).toBe("My Title");
    expect(parseNote("no heading").title).toBeNull();
  });

  it("extracts deduplicated wikilink targets, stripping aliases", () => {
    const p = parseNote("See [[foo/bar]] and [[baz|Label]] and [[foo/bar]].");
    expect(p.links).toEqual(["foo/bar", "baz"]);
  });

  it("handles notes without frontmatter", () => {
    const p = parseNote("plain text");
    expect(p.frontmatter).toEqual({});
    expect(p.body).toBe("plain text");
  });
});
