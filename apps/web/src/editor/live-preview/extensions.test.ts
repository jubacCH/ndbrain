import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { livePreviewExtensions, rawCompartment, setRawMode } from "./extensions";

/** `EditorView` needs a real `document` (from jsdom) to attach to and measure
 *  - `document.createElement("div")` is enough, it never has to be mounted
 *  into the actual DOM tree for `view.dom` to reflect decorated content. */
function mountView(doc: string): EditorView {
  return new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({
      doc,
      extensions: [markdown({ extensions: [GFM] }), rawCompartment.of(livePreviewExtensions())],
    }),
  });
}

describe("livePreviewExtensions / rawCompartment / setRawMode", () => {
  it("hides the bold markers in formatted (default, non-raw) mode", () => {
    const view = mountView("**x**");

    expect(view.dom.textContent).not.toContain("**");
    expect(view.dom.textContent).toContain("x");
    expect(view.state.doc.toString()).toBe("**x**");

    view.destroy();
  });

  it("shows the raw markers again once switched to raw mode, without touching the doc", () => {
    const view = mountView("**x**");

    setRawMode(view, true);

    expect(view.dom.textContent).toContain("**x**");
    expect(view.state.doc.toString()).toBe("**x**");

    view.destroy();
  });

  it("re-hides the markers when switched back to formatted mode", () => {
    const view = mountView("**x**");

    setRawMode(view, true);
    setRawMode(view, false);

    expect(view.dom.textContent).not.toContain("**");
    expect(view.dom.textContent).toContain("x");
    expect(view.state.doc.toString()).toBe("**x**");

    view.destroy();
  });
});
