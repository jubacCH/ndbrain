import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
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
  it("inserts a valid mermaid fence skeleton", () => {
    const view = viewFor("", 0);

    insertMermaid(view);

    const doc = view.state.doc.toString();
    expect(doc.startsWith("```mermaid\n")).toBe(true);
    expect(doc).toContain("graph TD");
    expect(doc).toContain("A --> B");
    expect(doc.endsWith("```")).toBe(true);
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
