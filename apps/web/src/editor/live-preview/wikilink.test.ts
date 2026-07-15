import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { wikilinkDecorations } from "./wikilink";
import { MARK_CLASS } from "./marks";

/** Wikilinks aren't a `@lezer/markdown` node at all (verified live - see
 *  marks.ts's doc comment), so any markdown extension set works here; plain
 *  `markdown()` is enough to exercise the InlineCode exclusion. */
function stateFor(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdown()] });
}

interface PieceRecord {
  from: number;
  to: number;
  class: string | undefined;
  target: string | undefined;
  isReplace: boolean;
}

function collect(state: EditorState, from: number, to: number): PieceRecord[] {
  return wikilinkDecorations(state, from, to)
    .map((piece) => ({
      from: piece.from,
      to: piece.to,
      class: piece.decoration.spec.class,
      target: piece.decoration.spec.attributes?.["data-target"],
      isReplace: piece.decoration.spec.class === undefined,
    }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
}

describe("wikilinkDecorations", () => {
  it("hides the [[ ]] brackets and marks the target as a wikilink", () => {
    const doc = "[[Project Overview]]";
    const state = stateFor(doc);

    const records = collect(state, 0, doc.length);

    expect(records).toEqual([
      { from: 0, to: 2, class: undefined, target: undefined, isReplace: true },
      { from: 2, to: 18, class: MARK_CLASS.wikilink, target: "Project Overview", isReplace: false },
      { from: 18, to: 20, class: undefined, target: undefined, isReplace: true },
    ]);
    expect(doc.slice(2, 18)).toBe("Project Overview");
    expect(state.doc.toString()).toBe("[[Project Overview]]");
  });

  it("shows the alias and hides the target and | prefix for [[Target|Alias]]", () => {
    const doc = "[[A|B]]";
    const state = stateFor(doc);

    const records = collect(state, 0, doc.length);

    expect(records).toEqual([
      { from: 0, to: 2, class: undefined, target: undefined, isReplace: true },
      { from: 2, to: 4, class: undefined, target: undefined, isReplace: true },
      { from: 4, to: 5, class: MARK_CLASS.wikilink, target: "A", isReplace: false },
      { from: 5, to: 7, class: undefined, target: undefined, isReplace: true },
    ]);
    expect(doc.slice(4, 5)).toBe("B");
    expect(state.doc.toString()).toBe("[[A|B]]");
  });

  it("does not decorate a wikilink-looking pattern inside inline code", () => {
    const doc = "`[[x]]`";
    const state = stateFor(doc);

    const records = collect(state, 0, doc.length);

    expect(records).toEqual([]);
  });

  it("does not match a [[ ]] pair that spans a line break", () => {
    const doc = "[[foo\nbar]]";
    const state = stateFor(doc);

    const records = collect(state, 0, doc.length);

    expect(records).toEqual([]);
  });

  it("still matches a real wikilink on the line after an unterminated [[ on a previous line", () => {
    const doc = "[[dangling\n[[Note]]";
    const state = stateFor(doc);

    const records = collect(state, 0, doc.length);
    const target = doc.indexOf("[[Note]]");

    expect(records).toEqual([
      { from: target, to: target + 2, class: undefined, target: undefined, isReplace: true },
      { from: target + 2, to: target + 6, class: MARK_CLASS.wikilink, target: "Note", isReplace: false },
      { from: target + 6, to: target + 8, class: undefined, target: undefined, isReplace: true },
    ]);
  });

  it("decorates a real wikilink following inline code in the same range", () => {
    const doc = "`c` [[Note]]";
    const state = stateFor(doc);

    const records = collect(state, 0, doc.length);

    expect(records).toEqual([
      { from: 4, to: 6, class: undefined, target: undefined, isReplace: true },
      { from: 6, to: 10, class: MARK_CLASS.wikilink, target: "Note", isReplace: false },
      { from: 10, to: 12, class: undefined, target: undefined, isReplace: true },
    ]);
  });
});
