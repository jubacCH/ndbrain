import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyExternalChange, readMarkdown, seedYText } from "./serialize.js";

describe("seedYText", () => {
  it("inserts the markdown into an empty Y.Text", () => {
    const ytext = new Y.Doc().getText("content");
    seedYText(ytext, "# Title\n\nBody text.");
    expect(ytext.toString()).toBe("# Title\n\nBody text.");
  });

  it("is a true no-op when the Y.Text already equals the markdown (no ops applied)", () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, "unchanged");

    const before = Y.encodeStateAsUpdate(ydoc);
    seedYText(ytext, "unchanged");
    const after = Y.encodeStateAsUpdate(ydoc);

    expect(ytext.toString()).toBe("unchanged");
    expect(after).toEqual(before);
  });

  it("rebases via the same minimal prefix/suffix replace as applyExternalChange when the Y.Text already has differing content", () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, "hello world");

    const worldStart = "hello ".length;
    const relPos = Y.createRelativePositionFromTypeIndex(ytext, worldStart);

    seedYText(ytext, "hello brave world");

    const absPos = Y.createAbsolutePositionFromRelativePosition(relPos, ydoc);
    expect(ytext.toString()).toBe("hello brave world");
    expect(absPos).not.toBeNull();
    expect(absPos?.index).toBe("hello brave ".length);
  });
});

describe("readMarkdown", () => {
  it("round-trips whatever is currently in the Y.Text", () => {
    const ytext = new Y.Doc().getText("content");
    ytext.insert(0, "roundtrip me");
    expect(readMarkdown(ytext)).toBe("roundtrip me");
  });
});

describe("applyExternalChange", () => {
  it("is a true no-op when newMarkdown already matches (no ops applied)", () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, "steady state");

    const before = Y.encodeStateAsUpdate(ydoc);
    applyExternalChange(ydoc, ytext, "steady state");
    const after = Y.encodeStateAsUpdate(ydoc);

    expect(ytext.toString()).toBe("steady state");
    expect(after).toEqual(before);
  });

  it("seeds an empty Y.Text", () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");

    applyExternalChange(ydoc, ytext, "brand new content");

    expect(readMarkdown(ytext)).toBe("brand new content");
  });

  it("clears a Y.Text down to empty", () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, "to be cleared");

    applyExternalChange(ydoc, ytext, "");

    expect(readMarkdown(ytext)).toBe("");
  });

  it("replaces only a middle segment, leaving prefix and suffix untouched", () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, "start MIDDLE end");

    applyExternalChange(ydoc, ytext, "start replaced end");

    expect(readMarkdown(ytext)).toBe("start replaced end");
  });

  it("performs a pure insert as a single insert op and preserves a relative position anchored right before the unchanged tail", () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, "hello world");

    // Anchor a relative position right before "world" BEFORE the change.
    const worldStart = "hello ".length;
    const relPos = Y.createRelativePositionFromTypeIndex(ytext, worldStart);

    applyExternalChange(ydoc, ytext, "hello brave world");

    // If the tail ("world") had been blindly deleted and reinserted, the
    // relative position anchored to the original item would no longer
    // resolve to the same logical spot. Because only " brave" was inserted
    // in the middle, the original "world" item is untouched, so the
    // relative position must still resolve right before it.
    const absPos = Y.createAbsolutePositionFromRelativePosition(relPos, ydoc);
    expect(readMarkdown(ytext)).toBe("hello brave world");
    expect(absPos).not.toBeNull();
    expect(absPos?.type).toBe(ytext);
    expect(absPos?.index).toBe("hello brave ".length);
  });

  it("clamps prefix+suffix so they never overlap on repeated-character growth (old shorter, all-matching chars)", () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, "aa");

    // Naive unbounded prefix/suffix scans would each greedily match both
    // characters (since every char is "a"), double-counting them and
    // producing a negative delete count / corrupt slice. The clamp
    // (prefixLen + suffixLen <= min(oldLen, newLen)) must prevent that.
    applyExternalChange(ydoc, ytext, "aaa");

    expect(readMarkdown(ytext)).toBe("aaa");
  });

  it("clamps prefix+suffix so they never overlap on repeated-character shrink (new shorter, all-matching chars)", () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, "aaaa");

    applyExternalChange(ydoc, ytext, "aa");

    expect(readMarkdown(ytext)).toBe("aa");
  });
});
