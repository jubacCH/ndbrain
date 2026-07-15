import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { Strikethrough } from "@lezer/markdown";
import { buildDecorations } from "./decorations";
import { MARK_CLASS } from "./marks";

/** Markdown extension used by these tests. Plain `markdown()` only parses
 *  CommonMark - `~~strike~~` is a GFM extension of `@lezer/markdown` and
 *  needs to be enabled explicitly, or its `Strikethrough` node never appears
 *  in the syntax tree at all (verified live against @lezer/markdown@1.7.1). */
const markdownWithGfm = markdown({ extensions: [Strikethrough] });

interface DecoRecord {
  from: number;
  to: number;
  /** The decoration's CSS class for a mark, or undefined for a replace (hide). */
  class: string | undefined;
  isReplace: boolean;
}

function stateFor(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdownWithGfm] });
}

/** Flattens a DecorationSet into plain records sorted by position.
 *  `RangeSet.between` doesn't guarantee simple from-ascending callback order
 *  once ranges nest across its internal layers (verified live), so results
 *  are normalized here for deterministic assertions - the actual DOM/view
 *  rendering CodeMirror does from a DecorationSet is unaffected by that. */
function collect(set: DecorationSet, docLength: number): DecoRecord[] {
  const records: DecoRecord[] = [];
  set.between(0, docLength, (from, to, deco) => {
    records.push({
      from,
      to,
      class: deco.spec.class,
      isReplace: deco.spec.widget === undefined && deco.spec.class === undefined,
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
      { from: 0, to: 2, class: undefined, isReplace: true },
      { from: 2, to: 6, class: MARK_CLASS.bold, isReplace: false },
      { from: 6, to: 8, class: undefined, isReplace: true },
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
      { from: 0, to: 1, class: undefined, isReplace: true },
      { from: 1, to: 2, class: MARK_CLASS.italic, isReplace: false },
      { from: 2, to: 3, class: undefined, isReplace: true },
    ]);
    expect(state.doc.toString()).toBe("*i*");
  });

  it("hides the two ~~ markers and marks the content as strikethrough", () => {
    const doc = "~~s~~";
    const state = stateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      { from: 0, to: 2, class: undefined, isReplace: true },
      { from: 2, to: 3, class: MARK_CLASS.strike, isReplace: false },
      { from: 3, to: 5, class: undefined, isReplace: true },
    ]);
    expect(state.doc.toString()).toBe("~~s~~");
  });

  it("hides the two ` markers and marks the content as inline code", () => {
    const doc = "`c`";
    const state = stateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      { from: 0, to: 1, class: undefined, isReplace: true },
      { from: 1, to: 2, class: MARK_CLASS.inlineCode, isReplace: false },
      { from: 2, to: 3, class: undefined, isReplace: true },
    ]);
    expect(state.doc.toString()).toBe("`c`");
  });

  it("nests bold over the whole span and italic over just the nested content", () => {
    const doc = "**a *b* c**";
    const state = stateFor(doc);

    const records = collect(buildDecorations(state, [{ from: 0, to: doc.length }]), doc.length);

    expect(records).toEqual([
      { from: 0, to: 2, class: undefined, isReplace: true },
      { from: 2, to: 9, class: MARK_CLASS.bold, isReplace: false },
      { from: 4, to: 5, class: undefined, isReplace: true },
      { from: 5, to: 6, class: MARK_CLASS.italic, isReplace: false },
      { from: 6, to: 7, class: undefined, isReplace: true },
      { from: 9, to: 11, class: undefined, isReplace: true },
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
      { from: 9, to: 10, class: undefined, isReplace: true },
      { from: 10, to: 11, class: MARK_CLASS.italic, isReplace: false },
      { from: 11, to: 12, class: undefined, isReplace: true },
    ]);
  });
});
