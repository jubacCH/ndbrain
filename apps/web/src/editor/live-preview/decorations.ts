/** Live-preview decoration layer: a purely additive CodeMirror 6 ViewPlugin
 *  that renders inline markdown formatting (bold/italic/strike/inline code),
 *  block constructs (headings/quotes/lists/rules), links, wikilinks and GFM
 *  task-list checkboxes by hiding marker characters and styling or replacing
 *  the surrounding content - the document text itself is never touched.
 *  Applied on top of `yCollab` (see Plan 7 Task 4), so raw mode / the CRDT
 *  binding are unaffected. */

import { syntaxTree } from "@codemirror/language";
import {
  RangeSet,
  RangeSetBuilder,
  StateField,
  type EditorState,
  type Extension,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
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

/** Sorts `pieces` by position and folds them into a `DecorationSet` - the
 *  shared last step of both `inlinePieces` and `buildMermaidDecorations`. */
function piecesToDecorationSet(pieces: DecoPiece[]): DecorationSet {
  const sorted = [...pieces].sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const piece of sorted) {
    builder.add(piece.from, piece.to, piece.decoration);
  }
  return builder.finish();
}

/** True for any `Decoration.replace` piece that collapses a real doc range -
 *  whether it hides the marker outright (an empty `Decoration.replace({})`)
 *  or swaps it for a visible widget (`ListMarkerWidget`/`HrWidget`/
 *  `TaskCheckboxWidget`).
 *  These are exactly the ranges Finding 1 needs to expose via
 *  `EditorView.atomicRanges`: real markdown characters still in `state.doc`
 *  but visually collapsed, so cursor motion and delete must treat each one as
 *  a single atomic unit instead of letting the cursor land *inside* it and
 *  split it apart - e.g. Backspace after "bold" in `**bold**` deleting one of
 *  the two closing `*` (→ corrupted `**bold*`), or after `]` in a `[ ] todo`
 *  task marker (→ `[  todo`), or inside `1.`/`---`. A `Decoration.mark`
 *  (styled content, has `spec.class`) must NOT be atomic - you edit inside
 *  bold text - and a zero-length `Decoration.line` is not a range to skip;
 *  both are excluded by `spec.class === undefined && from < to`. */
function isAtomicReplacePiece(piece: DecoPiece): boolean {
  return piece.decoration.spec.class === undefined && piece.from < piece.to;
}

/** Builds the atomic-ranges `RangeSet` for a set of already-computed
 *  decoration pieces: every range-collapsing replace piece (see
 *  `isAtomicReplacePiece`), in the same sorted, non-overlapping order used -
 *  reusing that order (rather than re-deriving it) is what keeps this cheap,
 *  since the pieces were already computed for the decoration set itself. The
 *  range set's values are never read (`EditorView.atomicRanges` only cares
 *  about positions - verified live against `@codemirror/view@6.43.6`'s
 *  `RangeSet<any>` return type), so the hidden-marker `Decoration` itself is
 *  reused as a convenient value rather than introducing a second type. */
function markerRangesFrom(pieces: DecoPiece[]): RangeSet<Decoration> {
  const sorted = [...pieces].sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const piece of sorted) {
    if (isAtomicReplacePiece(piece)) builder.add(piece.from, piece.to, piece.decoration);
  }
  return builder.finish();
}

/** Pure piece computation for everything EXCEPT ```mermaid fences: walks the
 *  markdown syntax tree over the given ranges (typically the view's visible
 *  ranges) and produces the decoration pieces that hide inline markers and
 *  style their content, without folding them into a `DecorationSet` yet -
 *  `buildInlineDecorations` does that, and `LivePreviewPluginValue` also
 *  derives `markerRanges` (Finding 1) from the same pieces, so both need the
 *  unsorted, unfoldeded list. Never touches `state.doc`.
 *
 *  Mermaid fences are deliberately NOT handled here even though they're a
 *  markdown-syntax-tree concern like everything else in this function - see
 *  `buildMermaidDecorations`'s doc comment for why that decoration needs a
 *  completely different (non-viewport, non-ViewPlugin) wiring. */
