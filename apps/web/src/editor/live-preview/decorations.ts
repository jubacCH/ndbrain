/** Live-preview decoration layer: a purely additive CodeMirror 6 ViewPlugin
 *  that renders inline markdown formatting (bold/italic/strike/inline code),
 *  block constructs (headings/quotes/lists/rules), links, wikilinks and GFM
 *  task-list checkboxes by hiding marker characters and styling or replacing
 *  the surrounding content - the document text itself is never touched.
 *  Applied on top of `yCollab` (see Plan 7 Task 4), so raw mode / the CRDT
 *  binding are unaffected. */

import { syntaxTree } from "@codemirror/language";
import { RangeSet, RangeSetBuilder, type EditorState, type Extension, type Text } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { BLOCK_LINE_CLASS, MARK_CLASS, WIDGET_CLASS, headingLevelOf, headingLineClass, styleForNode } from "./marks";
import { MermaidWidget } from "./mermaid";
import { mermaidEditorHandler } from "./mermaidEditor";
import { taskCheckboxDecorations } from "./tasklist";
import { wikilinkDecorations } from "./wikilink";

/** Only a ```mermaid fence (lowercase, exact match) is rendered as a
 *  diagram - Obsidian's own live-preview treats the info string the same
 *  way (case-sensitive `mermaid`), and matching that convention means a
 *  vault's existing notes behave identically here. Any other info string
 *  (including `Mermaid`/`MERMAID`) falls through to the default fenced-code
 *  rendering (untouched, still raw markdown text). */
const MERMAID_INFO = "mermaid";

/** Delimiter node names produced by `@lezer/markdown` for the inline marks
 *  handled here (verified live - see decorations.test.ts's doc comment). */
const MARKER_NODE_NAMES = new Set(["EmphasisMark", "StrikethroughMark", "CodeMark"]);

interface DecoPiece {
  from: number;
  to: number;
  decoration: Decoration;
}

const hideMarker = Decoration.replace({});

/** Renders a bullet-list marker (`-`/`*`/`+`) as a plain bullet dot, and an
 *  ordered-list marker (e.g. `1.`) as its own text - both dezent-styled via
 *  the same CSS class - in place of the raw marker characters. */
class ListMarkerWidget extends WidgetType {
  constructor(readonly display: string) {
    super();
  }

  eq(other: ListMarkerWidget): boolean {
    return other.display === this.display;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = WIDGET_CLASS.listMarker;
    span.textContent = this.display;
    return span;
  }
}

const BULLET_MARKER = "•";
const BULLET_MARKER_CHARS = new Set(["-", "*", "+"]);

/** Renders a horizontal rule (`---`/`***`/`___`) as an `<hr>` element,
 *  replacing the raw marker text entirely. */
class HrWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const hr = document.createElement("hr");
    hr.className = WIDGET_CLASS.hr;
    return hr;
  }
}

const hrWidget = Decoration.replace({ widget: new HrWidget() });

/** Hides a `HeaderMark`/`QuoteMark` node together with the single space that
 *  CommonMark requires after it (the grammar guarantees that space exists
 *  whenever the node was parsed at all - verified live, see marks.ts). */
function hideMarkerWithTrailingSpace(doc: Text, marker: SyntaxNode): { from: number; to: number } {
  let to = marker.to;
  if (doc.sliceString(to, to + 1) === " ") to += 1;
  return { from: marker.from, to };
}

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

/** Pure decoration builder for everything EXCEPT ```mermaid fences: walks the
 *  markdown syntax tree over the given ranges (typically the view's visible
 *  ranges) and produces a DecorationSet that hides inline markers and styles
 *  their content. Never touches `state.doc`.
 *
 *  Mermaid fences are deliberately NOT handled here even though they're a
 *  markdown-syntax-tree concern like everything else in this function - see
 *  `buildMermaidDecorations`'s doc comment for why that decoration needs a
 *  completely different (non-viewport, non-ViewPlugin) wiring. */
