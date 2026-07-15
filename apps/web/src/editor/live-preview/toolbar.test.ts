import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { syntaxTree } from "@codemirror/language";
import {
  formatKeymap,
  insertLink,
  insertMermaid,
  setHeading,
  toggleBold,
  toggleBulletList,
  toggleInlineCode,
  toggleItalic,
  toggleStrike,
} from "./toolbar";

/** A detached `EditorView` (no DOM parent needed) seeded with `doc` and a
 *  selection over `[from, to)` - matches the pattern the Task 4-6 tests use
 *  for exercising CodeMirror commands without a real browser. */
function viewFor(doc: string, from: number, to = from): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: from, head: to },
    }),
  });
}

/** Finds the `CodeText` range of the (single, first) ```mermaid fence in
 *  `doc` by actually parsing it with the same markdown grammar the live
 *  editor uses - the same pattern `mermaidEditor.test.ts` uses to get real
 *  parser-verified offsets rather than hand-picked numbers. Returns
 *  `undefined` if no such fence parses out of the doc at all (i.e. the
 *  fence is broken/unterminated). */
function mermaidCodeTextRange(doc: string): { from: number; to: number } | undefined {
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
  return range;
}

describe("toggleBold", () => {
  it("wraps a selection with ** and keeps it selecting the same text", () => {
    const view = viewFor("x", 0, 1);

    toggleBold(view);

    expect(view.state.doc.toString()).toBe("**x**");
    expect(view.state.selection.main.from).toBe(2);
    expect(view.state.selection.main.to).toBe(3);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("x");
  });

  it("unwraps an already-bold selection back to the plain text", () => {
    const view = viewFor("**x**", 2, 3);

    toggleBold(view);

    expect(view.state.doc.toString()).toBe("x");
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(1);
  });

  it("inserts an empty **** pair with the cursor centered for an empty selection", () => {
    const view = viewFor("", 0);

    toggleBold(view);

    expect(view.state.doc.toString()).toBe("****");
    expect(view.state.selection.main.from).toBe(2);
    expect(view.state.selection.main.to).toBe(2);
  });
});

describe("toggleItalic", () => {
  it("wraps with single *", () => {
    const view = viewFor("i", 0, 1);
    toggleItalic(view);
    expect(view.state.doc.toString()).toBe("*i*");
  });

  it("unwraps", () => {
    const view = viewFor("*i*", 1, 2);
    toggleItalic(view);
    expect(view.state.doc.toString()).toBe("i");
  });

  it("stacks onto an already-bold selection instead of stripping a bold marker", () => {
    const view = viewFor("**x**", 2, 3);

    toggleItalic(view);

    expect(view.state.doc.toString()).toBe("***x***");
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("x");
  });
});

describe("toggleStrike", () => {
  it("wraps with ~~", () => {
    const view = viewFor("s", 0, 1);
    toggleStrike(view);
    expect(view.state.doc.toString()).toBe("~~s~~");
  });

  it("unwraps", () => {
    const view = viewFor("~~s~~", 2, 3);
    toggleStrike(view);
    expect(view.state.doc.toString()).toBe("s");
  });
});

describe("toggleInlineCode", () => {
  it("wraps with a single backtick", () => {
    const view = viewFor("c", 0, 1);
    toggleInlineCode(view);
    expect(view.state.doc.toString()).toBe("`c`");
  });

  it("unwraps", () => {
    const view = viewFor("`c`", 1, 2);
    toggleInlineCode(view);
    expect(view.state.doc.toString()).toBe("c");
  });
});

describe("setHeading", () => {
  it("prefixes the current line with level # markers and a space", () => {
    const view = viewFor("Title", 0);

    setHeading(view, 2);

    expect(view.state.doc.toString()).toBe("## Title");
  });

  it("replaces an existing heading marker with a different level", () => {
    const view = viewFor("# Title", 3);

    setHeading(view, 3);

    expect(view.state.doc.toString()).toBe("### Title");
  });

  it("removes the marker entirely when the same level is set again (toggle off)", () => {
    const view = viewFor("## Title", 3);

    setHeading(view, 2);

    expect(view.state.doc.toString()).toBe("Title");
  });

  it("doesn't drag the anchor onto the head's line when the selection spans two lines", () => {
    // anchor(1) sits inside "abc" on line 1, head(5) sits inside "def" on
    // line 2 - setHeading only ever edits the HEAD's line, so the anchor
    // (on an untouched earlier line) must stay exactly where it was.
    const view = viewFor("abc\ndef", 1, 5);

    setHeading(view, 2);

    expect(view.state.doc.toString()).toBe("abc\n## def");
    expect(view.state.selection.main.anchor).toBe(1);
    expect(view.state.selection.main.head).toBe(8); // 5 + "## ".length
  });
});

