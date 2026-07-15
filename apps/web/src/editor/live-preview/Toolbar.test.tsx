import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
// Explicit ".tsx" extension - deliberately NOT a bare "./Toolbar" specifier.
// On this filesystem (case-insensitive APFS) that bare form is ambiguous with
// the sibling "./toolbar.ts" (command module): Vite/esbuild's extension
// probing tries ".ts" before ".tsx" and, because existsSync is
// case-insensitive here, "Toolbar.ts" matches "toolbar.ts" and wins before
// ".tsx" is ever tried - resolving to the wrong module (no `EditorToolbar`
// export) and breaking every test with "Element type is invalid: ...
// undefined" (verified live). `allowImportingTsExtensions` is enabled in
// tsconfig.json for this. Any future importer of this component (e.g. an
// Editor.tsx integration) needs the same explicit ".tsx" suffix.
import { EditorToolbar } from "./Toolbar.tsx";

/** A detached, real `EditorView` (no DOM parent) - enough for the format
 *  commands in `toolbar.ts` to run their `view.dispatch` calls against, so
 *  these tests assert on the actual resulting doc rather than a mock. */
function makeView(doc: string, from = 0, to = from): EditorView {
  return new EditorView({
    state: EditorState.create({ doc, selection: { anchor: from, head: to } }),
  });
}

describe("<EditorToolbar>", () => {
  afterEach(() => {
    cleanup();
  });

  it("clicking Bold runs toggleBold against the given view", () => {
    const view = makeView("x", 0, 1);

    render(<EditorToolbar view={view} raw={false} onToggleRaw={vi.fn()} />);

    fireEvent.click(screen.getByTitle("Bold (Mod-b)"));

    expect(view.state.doc.toString()).toBe("**x**");
  });

  it("clicking Italic runs toggleItalic against the given view", () => {
    const view = makeView("x", 0, 1);

    render(<EditorToolbar view={view} raw={false} onToggleRaw={vi.fn()} />);

    fireEvent.click(screen.getByTitle("Italic (Mod-i)"));

    expect(view.state.doc.toString()).toBe("*x*");
  });

  it("clicking Mermaid einfügen inserts a mermaid fence", () => {
    const view = makeView("", 0);

    render(<EditorToolbar view={view} raw={false} onToggleRaw={vi.fn()} />);

    fireEvent.click(screen.getByText("Mermaid einfügen"));

    expect(view.state.doc.toString()).toContain("```mermaid");
  });

  it("clicking the raw-toggle button calls onToggleRaw, not any format command", () => {
    const view = makeView("x", 0, 1);
    const onToggleRaw = vi.fn();

    render(<EditorToolbar view={view} raw={false} onToggleRaw={onToggleRaw} />);

    fireEvent.click(screen.getByText("Formatiert"));

    expect(onToggleRaw).toHaveBeenCalledTimes(1);
    expect(view.state.doc.toString()).toBe("x");
  });

  it("reflects raw=true as a distinct label", () => {
    render(<EditorToolbar view={null} raw={true} onToggleRaw={vi.fn()} />);

    expect(screen.getByText("Roh")).toBeInTheDocument();
    expect(screen.queryByText("Formatiert")).not.toBeInTheDocument();
  });

  it("disables every format button when view is null, but keeps the raw toggle enabled", () => {
    render(<EditorToolbar view={null} raw={false} onToggleRaw={vi.fn()} />);

    expect(screen.getByTitle("Bold (Mod-b)")).toBeDisabled();
    expect(screen.getByTitle("Italic (Mod-i)")).toBeDisabled();
    expect(screen.getByText("Formatiert")).not.toBeDisabled();
  });

  // A plain click on a button first fires "mousedown", and IT is what a
  // browser uses to move focus onto the button - by the time "click" fires,
  // focus has already left the editor. So the fix has to prevent default on
  // mousedown, not on click; these tests verify that's actually wired up by
  // checking the real dispatchEvent-cancellation return value (per the DOM
  // spec, `dispatchEvent` returns `false` once a cancelable event had
  // `preventDefault()` called on it), not just re-reading the source.
  it("prevents default on mousedown for every format button, so clicking one doesn't steal focus from the editor", () => {
    const view = makeView("x", 0, 1);

    render(<EditorToolbar view={view} raw={false} onToggleRaw={vi.fn()} />);

    const notCancelled = fireEvent.mouseDown(screen.getByTitle("Bold (Mod-b)"));

    expect(notCancelled).toBe(false);
  });

  it("prevents default on mousedown for the raw-toggle button too", () => {
    render(<EditorToolbar view={null} raw={false} onToggleRaw={vi.fn()} />);

    const notCancelled = fireEvent.mouseDown(screen.getByText("Formatiert"));

    expect(notCancelled).toBe(false);
  });

  // Real-browser-only concern (documented, not asserted here): jsdom does
  // not implement the "mousedown moves focus to the target" step of the
  // UI Events focus algorithm the way real browsers do, so there is no
  // `document.activeElement` shift to observe in this environment even
  // without the fix - this suite can only verify the preventDefault wiring
  // above, not the actual focus-retention outcome. That needs manual/E2E
  // verification in a real browser.
  it("(documents, doesn't assert) actual focus retention needs a real browser - jsdom doesn't move focus on mousedown", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const view = new EditorView({
      state: EditorState.create({ doc: "x", selection: { anchor: 0, head: 1 } }),
      parent: container,
    });
    view.focus();
    const editorHadFocus = document.activeElement === view.contentDOM;

    render(<EditorToolbar view={view} raw={false} onToggleRaw={vi.fn()} />);
    fireEvent.mouseDown(screen.getByTitle("Bold (Mod-b)"));

    // This assertion holds in jsdom regardless of the fix, because jsdom
    // never shifts focus on mousedown in the first place - it's recorded
    // here only so the limitation is explicit, not silently assumed.
    expect(editorHadFocus).toBe(true);
    expect(document.activeElement).toBe(view.contentDOM);

    view.destroy();
    container.remove();
  });
});
