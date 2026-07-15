/** Bridge between the mermaid live-preview widget (`mermaid.ts`, a plain
 *  CodeMirror `WidgetType` with no React awareness) and the split-edit panel
 *  hosted by `Editor.tsx`/`LocalEditor.tsx` (a React component): clicking a
 *  rendered diagram calls whatever handler this facet currently resolves to.
 *
 *  Both editors provide a single, stable wrapper function as the facet's
 *  extension value (created once, in the same `EditorState.create` call that
 *  already holds `rawCompartment`/`yCollab` - see their doc comments) that
 *  forwards to a React ref updated on every render. That indirection means
 *  the facet's own extension value never needs reconfiguring even though the
 *  actual React state setter it should call changes identity on every
 *  render - only the ref it reads is mutated, not the extension itself
 *  (`Facet` values, unlike `Compartment` contents, aren't meant to be swapped
 *  at runtime).
 */

import { Facet, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** What a diagram click hands to the "open the split editor" handler: the
 *  diagram source and its exact range in `state.doc`. */
export interface MermaidEditRequest {
  /** The diagram source, i.e. the exact text between the ```mermaid fence's
   *  markers - what `renderMermaid` expects and what the split panel edits. */
  code: string;
  /** Start/end offsets of that source text in `state.doc` - the `CodeText`
   *  node's range, NOT the whole `FencedCode` block. Saving replaces exactly
   *  this range, so the ``` fence markers are never touched. */
  from: number;
  to: number;
}

export type MermaidEditHandler = (request: MermaidEditRequest) => void;

const noopHandler: MermaidEditHandler = () => {};

/** Resolves to the single active "open editor for this diagram" handler.
 *  Only one editor instance is ever mounted per `EditorView`, so the last
 *  provider wins (there's exactly one slot to fill, not a list to merge).
 *  With no provider at all - e.g. `decorations.test.ts`'s plain,
 *  provider-less states, or any future non-React embedding of the
 *  live-preview extensions - it resolves to a no-op, so clicking a diagram
 *  there is inert instead of throwing. */
export const mermaidEditorHandler = Facet.define<MermaidEditHandler, MermaidEditHandler>({
  combine: (values) => values.at(-1) ?? noopHandler,
});

/** Reads the active handler off `state` and calls it - what `MermaidWidget`
 *  (mermaid.ts) actually invokes on click. A thin wrapper mainly so the
 *  facet's `combine`/default-handling stays in one place. */
export function openMermaidEditor(state: EditorState, request: MermaidEditRequest): void {
  state.facet(mermaidEditorHandler)(request);
}

/** Writes an edited diagram's code back into the document: replaces exactly
 *  the `CodeText` range captured at click time (`request.from`/`.to`) with
 *  `newCode`, leaving everything outside that range - including the
 *  ```mermaid / ``` fence markers themselves - untouched. This is a single
 *  `view.dispatch`, so CodeMirror's own change-mapping guarantees the rest of
 *  the document shifts correctly around it; there is no separate position
 *  bookkeeping to get wrong as long as `request` still reflects the current
 *  document (true here because the split panel is modal - no other edit to
 *  this document can land while it's open). */
export function applyMermaidEdit(view: EditorView, request: MermaidEditRequest, newCode: string): void {
  view.dispatch({ changes: { from: request.from, to: request.to, insert: newCode } });
}