function buildInlineDecorations(state: EditorState, ranges: readonly { from: number; to: number }[]): DecorationSet {
  const pieces: DecoPiece[] = [];
  const tree = syntaxTree(state);

  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter: (nodeRef) => {
        const styleClass = styleForNode(nodeRef.name);
        if (styleClass) {
          const delimiters = delimitersOf(nodeRef.node);
          if (delimiters) {
            const { open, close } = delimiters;
            pieces.push({ from: open.from, to: open.to, decoration: hideMarker });
            pieces.push({ from: open.to, to: close.from, decoration: Decoration.mark({ class: styleClass }) });
            pieces.push({ from: close.from, to: close.to, decoration: hideMarker });
          }
          return;
        }

        switch (nodeRef.name) {
          case "HeaderMark": {
            // The marker's parent is the ATXHeadingN node it belongs to.
            const level = headingLevelOf(nodeRef.node.parent?.name ?? "");
            if (level === null) break;
            const hidden = hideMarkerWithTrailingSpace(state.doc, nodeRef.node);
            pieces.push({ from: hidden.from, to: hidden.to, decoration: hideMarker });
            const line = state.doc.lineAt(nodeRef.from);
            pieces.push({
              from: line.from,
              to: line.from,
              decoration: Decoration.line({ class: headingLineClass(level) }),
            });
            break;
          }
          case "QuoteMark": {
            const hidden = hideMarkerWithTrailingSpace(state.doc, nodeRef.node);
            pieces.push({ from: hidden.from, to: hidden.to, decoration: hideMarker });
            const line = state.doc.lineAt(nodeRef.from);
            pieces.push({
              from: line.from,
              to: line.from,
              decoration: Decoration.line({ class: BLOCK_LINE_CLASS.quote }),
            });
            break;
          }
          case "HorizontalRule": {
            pieces.push({ from: nodeRef.from, to: nodeRef.to, decoration: hrWidget });
            break;
          }
          case "Link": {
            // `[text](url)` and the shortcut-reference form `[text]` (no
            // destination, e.g. the inner brackets of a `[[wikilink]]`)
            // both parse as `Link` (verified live - see marks.ts), but only
            // the former has a `URL` child. Skip the shortcut form entirely
            // so it doesn't collide with wikilink.ts's own decorations over
            // the same range.
            const url = nodeRef.node.getChild("URL");
            if (!url) break;
            // `[`, `]`, `(`, `)` in document order (verified live - see
            // marks.ts).
            const [openBracket, closeBracket, , closeParen] = nodeRef.node.getChildren("LinkMark");
            if (!openBracket || !closeBracket || !closeParen) break;
            const href = state.doc.sliceString(url.from, url.to);
            pieces.push({ from: openBracket.from, to: openBracket.to, decoration: hideMarker });
            pieces.push({
              from: openBracket.to,
              to: closeBracket.from,
              decoration: Decoration.mark({ class: MARK_CLASS.link, attributes: { "data-href": href } }),
            });
            pieces.push({ from: closeBracket.from, to: closeParen.to, decoration: hideMarker });
            break;
          }
          case "ListMark": {
            const text = state.doc.sliceString(nodeRef.from, nodeRef.to);
            const display = BULLET_MARKER_CHARS.has(text) ? BULLET_MARKER : text;
            pieces.push({
              from: nodeRef.from,
              to: nodeRef.to,
              decoration: Decoration.replace({ widget: new ListMarkerWidget(display) }),
            });
            break;
          }
          default:
            break;
        }
      },
    });

    pieces.push(...wikilinkDecorations(state, from, to));
    pieces.push(...taskCheckboxDecorations(state, from, to));
  }

  pieces.sort((a, b) => a.from - b.from || a.to - b.to);

  const builder = new RangeSetBuilder<Decoration>();
  for (const piece of pieces) {
    builder.add(piece.from, piece.to, piece.decoration);
  }
  return builder.finish();
}

