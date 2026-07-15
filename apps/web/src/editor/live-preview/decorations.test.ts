import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { Strikethrough } from "@lezer/markdown";
import { buildDecorations } from "./decorations";
import { BLOCK_LINE_CLASS, MARK_CLASS, WIDGET_CLASS, headingLineClass } from "./marks";

/** Markdown extension used by these tests. Plain `markdown()` only parses
 *  CommonMark - `~~strike~~` is a GFM extension of `@lezer/markdown` and
 *  needs to be enabled explicitly, or its `Strikethrough` node never appears
 *  in the syntax tree at all (verified live against @lezer/markdown@1.7.1). */
const markdownWithGfm = markdown({ extensions: [Strikethrough] });

/** Block constructs (headings, lists, quotes, rules) are plain CommonMark -
 *  no GFM extension needed to parse them. */
const markdownPlain = markdown();

interface DecoRecord {
  from: number;
  to: number;
  /** The decoration's CSS class for a mark or line decoration, or undefined
   *  for a marker-hiding replace. */
  class: string | undefined;
  isReplace: boolean;
  /** True for `Decoration.line` (a zero-width point at the line start). */
  isLine: boolean;
  /** For a widget-backed replace, the rendered widget's tag/class/text. */
  widget: { tag: string; class: string; text: string } | undefined;
}

function stateFor(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdownWithGfm] });
}

function plainStateFor(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdownPlain] });
}

/** Flattens a DecorationSet into plain records sorted by position.
 *  `RangeSet.between` doesn't guarantee simple from-ascending callback order
 *  once ranges nest across its internal layers (verified live), so results
 *  are normalized here for deterministic assertions - the actual DOM/view
 *  rendering CodeMirror does from a DecorationSet is unaffected by that. */
function collect(set: DecorationSet, docLength: number): DecoRecord[] {
  const records: DecoRecord[] = [];
  set.between(0, docLength, (from, to, deco) => {
    const widget = deco.spec.widget;
    records.push({
      from,
      to,
      class: deco.spec.class,
      isReplace: deco.spec.widget === undefined && deco.spec.class === undefined,
      isLine: from === to && deco.spec.class !== undefined,
      widget: widget
        ? {
            tag: widget.toDOM().tagName.toLowerCase(),
            class: widget.toDOM().className,
            text: widget.toDOM().textContent ?? "",
          }
        : undefined,
    });
  });
  return records.sort((a, b) => a.from - b.from || a.to - b.to);
}

describe("buildDecorations", () => {
  it("hides the two ** markers and marks the content as bold, without changing the doc", () => {
    const doc = "**bold**";
    const state = stateFor(doc);

    const decorations = buildDecorations(state, [{ from: 0, to: doc.length }]);
    const records = collect(decorations, doc.length);

    expect(records).toEqual([
      { from: 0, to: 2, class: undefined, isReplace: true, isLine: false },
      { from: 2, to: 6, class: MARK_CLASS.bold, isReplace: false, isLine: false },
      { from: 6, to: 8, class: undefined, isReplace: true, isLine: false },
    ]);
    expect(doc.slice(0, 2)).toBe("**");
    expect(doc.slice(2, 6)).toBe("bold");
    expect(doc.slice(6, 8)).toBe("**");
    expect(state.doc.toString()).toBe("**bold**");
  });

  it("hides the two * markers and marks the content as italic", () => {
    const doc = "*i*";
    const state = stateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      { from: 0, to: 1, class: undefined, isReplace: true, isLine: false },
      { from: 1, to: 2, class: MARK_CLASS.italic, isReplace: false, isLine: false },
      { from: 2, to: 3, class: undefined, isReplace: true, isLine: false },
    ]);
    expect(state.doc.toString()).toBe("*i*");
  });

  it("hides the two ~~ markers and marks the content as strikethrough", () => {
    const doc = "~~s~~";
    const state = stateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      { from: 0, to: 2, class: undefined, isReplace: true, isLine: false },
      { from: 2, to: 3, class: MARK_CLASS.strike, isReplace: false, isLine: false },
      { from: 3, to: 5, class: undefined, isReplace: true, isLine: false },
    ]);
    expect(state.doc.toString()).toBe("~~s~~");
  });

  it("hides the two ` markers and marks the content as inline code", () => {
    const doc = "`c`";
    const state = stateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      { from: 0, to: 1, class: undefined, isReplace: true, isLine: false },
      { from: 1, to: 2, class: MARK_CLASS.inlineCode, isReplace: false, isLine: false },
      { from: 2, to: 3, class: undefined, isReplace: true, isLine: false },
    ]);
    expect(state.doc.toString()).toBe("`c`");
  });

  it("nests bold over the whole span and italic over just the nested content", () => {
    const doc = "**a *b* c**";
    const state = stateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      { from: 0, to: 2, class: undefined, isReplace: true, isLine: false },
      { from: 2, to: 9, class: MARK_CLASS.bold, isReplace: false, isLine: false },
      { from: 4, to: 5, class: undefined, isReplace: true, isLine: false },
      { from: 5, to: 6, class: MARK_CLASS.italic, isReplace: false, isLine: false },
      { from: 6, to: 7, class: undefined, isReplace: true, isLine: false },
      { from: 9, to: 11, class: undefined, isReplace: true, isLine: false },
    ]);
    expect(doc.slice(2, 9)).toBe("a *b* c");
    expect(doc.slice(5, 6)).toBe("b");
    expect(state.doc.toString()).toBe("**a *b* c**");
  });

  it("only decorates nodes overlapping the given ranges", () => {
    const doc = "**bold** *i*";
    const state = stateFor(doc);

    // Restrict to the italic span only (from the space before it onward).
    const records = collect(buildDecorations(state, [{ from: 9, to: doc.length }]), doc.length);

    expect(records).toEqual([
      { from: 9, to: 10, class: undefined, isReplace: true, isLine: false },
      { from: 10, to: 11, class: MARK_CLASS.italic, isReplace: false, isLine: false },
      { from: 11, to: 12, class: undefined, isReplace: true, isLine: false },
    ]);
  });
});

