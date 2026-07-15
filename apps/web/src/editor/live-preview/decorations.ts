/** Live-preview decoration layer: a purely additive CodeMirror 6 ViewPlugin
 *  that renders inline markdown formatting (bold/italic/strike/inline code)
 *  by hiding the marker characters and styling the surrounding content -
 *  the document text itself is never touched. Applied on top of `yCollab`
 *  (see Plan 7 Task 4), so raw mode / the CRDT binding are unaffected. */

import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { styleForNode } from "./marks";

/** Delimiter node names produced by `@lezer/markdown` for the inline marks
 *  handled here (verified live - see decorations.test.ts's doc comment). */
const MARKER_NODE_NAMES = new Set(["EmphasisMark", "StrikethroughMark", "CodeMark"]);

interface DecoPiece {
  from: number;
  to: number;
  decoration: Decoration;
}

const hideMarker = Decoration.replace({});

/** A styled inline node (`StrongEmphasis`/`Emphasis`/`Strikethrough`/
 *  `InlineCode`) always brackets its content with an opening and closing
 *  delimiter as its first/last child, per the markdown grammar. Returns
 *  those two delimiter nodes, or null if the node isn't well-formed (e.g. an
 *  unterminated marker still being typed, which the parser may represent
 *  without a matching closing delimiter). */
function delimitersOf(node: SyntaxNode): { open: SyntaxNode; close: SyntaxNode } | null {
  const open = node.firstChild;
  const close = node.lastChild;
  if (!open || !close || open === close) return null;
  if (!MARKER_NODE_NAMES.has(open.name) || !MARKER_NODE_NAMES.has(close.name)) return null;
  return { open, close };
}

/** Pure decoration builder: walks the markdown syntax tree over the given
 *  ranges (typically the view's visible ranges) and produces a DecorationSet
 *  that hides inline markers and styles their content. Never touches
 *  `state.doc`. */
export function buildDecorations(state: EditorState, ranges: readonly { from: number; to: number }[]): DecorationSet {
  const pieces: DecoPiece[] = [];
  const tree = syntaxTree(state);

  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter: (nodeRef) => {
        const styleClass = styleForNode(nodeRef.name);
        if (!styleClass) return;

        const delimiters = delimitersOf(nodeRef.node);
        if (!delimiters) return;

        const { open, close } = delimiters;
        pieces.push({ from: open.from, to: open.to, decoration: hideMarker });
        pieces.push({ from: open.to, to: close.from, decoration: Decoration.mark({ class: styleClass }) });
        pieces.push({ from: close.from, to: close.to, decoration: hideMarker });
      },
    });
  }

  pieces.sort((a, b) => a.from - b.from || a.to - b.to);

  const builder = new RangeSetBuilder<Decoration>();
  for (const piece of pieces) {
    builder.add(piece.from, piece.to, piece.decoration);
  }
  return builder.finish();
}

class LivePreviewPluginValue {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildDecorations(view.state, view.visibleRanges);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildDecorations(update.view.state, update.view.visibleRanges);
    }
  }
}

/** ViewPlugin exposing the live-preview DecorationSet, rebuilt from the
 *  visible ranges only (not the whole document) whenever the doc or
 *  viewport changes. */
export const livePreviewPlugin = ViewPlugin.fromClass(LivePreviewPluginValue, {
  decorations: (value) => value.decorations,
});
