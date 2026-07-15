import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { TaskCheckboxWidget, taskCheckboxDecorations } from "./tasklist";
import { WIDGET_CLASS } from "./marks";

/** GFM task lists (`- [ ]`/`- [x]`) only parse as a `Task`/`TaskMarker` node
 *  when the markdown extension set includes GFM (verified live - see
 *  marks.ts's doc comment); plain `markdown()` never produces those nodes. */
function stateFor(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdown({ extensions: [GFM] })] });
}

/** A detached `EditorView` (no DOM parent needed, matching the pattern used
 *  by toolbar.test.ts) seeded with `doc`, for exercising the widget's click
 *  dispatch without a real browser. */
function viewFor(doc: string): EditorView {
  return new EditorView({ state: stateFor(doc) });
}

describe("taskCheckboxDecorations", () => {
  it("replaces an unchecked task marker with an unchecked checkbox widget", () => {
    const doc = "- [ ] todo";
    const state = stateFor(doc);

    const pieces = taskCheckboxDecorations(state, 0, doc.length);

    expect(pieces).toHaveLength(1);
    const [piece] = pieces;
    expect(piece.from).toBe(2);
    expect(piece.to).toBe(5);
    expect(doc.slice(2, 5)).toBe("[ ]");
    const widget = piece.decoration.spec.widget as TaskCheckboxWidget;
    expect(widget.checked).toBe(false);
  });

  it("replaces a checked task marker with a checked checkbox widget", () => {
    const doc = "- [x] done";
    const state = stateFor(doc);

    const pieces = taskCheckboxDecorations(state, 0, doc.length);

    expect(pieces).toHaveLength(1);
    const widget = pieces[0].decoration.spec.widget as TaskCheckboxWidget;
    expect(widget.checked).toBe(true);
    expect(doc.slice(pieces[0].from, pieces[0].to)).toBe("[x]");
  });

  it("leaves the document text untouched", () => {
    const doc = "- [ ] a\n- [x] b";
    const state = stateFor(doc);

    taskCheckboxDecorations(state, 0, doc.length);

    expect(state.doc.toString()).toBe("- [ ] a\n- [x] b");
  });
});

describe("TaskCheckboxWidget", () => {
  it("renders an <input type=checkbox>, unchecked for [ ]", () => {
    const view = viewFor("- [ ] todo");
    const widget = new TaskCheckboxWidget(false, 2, 5);

    const dom = widget.toDOM(view) as HTMLInputElement;

    expect(dom.tagName.toLowerCase()).toBe("input");
    expect(dom.type).toBe("checkbox");
    expect(dom.checked).toBe(false);
    expect(dom.className).toBe(WIDGET_CLASS.taskCheckbox);
  });

  it("renders checked for [x]", () => {
    const view = viewFor("- [x] done");
    const widget = new TaskCheckboxWidget(true, 2, 5);

    const dom = widget.toDOM(view) as HTMLInputElement;

    expect(dom.checked).toBe(true);
  });

  it("dispatches a source toggle from [ ] to [x] on click", () => {
    const view = viewFor("- [ ] todo");
    const widget = new TaskCheckboxWidget(false, 2, 5);
    const dom = widget.toDOM(view) as HTMLInputElement;

    dom.click();

    expect(view.state.doc.toString()).toBe("- [x] todo");
  });

  it("dispatches a source toggle from [x] to [ ] on click", () => {
    const view = viewFor("- [x] done");
    const widget = new TaskCheckboxWidget(true, 2, 5);
    const dom = widget.toDOM(view) as HTMLInputElement;

    dom.click();

    expect(view.state.doc.toString()).toBe("- [ ] done");
  });
});
