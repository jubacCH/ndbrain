import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { LocalEditor, localEditorExtensions } from "./LocalEditor";

// Real `mermaid` is a large dependency lazily loaded on first render (see
// `live-preview/mermaid.ts`) - stubbed here so the split-panel integration
// test below (clicking a rendered diagram) never touches it for real.
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg>diagram</svg>" }),
  },
}));

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

  it("renders live-preview formatted by default and shows raw markdown source once toggled (Plan 7 Task 4)", async () => {
    const onChange = vi.fn();
    render(<LocalEditor path="a.md" content="**bold**" onChange={onChange} />);

    const host = await waitFor(() => screen.getByTestId("local-editor-host"));
    await waitFor(() => expect(host.querySelector(".cm-editor")).toBeInTheDocument());

    // Formatted (default): the `**` markers are hidden, only "bold" shows.
    expect(host.textContent).not.toContain("**");
    expect(host.textContent).toContain("bold");

    fireEvent.click(screen.getByRole("button", { name: "Formatiert" }));

    // Raw: the exact markdown source is visible again; onChange never fires
    // from a mode toggle (it only touches decorations, not the doc).
    await waitFor(() => expect(host.textContent).toContain("**bold**"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clicking a rendered mermaid diagram opens the split panel, and saving writes the new code back into the fence (Plan 7 Task 6)", async () => {
    const onChange = vi.fn();
    render(
      <LocalEditor
        path="a.md"
        content={"before\n\n```mermaid\ngraph TD\nA-->B\n```\n\nafter"}
        onChange={onChange}
      />,
    );

    const host = await waitFor(() => screen.getByTestId("local-editor-host"));
    const diagram = await waitFor(() => {
      const el = host.querySelector(".cm-lp-mermaid");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });

    fireEvent.click(diagram);

    await waitFor(() => screen.getByRole("dialog", { name: "Mermaid-Diagramm bearbeiten" }));
    expect(screen.getByLabelText("Mermaid-Code")).toHaveValue("graph TD\nA-->B");

    fireEvent.change(screen.getByLabelText("Mermaid-Code"), { target: { value: "graph LR\nX-->Y" } });
    fireEvent.click(screen.getByText("Übernehmen"));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onChange).toHaveBeenLastCalledWith("before\n\n```mermaid\ngraph LR\nX-->Y\n```\n\nafter");
  });

  it("clicking a rendered mermaid diagram then cancelling leaves the document unchanged (Plan 7 Task 6)", async () => {
    const onChange = vi.fn();
    render(<LocalEditor path="a.md" content={"```mermaid\ngraph TD\nA-->B\n```"} onChange={onChange} />);

    const host = await waitFor(() => screen.getByTestId("local-editor-host"));
    const diagram = await waitFor(() => {
      const el = host.querySelector(".cm-lp-mermaid");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.click(diagram);

    await waitFor(() => screen.getByRole("dialog", { name: "Mermaid-Diagramm bearbeiten" }));
    fireEvent.change(screen.getByLabelText("Mermaid-Code"), { target: { value: "graph LR\nX-->Y" } });
    fireEvent.click(screen.getByText("Abbrechen"));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalled();
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
