/** Renders ```mermaid fenced-code blocks to inline SVG diagrams for the
 *  live-preview decoration layer (see decorations.ts). `mermaid` is a large
 *  dependency, so it is only ever loaded via a lazy `import("mermaid")` -
 *  triggered the first time a mermaid block is actually rendered - to keep
 *  it out of the main bundle (verified: Task 5's build produces a separate
 *  chunk for it, see the Plan 7 Task 5 report).
 *
 *  `mermaid@11.16.0`'s render API (verified live against the installed
 *  package's `dist/mermaid.d.ts` / `dist/types.d.ts`):
 *  `initialize(config: MermaidConfig): void` and
 *  `render(id: string, text: string, svgContainingElement?: Element):
 *  Promise<{ svg: string, ... }>` - matching the brief's expected shape. */

import { WidgetType } from "@codemirror/view";

/** `mermaid.initialize` must only run once per page - calling it repeatedly
 *  is wasteful and, per mermaid's docs, not guaranteed idempotent for a
 *  process already mid-render. */
let initialized = false;

/** Renders `code` (the raw text between a ```mermaid fence's markers) to an
 *  SVG string via a lazily-imported `mermaid`. `id` must be unique among
 *  concurrently rendered diagrams - mermaid uses it as the root `<svg>`
 *  element's id and derives internal node/class ids from it, so reusing an
 *  id across two diagrams rendered at the same time corrupts both.
 *
 *  Errors (e.g. invalid diagram syntax) are deliberately left to reject
 *  rather than swallowed here: this function is the pure "render" step,
 *  and the widget is the layer that owns presentation, so it decides how a
 *  failure is shown (see `MermaidWidget.toDOM` below). */
export async function renderMermaid(code: string, id: string): Promise<string> {
  const mermaid = (await import("mermaid")).default;
  if (!initialized) {
    mermaid.initialize({ securityLevel: "strict", startOnLoad: false });
    initialized = true;
  }
  const { svg } = await mermaid.render(id, code);
  return svg;
}

/** Block-replacement widget for a ```mermaid fenced-code block. Always
 *  replaces the whole fence with its rendered diagram - there is no
 *  "reveal the source on cursor" behavior (unlike the inline marks in
 *  decorations.ts); editing the source is a split-panel concern (Task 6). */
export class MermaidWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly id: string,
  ) {
    super();
  }

  /** Only the diagram source matters for reuse: two widgets with the same
   *  code are interchangeable, so CodeMirror keeps the existing rendered DOM
   *  (and doesn't re-run mermaid) across a decoration rebuild instead of
   *  re-rendering identical output. */
  eq(other: MermaidWidget): boolean {
    return other.code === this.code;
  }

  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = "cm-lp-mermaid";

    renderMermaid(this.code, this.id).then(
      (svg) => {
        container.innerHTML = svg;
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const errorLine = document.createElement("div");
        errorLine.className = "cm-lp-mermaid-error";
        errorLine.textContent = `Mermaid render error: ${message}`;
        container.replaceChildren(errorLine);
      },
    );

    return container;
  }

  ignoreEvent(): boolean {
    // No interaction yet (source-editing lands in Task 6 as a split panel);
    // default event handling is fine for now.
    return false;
  }
}
