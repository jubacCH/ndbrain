/**
 * Folding: a heading closes over its section, a callout over its body.
 *
 * The Markdown grammar already knows the ranges — a heading folds to the next
 * heading of the same level or higher, a block quote to its end — so what this
 * adds is only the handle to do it with: a small triangle in the margin in
 * front of each heading and callout, shown on hover and always while folded,
 * so a closed section cannot be mistaken for a short one.
 *
 * A fold lives in the view and never in the file. Two people reading the same
 * note fold different things, and the note's bytes do not change because one
 * of them wanted less on screen. The one exception is a callout written as
 * `[!note]-`: the minus is the author saying "starts closed", and the note opens
 * that way — a fact read from the file, not written back to it.
 */

import {
  codeFolding,
  ensureSyntaxTree,
  foldEffect,
  foldKeymap,
  foldable,
  foldedRanges,
  syntaxTree,
  unfoldEffect,
} from '@codemirror/language';
import type { EditorState, Extension, Range, StateEffect } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  keymap,
} from '@codemirror/view';

import { copy } from '../copy';
import { CALLOUT } from './livePreview';

/** Whether a fold already starts at the end of this line. */
function foldedAt(state: EditorState, lineEnd: number): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  foldedRanges(state).between(lineEnd, lineEnd, (from, to) => {
    if (from === lineEnd) {
      found = { from, to };
      return false;
    }
    return undefined;
  });
  return found;
}

/** Folds or opens the section that starts on the line at `pos`. */
export function toggleFoldAt(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos);
  const open = foldedAt(view.state, line.to);
  if (open !== null) {
    view.dispatch({ effects: unfoldEffect.of(open) });
    return true;
  }
  const range = foldable(view.state, line.from, line.to);
  if (range === null || range.to <= range.from) return false;
  view.dispatch({ effects: foldEffect.of(range) });
  return true;
}

class FoldToggleWidget extends WidgetType {
  constructor(
    readonly folded: boolean,
    readonly line: number,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof FoldToggleWidget && other.folded === this.folded && other.line === this.line;
  }

  override toDOM(view: EditorView): HTMLElement {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = this.folded ? 'cm-fold-toggle is-folded' : 'cm-fold-toggle';
    // A text triangle rather than an icon, in keeping with the rest of the
    // editor's controls. It turns rather than changing glyph.
    toggle.textContent = '▸';
    toggle.setAttribute('aria-label', this.folded ? copy.editor.fold.open : copy.editor.fold.close);
    toggle.setAttribute('aria-expanded', String(!this.folded));
    toggle.tabIndex = -1;

    toggle.addEventListener('mousedown', (event) => {
      // Otherwise the click also moves the cursor onto the heading, which
      // reveals its `#` and makes the line jump under the pointer.
      event.preventDefault();
      const line = view.state.doc.line(Math.min(this.line, view.state.doc.lines));
      toggleFoldAt(view, line.from);
    });
    return toggle;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** The lines that carry a toggle: headings and callout heads that can fold. */
function toggles(view: EditorView): DecorationSet {
  const { state } = view;
  const marks: Range<Decoration>[] = [];
  const seen = new Set<number>();

  const add = (pos: number): void => {
    const line = state.doc.lineAt(pos);
    if (seen.has(line.number)) return;
    seen.add(line.number);

    const folded = foldedAt(state, line.to) !== null;
    if (!folded) {
      const range = foldable(state, line.from, line.to);
      if (range === null || range.to <= range.from) return;
    }
    marks.push(
      Decoration.widget({ widget: new FoldToggleWidget(folded, line.number), side: -1 }).range(
        line.from,
      ),
    );
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name.startsWith('ATXHeading')) {
          add(node.from);
          return false;
        }
        if (node.name === 'Blockquote') {
          if (CALLOUT.test(state.doc.lineAt(node.from).text)) add(node.from);
          return false;
        }
        return undefined;
      },
    });
  }

  return Decoration.set(marks, true);
}

const togglePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = toggles(view);
    }

    update(update: ViewUpdate): void {
      const refolded = update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(foldEffect) || effect.is(unfoldEffect)),
      );
      if (
        update.docChanged ||
        update.viewportChanged ||
        refolded ||
        // The tree for a long note arrives in pieces; a heading parsed late
        // still deserves its toggle.
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = toggles(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/**
 * The folds a note opens with: every callout its author marked `[!type]-`.
 *
 * Applied once, right after the editor is built — never again on a change, or
 * typing the minus would slam the callout shut under the cursor.
 */
export function initialFolds(state: EditorState): StateEffect<{ from: number; to: number }>[] {
  const effects: StateEffect<{ from: number; to: number }>[] = [];
  // The parser works in slices; a callout near the end of a long note would
  // otherwise not be in the tree yet and silently open unfolded.
  ensureSyntaxTree(state, state.doc.length, 200);
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const callout = CALLOUT.exec(line.text);
    if (callout === null || callout[3] !== '-') continue;
    // Only the head of a quote, not a `[!x]-` that happens to sit inside one.
    if (n > 1 && /^\s*>/.test(state.doc.line(n - 1).text)) continue;

    const range = foldable(state, line.from, line.to);
    if (range !== null && range.to > range.from) effects.push(foldEffect.of(range));
  }
  return effects;
}

export function folding(): Extension {
  return [
    codeFolding({
      placeholderDOM: (_view, onclick) => {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'cm-fold-more';
        more.textContent = '…';
        more.setAttribute('aria-label', copy.editor.fold.open);
        more.addEventListener('click', onclick);
        return more;
      },
    }),
    togglePlugin,
    keymap.of(foldKeymap),
  ];
}
