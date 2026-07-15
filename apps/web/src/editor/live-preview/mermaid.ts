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

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import type { MermaidEditHandler } from "./mermaidEditor";

/** Resolves the `CodeText` range of the ```mermaid fence enclosing `pos` in
 *  `state`'s current syntax tree - freshly re-derived every time this is
 *  called, rather than a range captured once at decoration-build time (see
 *  `MermaidWidget`'s doc comment for why that distinction is the whole
 *  point of Finding 3's fix). `resolveInner` (not `resolve`) is used so a
 *  `pos` that lands exactly on the fence's own start still resolves into
 *  the fence itself rather than stopping one level too high (verified live
 *  against `@lezer/common@1.5.2` - `resolveInner`, unlike `resolve`, walks
 *  into the innermost node at a boundary position). Returns null when `pos`
 *  isn't (or, e.g. after concurrent edits, no longer is) inside a mermaid
 *  fence's `CodeText` - in which case a click is simply ignored. */
export function resolveMermaidCodeTextRange(state: EditorState, pos: number): { from: number; to: number } | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
  while (node && node.name !== "FencedCode") node = node.parent;
  if (!node) return null;
  const codeText = node.getChild("CodeText");
  if (!codeText) return null;
  return { from: codeText.from, to: codeText.to };
}

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
 *  decorations.ts). Editing the source happens in the split panel (Task 6):
 *  clicking the rendered diagram calls `onEdit` with the code and its exact
 *  `CodeText` range, resolved fresh at click time (see `toDOM` below) via
 *  `resolveMermaidCodeTextRange`.
 *
 *  Deliberately carries no document position (no `from`/`to`) - only `code`
 *  (Finding 3's fix): CodeMirror decides whether to reuse this widget's
 *  existing rendered DOM (skipping a re-run of mermaid) purely by `eq()`, and
 *  every edit anywhere in the document ahead of this fence shifts its
 *  position without changing its content, which used to make `eq()` false
 *  (from/to no longer matched) and needlessly discard + re-render the
 *  diagram on every unrelated keystroke above it. Positions are resolved
 *  fresh from the live syntax tree only when actually needed (a click), so
 *  there is nothing position-shaped left in the widget to go stale. */
export class MermaidWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly id: string,
    readonly onEdit: MermaidEditHandler,
  ) {
    super();
  }

  /** Two widgets are interchangeable - CodeMirror keeps the existing
   *  rendered DOM (and doesn't re-run mermaid) across a decoration rebuild -
   *  whenever their diagram source matches, regardless of where in the
   *  document that source currently lives. */
  eq(other: MermaidWidget): boolean {
    return other.code === this.code;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement("div");
    container.className = "cm-lp-mermaid";
    container.addEventListener("click", () => {
      const pos = view.posAtDOM(container);
      const range = resolveMermaidCodeTextRange(view.state, pos);
      if (!range) return;
      this.onEdit({ code: view.state.doc.sliceString(range.from, range.to), from: range.from, to: range.to });
    });

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
    // The container owns click handling itself (opening the split panel) -
    // ignore every DOM event so CodeMirror's own default handling (e.g.
    // placing the cursor at the click's mapped document position) never
    // fights with that, since this is an atomic block replacement with
    // nothing underneath for a cursor to usefully land in anyway.
    return true;
  }
}