function inlinePieces(state: EditorState, ranges: readonly { from: number; to: number }[]): DecoPiece[] {
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

  return pieces;
}

/** Pure decoration builder for everything EXCEPT ```mermaid fences - folds
 *  `inlinePieces`'s output into a `DecorationSet`. Never touches `state.doc`. */
function buildInlineDecorations(state: EditorState, ranges: readonly { from: number; to: number }[]): DecorationSet {
  return piecesToDecorationSet(inlinePieces(state, ranges));
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
 *  facet input - `mermaidBlockDecorationsField` below feeds `EditorView.decorations`
 *  a plain `DecorationSet` value via `Facet.from`, not a per-view function, so
 *  CodeMirror treats it as static. A `StateField` (rather than the
 *  `EditorView.decorations.compute([...], get)` shorthand this used before)
 *  is needed so the same computed value can also be read back for
 *  `EditorView.atomicRanges` (Finding 1) without walking the syntax tree
 *  twice - see `mermaidBlockDecorations`'s doc comment. That source can't be
 *  limited to `view.visibleRanges` (state-derived facet inputs only ever see
 *  `state`, never a `view`), so this one specific decoration walks the whole
 *  document instead of the viewport - an acceptable trade-off since mermaid
 *  fences are rare, heavy block elements, not per-character marks. */
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
            widget: new MermaidWidget(code, `mermaid-${nodeRef.from}`, handler),
          }),
        });
      },
    });
  }

  return piecesToDecorationSet(pieces);
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

/** Live-preview `ViewPlugin` value: rebuilds both the inline decoration set
 *  and the parallel "hidden marker" atomic-ranges set (`markerRanges`,
 *  Finding 1) from the same computed pieces, whenever the doc changes, the
 *  viewport changes, OR the syntax tree changed even though neither of
 *  those did (Finding 4). That third case is real, not theoretical:
 *  `@codemirror/language`'s background parser finishes a chunk of work by
 *  dispatching `view.dispatch({ effects: Language.setState.of(...) })`
 *  (verified live in the installed `@codemirror/language@6.12.4` source,
 *  `parseWorker`'s `work()` method) - a transaction with neither
 *  `docChanged` nor `viewportChanged` set. Without also checking the tree, a
 *  large document's mermaid fences or inline marks beyond what was parsed
 *  synchronously at mount time would never get decorated: the one update
 *  that carries the newly-parsed tree wouldn't trigger a rebuild, and no
 *  later doc/viewport change is guaranteed to come along and trigger one
 *  incidentally. Compares `syntaxTree(state)` by reference (`!==`) the same
 *  way `@codemirror/language`'s own `syntaxHighlighting` extension does
 *  internally (verified live - `TreeHighlighter.update`, same package): the
 *  tree is replaced wholesale on every reparse, so reference inequality is a
 *  reliable, cheap "did anything change" check - no need to diff the tree's
 *  contents. */
class LivePreviewPluginValue {
  decorations: DecorationSet;
  markerRanges: RangeSet<Decoration>;
  private tree: Tree;

  constructor(view: EditorView) {
    this.tree = syntaxTree(view.state);
    const pieces = inlinePieces(view.state, view.visibleRanges);
    this.decorations = piecesToDecorationSet(pieces);
    this.markerRanges = markerRangesFrom(pieces);
  }

  update(update: ViewUpdate): void {
    const tree = syntaxTree(update.state);
    if (update.docChanged || update.viewportChanged || tree !== this.tree) {
      this.tree = tree;
      const pieces = inlinePieces(update.view.state, update.view.visibleRanges);
      this.decorations = piecesToDecorationSet(pieces);
      this.markerRanges = markerRangesFrom(pieces);
    }
  }
}

