import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { LocalEditor, localEditorExtensions } from "./LocalEditor";

/** Render smoke + change-wiring test for the local (non-collab) editor: a
 *  real CodeMirror `EditorView` over a plain string, no `Y.Doc`, no
 *  `yCollab`, no provider of any kind — see `LocalEditor.tsx`'s doc comment
 *  for why this is a distinct component from the collaborative `<Editor>`. */
describe("<LocalEditor>", () => {
  afterEach(() => {
    cleanup();
  });

  it("mounts a CodeMirror view seeded from the given content, without crashing", async () => {
    render(<LocalEditor path="a.md" content="# Hello local" onChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("local-editor-host").querySelector(".cm-editor")).toBeInTheDocument();
    });
    expect(screen.getByTestId("local-editor-host").textContent).toContain("Hello local");
  });

  it("recreates the editor (discarding unsaved in-view state) when path changes, seeded from the new content", async () => {
    const { rerender } = render(<LocalEditor path="a.md" content="first note" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("local-editor-host").textContent).toContain("first note"));

    rerender(<LocalEditor path="b.md" content="second note" onChange={() => {}} />);

    await waitFor(() => expect(screen.getByTestId("local-editor-host").textContent).toContain("second note"));
    expect(screen.getByTestId("local-editor-host").textContent).not.toContain("first note");
  });

  it("destroys the CodeMirror view on unmount without throwing", async () => {
    const { unmount } = render(<LocalEditor path="a.md" content="x" onChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("local-editor-host").querySelector(".cm-editor")).toBeInTheDocument();
    });

    expect(() => unmount()).not.toThrow();
  });
});

/** `localEditorExtensions` is the piece of `LocalEditor.tsx` that actually
 *  wires doc changes to `onChange` — tested directly against a detached
 *  (unmounted) `EditorView`/`EditorState` rather than by simulating real
 *  keystrokes through jsdom's contentEditable, which CodeMirror 6 drives via
 *  DOM mutation observation that jsdom does not faithfully reproduce. */
describe("localEditorExtensions", () => {
  it("calls onChange with the full updated document text on every doc change", () => {
    const onChange = vi.fn();
    const state = EditorState.create({ doc: "hello", extensions: localEditorExtensions(onChange) });
    const view = new EditorView({ state });

    view.dispatch({ changes: { from: 5, insert: "!" } });

    expect(onChange).toHaveBeenCalledWith("hello!");
    view.destroy();
  });

  it("does not call onChange for a transaction with no document change (e.g. selection-only)", () => {
    const onChange = vi.fn();
    const state = EditorState.create({ doc: "hello", extensions: localEditorExtensions(onChange) });
    const view = new EditorView({ state });

    view.dispatch({ selection: { anchor: 1 } });

    expect(onChange).not.toHaveBeenCalled();
    view.destroy();
  });
});