/** Pure decoration builder for ```mermaid fences only: walks the markdown
 *  syntax tree over the given ranges and replaces each one with a block
 *  `MermaidWidget`. Split out from `buildInlineDecorations` for a CodeMirror
 *  API reason (verified live against `@codemirror/view@6.43.6`): a
 *  `ViewPlugin`'s decorations are always "dynamic" from CodeMirror's point of
 *  view (recomputed as a function of the view, not derived statically from
 *  state), and `Decoration.replace({ block: true, ... })` from a dynamic
 *  source throws `RangeError: Block decorations may not be specified via
 *  plugins` the moment a document actually containing a ```mermaid fence is
 *  mounted in a real `EditorView` - a crash `decorations.test.ts`'s
 *  detached-state unit tests could never catch, since they never mount a
 *  view at all. Block decorations DO work when they come from a state-derived
 *  facet input (`EditorView.decorations.compute([...], get)`, used by
 *  `mermaidBlockDecorations` below) - `get` returns a plain value there, not
 *  a per-view function, so CodeMirror treats it as static. That source can't
 *  be limited to `view.visibleRanges` (a `Facet.compute` callback only ever
 *  receives `state`, never a `view`), so this one specific decoration walks
 *  the whole document instead of the viewport - an acceptable trade-off since
 *  mermaid fences are rare, heavy block elements, not per-character marks. */
function buildMermaidDecorations(state: EditorState, ranges: readonly { from: number; to: number }[]): DecorationSet {
  const pieces: DecoPiece[] = [];
  const tree = syntaxTree(state);
  const handler = state.facet(mermaidEditorHandler);

  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter: (nodeRef) => {
        if (nodeRef.name !== "FencedCode") return;
        // `CodeMark` ("```"), `CodeInfo` (the info string, e.g. "mermaid")
        // and `CodeText` (the code between the fences) are FencedCode's
        // children (verified live - see mermaid.ts's doc comment). Any info
        // string other than an exact, lowercase "mermaid" is left as plain
        // fenced code (no decoration here at all - default CodeMirror
        // rendering applies).
        const info = nodeRef.node.getChild("CodeInfo");
        if (!info) return;
        const infoText = state.doc.sliceString(info.from, info.to);
        if (infoText !== MERMAID_INFO) return;
        const codeText = nodeRef.node.getChild("CodeText");
        // Fall back to a zero-width range at the fence's end when there's no
        // CodeText child at all (an empty ```mermaid``` fence still being
        // typed) - the widget then has an empty diagram source and a save
        // simply inserts at that point instead of replacing
        // nothing-in-particular.
        const codeFrom = codeText?.from ?? nodeRef.to;
        const codeTo = codeText?.to ?? nodeRef.to;
        const code = codeText ? state.doc.sliceString(codeFrom, codeTo) : "";
        pieces.push({
          from: nodeRef.from,
          to: nodeRef.to,
          decoration: Decoration.replace({
            block: true,
            widget: new MermaidWidget(code, `mermaid-${nodeRef.from}`, codeFrom, codeTo, handler),
          }),
        });
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

/** Combines both decoration sources into one set, over the same ranges -
 *  the full contract this module's own tests exercise. Only a testing/
 *  introspection convenience: the live wiring below (`livePreviewPlugin` +
 *  `mermaidBlockDecorations`) does NOT call this - it keeps the two sources
 *  on their separate extensions, precisely because they need different
 *  CodeMirror wiring (see `buildMermaidDecorations`'s doc comment). Never
 *  touches `state.doc`. */
export function buildDecorations(state: EditorState, ranges: readonly { from: number; to: number }[]): DecorationSet {
  return RangeSet.join([buildInlineDecorations(state, ranges), buildMermaidDecorations(state, ranges)]);
}

class LivePreviewPluginValue {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildInlineDecorations(view.state, view.visibleRanges);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildInlineDecorations(update.view.state, update.view.visibleRanges);
    }
  }
}

/** ViewPlugin exposing the non-block live-preview decorations, rebuilt from
 *  the visible ranges only (not the whole document) whenever the doc or
 *  viewport changes. Mermaid fences are handled by `mermaidBlockDecorations`
 *  instead - see `buildMermaidDecorations`'s doc comment for why. */
export const livePreviewPlugin = ViewPlugin.fromClass(LivePreviewPluginValue, {
  decorations: (value) => value.decorations,
});

/** Static (state-derived, not view-derived) extension providing the
 *  ```mermaid block decorations - the only way CodeMirror allows block
 *  decorations at all (see `buildMermaidDecorations`'s doc comment). Recomputes
 *  only on actual document changes (the `["doc"]` dependency), not on
 *  scroll/viewport changes, since it doesn't use the viewport in the first
 *  place. */
export const mermaidBlockDecorations: Extension = EditorView.decorations.compute(["doc"], (state) =>
  buildMermaidDecorations(state, [{ from: 0, to: state.doc.length }]),
);