describe("buildDecorations - block constructs", () => {
  it("hides the # marker and its trailing space, and lines the heading as h1", () => {
    const doc = "# Titel";
    const state = plainStateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      { from: 0, to: 0, class: headingLineClass(1), isReplace: false, isLine: true, widget: undefined },
      { from: 0, to: 2, class: undefined, isReplace: true, isLine: false },
    ]);
    expect(state.doc.toString()).toBe("# Titel");
  });

  it("hides the ###### marker and lines the heading as h6", () => {
    const doc = "###### h6";
    const state = plainStateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      { from: 0, to: 0, class: headingLineClass(6), isReplace: false, isLine: true, widget: undefined },
      { from: 0, to: 7, class: undefined, isReplace: true, isLine: false },
    ]);
    expect(state.doc.toString()).toBe("###### h6");
  });

  it("hides the > marker and its trailing space, and lines the paragraph as a quote", () => {
    const doc = "> zitat";
    const state = plainStateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      { from: 0, to: 0, class: BLOCK_LINE_CLASS.quote, isReplace: false, isLine: true, widget: undefined },
      { from: 0, to: 2, class: undefined, isReplace: true, isLine: false },
    ]);
    expect(state.doc.toString()).toBe("> zitat");
  });

  it("replaces the - marker of a bullet list item with a widget, item text untouched", () => {
    const doc = "- item";
    const state = plainStateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      {
        from: 0,
        to: 1,
        class: undefined,
        isReplace: false,
        isLine: false,
        widget: { tag: "span", class: WIDGET_CLASS.listMarker, text: "•" },
      },
    ]);
    expect(doc.slice(2)).toBe("item");
    expect(state.doc.toString()).toBe("- item");
  });

  it("replaces the 1. marker of an ordered list item with a widget, preserving the number", () => {
    const doc = "1. item";
    const state = plainStateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      {
        from: 0,
        to: 2,
        class: undefined,
        isReplace: false,
        isLine: false,
        widget: { tag: "span", class: WIDGET_CLASS.listMarker, text: "1." },
      },
    ]);
    expect(doc.slice(3)).toBe("item");
    expect(state.doc.toString()).toBe("1. item");
  });

  it("replaces a horizontal rule line with an <hr> widget", () => {
    const doc = "---";
    const state = plainStateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      {
        from: 0,
        to: 3,
        class: undefined,
        isReplace: false,
        isLine: false,
        widget: { tag: "hr", class: WIDGET_CLASS.hr, text: "" },
      },
    ]);
    expect(state.doc.toString()).toBe("---");
  });
});
