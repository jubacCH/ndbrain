import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { mermaidBlockDecorations } from "./decorations";
import { mermaidEditorHandler } from "./mermaidEditor";
import type {
  MermaidWidget as MermaidWidgetType,
  renderMermaid as renderMermaidType,
  resolveMermaidCodeTextRange as resolveMermaidCodeTextRangeType,
} from "./mermaid";

/** Markdown extension used throughout - GFM isn't actually needed for
 *  ```mermaid fences (plain CommonMark fenced code is enough), but matches
 *  the extension set the real editors use. */
function stateFor(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdown({ extensions: [GFM] })] });
}

// `vi.mock` factories are hoisted above imports, so the mock fns must come
// from `vi.hoisted` (see localStore.test.ts for the same convention) -
// referencing a plain top-level `const` here would throw a
// temporal-dead-zone error.
const { initializeMock, renderMock } = vi.hoisted(() => ({
  initializeMock: vi.fn(),
  renderMock: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: initializeMock,
    render: renderMock,
  },
}));

// `mermaid.ts` tracks "already initialized" as module-level state, which is
// exactly what's under test here - so each test resets the module registry
// and re-imports fresh, instead of sharing one instance (and thus one
// `initialized` flag) across the whole file.
let renderMermaid: typeof renderMermaidType;
let MermaidWidget: typeof MermaidWidgetType;
let resolveMermaidCodeTextRange: typeof resolveMermaidCodeTextRangeType;

