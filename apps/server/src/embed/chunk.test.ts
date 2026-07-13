import { describe, expect, it } from "vitest";
import { chunkNote } from "./chunk.js";

describe("chunkNote", () => {
  it("returns a single chunk for a tiny note", () => {
    const chunks = chunkNote("Just a short thought.");

    expect(chunks).toEqual([{ ix: 0, text: "Just a short thought." }]);
  });

  it("returns zero chunks for an empty note", () => {
    expect(chunkNote("")).toEqual([]);
    expect(chunkNote("   \n\n  ")).toEqual([]);
  });

  it("splits a multi-paragraph/heading note into multiple ordered, contiguous chunks", () => {
    // Each paragraph is sized so that two of them together exceed the ~1500 char cap,
    // forcing a split into more than one chunk.
    const paragraph = (label: string) => `${label} ${"x".repeat(900)}`;
    const markdown = [
      "# Heading One",
      "",
      paragraph("first"),
      "",
      "## Heading Two",
      "",
      paragraph("second"),
      "",
      paragraph("third"),
    ].join("\n");

    const chunks = chunkNote(markdown);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.ix)).toEqual(chunks.map((_, i) => i));
    // Chunks are ordered: content appears in source order across the joined chunks.
    const joined = chunks.map((c) => c.text).join("\n\n");
    expect(joined.indexOf("first")).toBeLessThan(joined.indexOf("second"));
    expect(joined.indexOf("second")).toBeLessThan(joined.indexOf("third"));
  });

  it("still emits an oversized paragraph as its own chunk rather than dropping it", () => {
    const hugeParagraph = "y".repeat(5000);
    const markdown = `intro paragraph\n\n${hugeParagraph}\n\nouttro paragraph`;

    const chunks = chunkNote(markdown);

    const hugeChunk = chunks.find((c) => c.text.includes(hugeParagraph));
    expect(hugeChunk).toBeDefined();
  });

  it("never emits empty or whitespace-only chunks", () => {
    const markdown = "first paragraph\n\n\n\n   \n\n\nsecond paragraph\n\n\n";

    const chunks = chunkNote(markdown);

    for (const chunk of chunks) {
      expect(chunk.text.trim().length).toBeGreaterThan(0);
    }
  });

  it("drops a leading YAML frontmatter block from the embedded text", () => {
    const markdown = "---\ntitle: My Note\ntags: [a, b]\n---\n\nActual body content here.";

    const chunks = chunkNote(markdown);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).not.toContain("title:");
    expect(chunks[0].text).not.toContain("---");
    expect(chunks[0].text).toContain("Actual body content here.");
  });

  it("falls back to the raw markdown when frontmatter is malformed instead of throwing", () => {
    const markdown = "---\ntitle: [unterminated\n---\n\nBody text.";

    expect(() => chunkNote(markdown)).not.toThrow();
    const chunks = chunkNote(markdown);
    const joined = chunks.map((c) => c.text).join("\n\n");
    expect(joined).toContain("Body text.");
  });

  it("is deterministic across repeated calls", () => {
    const markdown = "# Title\n\nSome paragraph.\n\nAnother paragraph.";

    expect(chunkNote(markdown)).toEqual(chunkNote(markdown));
  });
});
