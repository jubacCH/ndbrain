import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MermaidWidget as MermaidWidgetType, renderMermaid as renderMermaidType } from "./mermaid";

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

beforeEach(async () => {
  vi.resetModules();
  initializeMock.mockClear();
  renderMock.mockReset();
  ({ renderMermaid, MermaidWidget } = await import("./mermaid"));
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

describe("MermaidWidget", () => {
  const noop = () => {};

  it("eq() is true for widgets with the same code and range", () => {
    const a = new MermaidWidget("graph TD\nA-->B", "id-a", 3, 17, noop);
    const b = new MermaidWidget("graph TD\nA-->B", "id-b", 3, 17, noop);

    expect(a.eq(b)).toBe(true);
  });

  it("eq() is false for widgets with different code", () => {
    const a = new MermaidWidget("graph TD\nA-->B", "id-a", 3, 17, noop);
    const b = new MermaidWidget("graph TD\nB-->C", "id-b", 3, 17, noop);

    expect(a.eq(b)).toBe(false);
  });

  it("eq() is false for widgets with the same code but a different range (stale position guard)", () => {
    const a = new MermaidWidget("graph TD\nA-->B", "id-a", 3, 17, noop);
    const b = new MermaidWidget("graph TD\nA-->B", "id-b", 5, 19, noop);

    expect(a.eq(b)).toBe(false);
  });

  it("toDOM() returns a cm-lp-mermaid container and asynchronously fills it with the rendered SVG", async () => {
    renderMock.mockResolvedValue({ svg: "<svg>ok</svg>" });
    const widget = new MermaidWidget("graph TD\nA-->B", "id-dom-ok", 0, 14, noop);

    const container = widget.toDOM();
    expect(container.className).toBe("cm-lp-mermaid");

    await vi.waitFor(() => expect(container.innerHTML).toContain("<svg>ok</svg>"));
  });

  it("toDOM() renders a cm-lp-mermaid-error line instead of crashing when rendering fails", async () => {
    renderMock.mockRejectedValue(new Error("Parse error on line 1"));
    const widget = new MermaidWidget("not a diagram", "id-dom-err", 0, 14, noop);

    const container = widget.toDOM();

    await vi.waitFor(() => expect(container.querySelector(".cm-lp-mermaid-error")).not.toBeNull());
    expect(container.querySelector(".cm-lp-mermaid-error")?.textContent).toContain("Parse error on line 1");
  });

  it("clicking the container calls onEdit with the code and its from/to range", () => {
    renderMock.mockResolvedValue({ svg: "<svg/>" });
    const onEdit = vi.fn();
    const widget = new MermaidWidget("graph TD\nA-->B", "id-click", 10, 24, onEdit);

    const container = widget.toDOM();
    container.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onEdit).toHaveBeenCalledWith({ code: "graph TD\nA-->B", from: 10, to: 24 });
  });

  it("ignoreEvent() returns true so CodeMirror's default click handling never fights the widget's own", () => {
    const widget = new MermaidWidget("graph TD\nA-->B", "id-ignore", 0, 14, noop);

    expect(widget.ignoreEvent()).toBe(true);
  });
});