beforeEach(async () => {
  vi.resetModules();
  initializeMock.mockClear();
  renderMock.mockReset();
  ({ renderMermaid, MermaidWidget, resolveMermaidCodeTextRange } = await import("./mermaid"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderMermaid", () => {
  it("lazily loads mermaid, initializes it in strict security mode and returns the rendered SVG", async () => {
    renderMock.mockResolvedValue({ svg: "<svg>diagram</svg>" });

    const svg = await renderMermaid("graph TD\nA-->B", "mermaid-1");

    expect(svg).toBe("<svg>diagram</svg>");
    expect(initializeMock).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict", startOnLoad: false }),
    );
    expect(renderMock).toHaveBeenCalledWith("mermaid-1", "graph TD\nA-->B");
  });

  it("only initializes mermaid once across multiple render calls", async () => {
    renderMock.mockResolvedValue({ svg: "<svg/>" });

    await renderMermaid("graph TD\nA-->B", "mermaid-2");
    await renderMermaid("graph TD\nC-->D", "mermaid-3");

    expect(initializeMock).toHaveBeenCalledTimes(1);
  });

  it("rejects instead of throwing synchronously when mermaid can't parse the diagram", async () => {
    renderMock.mockRejectedValue(new Error("Parse error on line 1"));

    await expect(renderMermaid("not a diagram", "mermaid-4")).rejects.toThrow("Parse error on line 1");
  });
});

describe("resolveMermaidCodeTextRange", () => {
  it("resolves the CodeText range from a position at the very start of the fence", () => {
    const doc = "```mermaid\ngraph TD\nA-->B\n```";
    const state = stateFor(doc);
    const codeTextFrom = doc.indexOf("graph TD");
    const codeTextTo = codeTextFrom + "graph TD\nA-->B".length;

    expect(resolveMermaidCodeTextRange(state, 0)).toEqual({ from: codeTextFrom, to: codeTextTo });
  });

  it("resolves the CodeText range from a position inside the code text itself", () => {
    const doc = "```mermaid\ngraph TD\nA-->B\n```";
    const state = stateFor(doc);
    const codeTextFrom = doc.indexOf("graph TD");
    const codeTextTo = codeTextFrom + "graph TD\nA-->B".length;

    expect(resolveMermaidCodeTextRange(state, codeTextFrom + 3)).toEqual({ from: codeTextFrom, to: codeTextTo });
  });

  it("returns null for a position outside any ```mermaid fence", () => {
    const doc = "plain text\n\n```mermaid\ngraph TD\n```";
    const state = stateFor(doc);

    expect(resolveMermaidCodeTextRange(state, 2)).toBeNull();
  });

  it("resolves a FencedCode's CodeText range regardless of its info string", () => {
    // This function only finds the enclosing `FencedCode`/`CodeText` pair -
    // it doesn't check the info string is exactly "mermaid" (that filtering
    // happens one level up, in `mermaidBlockDecorations`, before a
    // `MermaidWidget` - and thus its click handler - is ever created for a
    // fence). Documented here so the scope of what this function does (and
    // doesn't) check stays explicit.
    const doc = "```js\nconst a = 1;\n```";
    const state = stateFor(doc);
    const codeTextFrom = doc.indexOf("const");
    const codeTextTo = codeTextFrom + "const a = 1;".length;

    expect(resolveMermaidCodeTextRange(state, codeTextFrom)).toEqual({ from: codeTextFrom, to: codeTextTo });
  });
});

describe("MermaidWidget", () => {
  const noop = () => {};
  /** A detached `EditorView` (no DOM parent needed, matching the pattern
   *  `tasklist.test.ts` uses) - good enough for the tests below that never
   *  click the widget (so never call `view.posAtDOM`). */
  const detachedView = () => new EditorView({ state: EditorState.create({ doc: "" }) });

  it("eq() is true for widgets with the same code (position no longer matters - Finding 3 fix)", () => {
    const a = new MermaidWidget("graph TD\nA-->B", "id-a", noop);
    const b = new MermaidWidget("graph TD\nA-->B", "id-b", noop);

    expect(a.eq(b)).toBe(true);
  });

  it("eq() is false for widgets with different code", () => {
    const a = new MermaidWidget("graph TD\nA-->B", "id-a", noop);
    const b = new MermaidWidget("graph TD\nB-->C", "id-b", noop);

    expect(a.eq(b)).toBe(false);
  });

  it("toDOM() returns a cm-lp-mermaid container and asynchronously fills it with the rendered SVG", async () => {
    renderMock.mockResolvedValue({ svg: "<svg>ok</svg>" });
    const widget = new MermaidWidget("graph TD\nA-->B", "id-dom-ok", noop);

    const container = widget.toDOM(detachedView());
    expect(container.className).toBe("cm-lp-mermaid");

    await vi.waitFor(() => expect(container.innerHTML).toContain("<svg>ok</svg>"));
  });

  it("toDOM() renders a cm-lp-mermaid-error line instead of crashing when rendering fails", async () => {
    renderMock.mockRejectedValue(new Error("Parse error on line 1"));
    const widget = new MermaidWidget("not a diagram", "id-dom-err", noop);

    const container = widget.toDOM(detachedView());

    await vi.waitFor(() => expect(container.querySelector(".cm-lp-mermaid-error")).not.toBeNull());
    expect(container.querySelector(".cm-lp-mermaid-error")?.textContent).toContain("Parse error on line 1");
  });

  it("ignoreEvent() returns true so CodeMirror's default click handling never fights the widget's own", () => {
    const widget = new MermaidWidget("graph TD\nA-->B", "id-ignore", noop);

    expect(widget.ignoreEvent()).toBe(true);
  });
});

describe("MermaidWidget - click resolves the range via the real mounted pipeline (Finding 3)", () => {
  // Mounts the actual `mermaidBlockDecorations` extension (not a
  // hand-constructed widget) so the click goes through the real
  // `view.posAtDOM` + `resolveMermaidCodeTextRange` path exactly as it does
  // in the live editors - a detached state could never exercise this since
  // `posAtDOM` needs real rendered DOM to map back to a position.
  function mountFence(doc: string, onEdit: (request: unknown) => void): EditorView {
    return new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        doc,
        extensions: [markdown({ extensions: [GFM] }), mermaidBlockDecorations, mermaidEditorHandler.of(onEdit)],
      }),
    });
  }

  it("clicking the rendered diagram calls onEdit with the code and its current CodeText range", () => {
    renderMock.mockResolvedValue({ svg: "<svg/>" });
    const doc = "```mermaid\ngraph TD\nA-->B\n```";
    const codeTextFrom = doc.indexOf("graph TD");
    const codeTextTo = codeTextFrom + "graph TD\nA-->B".length;
    const onEdit = vi.fn();
    const view = mountFence(doc, onEdit);

    view.dom.querySelector(".cm-lp-mermaid")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onEdit).toHaveBeenCalledWith({ code: "graph TD\nA-->B", from: codeTextFrom, to: codeTextTo });
    view.destroy();
  });
});