describe("toggleBulletList", () => {
  it("prefixes the selected line with '- '", () => {
    const view = viewFor("item", 0);

    toggleBulletList(view);

    expect(view.state.doc.toString()).toBe("- item");
  });

  it("removes the '- ' prefix when already a bullet", () => {
    const view = viewFor("- item", 4);

    toggleBulletList(view);

    expect(view.state.doc.toString()).toBe("item");
  });

  it("prefixes every line spanned by a multi-line selection", () => {
    const doc = "a\nb\nc";
    const view = viewFor(doc, 0, doc.length);

    toggleBulletList(view);

    expect(view.state.doc.toString()).toBe("- a\n- b\n- c");
  });

  it("doesn't bullet a trailing line when the selection ends exactly at its start (whole-line selection)", () => {
    const doc = "line1\nline2\nline3";
    // Selects from the start of line1 up to (but not into) the start of
    // line2 - the usual shape of a "select the whole first line" drag.
    const view = viewFor(doc, 0, 6);

    toggleBulletList(view);

    expect(view.state.doc.toString()).toBe("- line1\nline2\nline3");
  });

  it("still bullets a fully-selected second line when the selection ends mid-line, not at its start", () => {
    const doc = "line1\nline2\nline3";
    const view = viewFor(doc, 0, 11); // ends inside line2, not at line3's start

    toggleBulletList(view);

    expect(view.state.doc.toString()).toBe("- line1\n- line2\nline3");
  });
});

describe("insertLink", () => {
  it("inserts a [text](url) placeholder for an empty selection", () => {
    const view = viewFor("", 0);

    insertLink(view);

    expect(view.state.doc.toString()).toBe("[text](url)");
  });

  it("wraps a non-empty selection as [selection](url)", () => {
    const view = viewFor("ndBrain", 0, 7);

    insertLink(view);

    expect(view.state.doc.toString()).toBe("[ndBrain](url)");
  });
});

describe("insertMermaid", () => {
  it("inserts a valid mermaid fence skeleton into an empty doc, unpadded", () => {
    const view = viewFor("", 0);

    insertMermaid(view);

    const doc = view.state.doc.toString();
    expect(doc.startsWith("```mermaid\n")).toBe(true);
    expect(doc).toContain("graph TD");
    expect(doc).toContain("A --> B");
    expect(doc.endsWith("```")).toBe(true);
    expect(mermaidCodeTextRange(doc)).toBeDefined();
  });

  it("pads with newlines when the cursor is mid-line, so 'hello' and 'world' stay outside the fence", () => {
    const view = viewFor("helloworld", 5);

    insertMermaid(view);

    const doc = view.state.doc.toString();
    const range = mermaidCodeTextRange(doc);
    expect(range).toBeDefined(); // a valid, closed FencedCode actually parses out
    expect(doc.startsWith("hello")).toBe(true);
    expect(doc.endsWith("world")).toBe(true);
    expect(doc).toContain("hello\n\n```mermaid\n");
    expect(doc).toContain("```\nworld");
  });

  it("pads with a trailing newline when the cursor is at the start of a non-empty line, so the closing fence doesn't swallow the rest of the line", () => {
    const view = viewFor("rest of the note", 0);

    insertMermaid(view);

    const doc = view.state.doc.toString();
    const range = mermaidCodeTextRange(doc);
    expect(range).toBeDefined();
    expect(doc.startsWith("```mermaid\n")).toBe(true);
    // the closing fence is on its OWN line - "rest of the note" starts a new
    // line right after it, it isn't glued onto the closing "```"
    expect(doc).toContain("```\nrest of the note");
    expect(doc.endsWith("rest of the note")).toBe(true);
  });

  it("does not pad when inserting into an empty line surrounded by other content", () => {
    // "before\n\n\n\nafter" has an empty line 2 (position 7) sitting between
    // "before" and two more empty lines before "after" - inserting right on
    // that empty line needs no extra padding, same as the plain empty-doc
    // case.
    const view = viewFor("before\n\n\n\nafter", 7);

    insertMermaid(view);

    const doc = view.state.doc.toString();
    const range = mermaidCodeTextRange(doc);
    expect(range).toBeDefined();
    expect(doc.startsWith("before\n```mermaid\n")).toBe(true);
    expect(doc.endsWith("```\n\n\nafter")).toBe(true);
  });

  it("replaces a non-empty selection and still pads based on what surrounds it", () => {
    const view = viewFor("keepSELECTEDkeep", 4, 12);

    insertMermaid(view);

    const doc = view.state.doc.toString();
    const range = mermaidCodeTextRange(doc);
    expect(range).toBeDefined();
    expect(doc.startsWith("keep")).toBe(true);
    expect(doc.endsWith("keep")).toBe(true);
    expect(doc).not.toContain("SELECTED");
  });
});

describe("formatKeymap", () => {
  it("binds Mod-b, Mod-i and Mod-e", () => {
    const keys = formatKeymap.map((binding) => binding.key);
    expect(keys).toContain("Mod-b");
    expect(keys).toContain("Mod-i");
    expect(keys).toContain("Mod-e");
  });

  it("Mod-b binding invokes toggleBold on the given view", () => {
    const view = viewFor("x", 0, 1);
    const binding = formatKeymap.find((b) => b.key === "Mod-b")!;

    const handled = binding.run!(view);

    expect(handled).toBe(true);
    expect(view.state.doc.toString()).toBe("**x**");
  });
});
