import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { syntaxTree } from "@codemirror/language";
import { applyMermaidEdit, mermaidEditorHandler, openMermaidEditor, type MermaidEditRequest } from "./mermaidEditor";

describe("mermaidEditorHandler facet", () => {
  it("resolves to a no-op when no provider extension is present", () => {
    const state = EditorState.create({ doc: "x" });

    expect(() => openMermaidEditor(state, { code: "graph TD", from: 0, to: 1 })).not.toThrow();
  });

  it("resolves to the handler an extension provides", () => {
    const handler = vi.fn();
    const state = EditorState.create({ doc: "x", extensions: [mermaidEditorHandler.of(handler)] });
    const request: MermaidEditRequest = { code: "graph TD\nA-->B", from: 0, to: 1 };

    openMermaidEditor(state, request);

    expect(handler).toHaveBeenCalledWith(request);
  });

  it("the last of multiple provider extensions wins (single active editor instance)", () => {
    const first = vi.fn();
    const last = vi.fn();
    const state = EditorState.create({
      doc: "x",
      extensions: [mermaidEditorHandler.of(first), mermaidEditorHandler.of(last)],
    });

    openMermaidEditor(state, { code: "graph TD", from: 0, to: 1 });

    expect(last).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});

/** Locates the `CodeText` range of the (single, first) ```mermaid fence in
 *  `doc`, exactly the way `decorations.ts` does when constructing a
 *  `MermaidWidget` - so these tests exercise the real offsets a click would
 *  actually carry, not hand-picked numbers. */
function mermaidCodeTextRange(doc: string): { from: number; to: number } {
  const state = EditorState.create({ doc, extensions: [markdown({ extensions: [GFM] })] });
  let range: { from: number; to: number } | undefined;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") return;
      const info = node.node.getChild("CodeInfo");
      if (!info || state.doc.sliceString(info.from, info.to) !== "mermaid") return;
      const codeText = node.node.getChild("CodeText");
      if (codeText) range = { from: codeText.from, to: codeText.to };
    },
  });
  if (!range) throw new Error("no mermaid CodeText found in fixture doc");
  return range;
}

describe("applyMermaidEdit", () => {
  it("replaces exactly the CodeText range, leaving the fence markers and surrounding text untouched", () => {
    const doc = "before\n\n```mermaid\ngraph TD\nA-->B\n```\n\nafter";
    const { from, to } = mermaidCodeTextRange(doc);
    const view = new EditorView({ state: EditorState.create({ doc }) });

    applyMermaidEdit(view, { code: doc.slice(from, to), from, to }, "graph LR\nX-->Y-->Z");

    expect(view.state.doc.toString()).toBe(
      "before\n\n```mermaid\ngraph LR\nX-->Y-->Z\n```\n\nafter",
    );
    view.destroy();
  });

  it("correctly shrinks/grows surrounding positions when the new code is a different length", () => {
    const doc = "```mermaid\ngraph TD\nA-->B\n```\nafter";
    const { from, to } = mermaidCodeTextRange(doc);
    const afterMarkerPos = doc.indexOf("after");
    const view = new EditorView({ state: EditorState.create({ doc }) });

    applyMermaidEdit(view, { code: doc.slice(from, to), from, to }, "x");

    const newDoc = view.state.doc.toString();
    expect(newDoc).toBe("```mermaid\nx\n```\nafter");
    // "after" is still intact and reachable, just shifted to a new offset -
    // proving no fence marker got corrupted by the length change.
    expect(newDoc.slice(newDoc.indexOf("after"))).toBe("after");
    expect(newDoc.indexOf("after")).not.toBe(afterMarkerPos);
    view.destroy();
  });
});
