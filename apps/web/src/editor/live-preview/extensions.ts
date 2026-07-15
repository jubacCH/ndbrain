/** Public entry point for the live-preview decoration layer (Plan 7 Task 4):
 *  bundles the `livePreviewPlugin` ViewPlugin (Tasks 1-3) into a single
 *  `Extension` both real editors (`Editor.tsx`/`LocalEditor.tsx`) include,
 *  and wraps it in a `Compartment` so it can be swapped out for an empty
 *  extension at runtime - that's the "raw" toggle: raw mode is simply "no
 *  live-preview decorations", i.e. today's plain markdown-source behavior,
 *  with no separate code path to keep in sync.
 *
 *  `Compartment.reconfigure` is the standard CodeMirror 6 way to swap a
 *  section of an `EditorState`'s extensions after the state was created
 *  (verified live against `@codemirror/state@6.7.1`) - it needs a
 *  `Compartment.of(...)` call at state-creation time to reserve the slot,
 *  then `view.dispatch({ effects: compartment.reconfigure(...) })` later to
 *  replace its contents. Reconfiguring only re-runs the extensions in that
 *  slot; it never touches `state.doc`, so toggling raw/formatted mode can
 *  never alter the underlying markdown text. */

import { Compartment, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { livePreviewPlugin, mermaidBlockDecorations } from "./decorations";

/** The complete live-preview bundle: the decoration ViewPlugin (inline marks,
 *  headings, quotes, rules, links, wikilinks, task checkboxes - viewport-
 *  scoped) plus the separate ```mermaid block-decoration extension (whole-
 *  document, state-derived - see `decorations.ts`'s `buildMermaidDecorations`
 *  doc comment for why block decorations can't live on the same ViewPlugin).
 *  A single call both editors use, so any future addition here (e.g. a shared
 *  `EditorView.baseTheme`) reaches both without touching
 *  `Editor.tsx`/`LocalEditor.tsx` again. */
export function livePreviewExtensions(): Extension {
  return [livePreviewPlugin, mermaidBlockDecorations];
}

/** Reserves the swappable slot in an `EditorState`'s extensions for the
 *  live-preview bundle. Both editors include
 *  `rawCompartment.of(livePreviewExtensions())` directly in their
 *  `EditorState.create({ extensions: [...] })` call. */
export const rawCompartment = new Compartment();

/** Switches `view` between raw markdown source (`raw: true` - the compartment
 *  holds no extensions, so decorations disappear and the exact `**`/`~~`/etc.
 *  markers show, i.e. today's default editor behavior) and the formatted
 *  live-preview (`raw: false` - the compartment holds
 *  `livePreviewExtensions()`). Purely a view-layer toggle: `view.state.doc`
 *  is byte-identical in both modes. */
export function setRawMode(view: EditorView, raw: boolean): void {
  view.dispatch({
    effects: rawCompartment.reconfigure(raw ? [] : livePreviewExtensions()),
  });
}