/** ViewPlugin exposing the non-block live-preview decorations, rebuilt from
 *  the visible ranges only (not the whole document) whenever the doc,
 *  viewport or syntax tree changes (see `LivePreviewPluginValue`'s doc
 *  comment for the syntax-tree case, Finding 4). Mermaid fences are handled
 *  by `mermaidBlockDecorations` instead - see `buildMermaidDecorations`'s
 *  doc comment for why.
 *
 *  `provide` additionally exposes the plugin's `markerRanges` through
 *  `EditorView.atomicRanges` (Finding 1, verified live against
 *  `@codemirror/view@6.43.6`'s `atomicRanges: Facet<(view: EditorView) =>
 *  RangeSet<any>, ...>`): CodeMirror calls the given function on demand
 *  (cursor motion, delete) to look up the live plugin instance via
 *  `view.plugin(plugin)` and read its latest `markerRanges` - this is the
 *  same `provide: plugin => EditorView.atomicRanges.of(view =>
 *  view.plugin(plugin)?.someRangeSet ?? Decoration.none)` pattern
 *  `@codemirror/language`'s own hidden-range-style plugins use. Falls back
 *  to `Decoration.none` (an empty, but still valid, `RangeSet<Decoration>`)
 *  for the one call CodeMirror might make before the plugin instance exists
 *  yet. */
export const livePreviewPlugin = ViewPlugin.fromClass(LivePreviewPluginValue, {
  decorations: (value) => value.decorations,
  provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.markerRanges ?? Decoration.none),
});

/** `StateField` holding the ```mermaid block-decoration `DecorationSet`.
 *  Recomputes whenever the doc changes OR the syntax tree changed without a
 *  doc change (Finding 4 - see `LivePreviewPluginValue`'s doc comment for
 *  why that second case matters for a large document), not on every
 *  transaction. A dedicated field (rather than the `EditorView.decorations.
 *  compute(["doc"], get)` shorthand this used before) is what lets the same
 *  computed value be read back for `EditorView.atomicRanges` below without
 *  a second syntax-tree walk. */
const mermaidBlockDecorationsField = StateField.define<DecorationSet>({
  create(state) {
    return buildMermaidDecorations(state, [{ from: 0, to: state.doc.length }]);
  },
  update(value, tr) {
    if (!tr.docChanged && syntaxTree(tr.state) === syntaxTree(tr.startState)) return value;
    return buildMermaidDecorations(tr.state, [{ from: 0, to: tr.state.doc.length }]);
  },
});

/** Static (state-derived, not view-derived) extension providing the
 *  ```mermaid block decorations - the only way CodeMirror allows block
 *  decorations at all (see `buildMermaidDecorations`'s doc comment).
 *  `EditorView.decorations.from(mermaidBlockDecorationsField)` (verified
 *  live against `@codemirror/state@6.7.1`'s `Facet.from<T extends
 *  Input>(field: StateField<T>): Extension`) feeds the field's plain
 *  `DecorationSet` value into the decorations facet - still a static value
 *  from CodeMirror's point of view, since `from` only reads the field, it
 *  doesn't turn it into a per-view function.
 *
 *  Also feeds that same `DecorationSet` into `EditorView.atomicRanges`
 *  (Finding 1): a ```mermaid fence's block replacement is a
 *  `Decoration.replace({ block: true, widget: ... })`, and - exactly like
 *  the hidden inline markers `livePreviewPlugin` exposes - is not
 *  automatically atomic for cursor motion/deletion just by being a replace
 *  decoration (verified live: `EditorView.atomicRanges`'s own doc comment
 *  states this explicitly, "also provide the range set ... to
 *  atomicRanges"). Reusing the field's value here (rather than re-walking
 *  the syntax tree a second time) means this costs nothing extra. */
export const mermaidBlockDecorations: Extension = [
  mermaidBlockDecorationsField,
  EditorView.decorations.from(mermaidBlockDecorationsField),
  EditorView.atomicRanges.of((view) => view.state.field(mermaidBlockDecorationsField)),
];
