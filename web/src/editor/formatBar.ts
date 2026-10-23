/**
 * The bar that appears over a selection.
 *
 * The keyboard shortcuts in `./format` already do everything this does, and
 * for somebody who knows them they stay the faster way. The bar is for the
 * moment in between: text is selected, the hand is on the mouse or the screen
 * is a phone, and nobody remembers whether strikethrough was Shift-X.
 *
 * It costs nothing while nothing is selected, which is why it does not break
 * the rule that kept a permanent toolbar out — it is not permanent. And it names
 * its commands with letters and words rather than line icons, like the `/` menu.
 *
 * Every button is one of the commands the keymap already runs, so the bar and
 * the keyboard cannot drift apart into two slightly different bolds.
 */

import { EditorState, StateField, type StateCommand } from '@codemirror/state';
import { EditorView, showTooltip, type Tooltip, type TooltipView } from '@codemirror/view';

import { copy } from '../copy';
import { insertLink, lineKind, linkNote, setLineKind, toggleWrap, type LineKind } from './format';
import { tableBlocks } from './tableView';

interface Button {
  /** What the button shows: a letter or a short word, never an icon. */
  face: string;
  /** What a screen reader says, and the hover title with the shortcut. */
  label: string;
  /** A class of its own, so `B` can be bold and `S` struck through. */
  look?: string;
  run: StateCommand;
  /** For the line kinds: whether the button reads as pressed. */
  kind?: LineKind;
}

function buttons(): Button[][] {
  const t = copy.editor.bar;
  return [
    [
      { face: 'B', label: t.bold, look: 'bold', run: toggleWrap('**') },
      { face: 'I', label: t.italic, look: 'italic', run: toggleWrap('*') },
      { face: 'S', label: t.strike, look: 'strike', run: toggleWrap('~~') },
      { face: t.codeFace, label: t.code, look: 'mono', run: toggleWrap('`') },
      { face: t.markFace, label: t.mark, look: 'mark', run: toggleWrap('==') },
    ],
    [
      { face: t.linkFace, label: t.link, run: insertLink },
      { face: '[[ ]]', label: t.noteLink, look: 'mono', run: linkNote },
    ],
    [
      { face: 'H1', label: t.h1, run: setLineKind('h1'), kind: 'h1' },
      { face: 'H2', label: t.h2, run: setLineKind('h2'), kind: 'h2' },
      { face: 'H3', label: t.h3, run: setLineKind('h3'), kind: 'h3' },
      { face: t.taskFace, label: t.task, run: setLineKind('task'), kind: 'task' },
      { face: t.quoteFace, label: t.quote, run: setLineKind('quote'), kind: 'quote' },
    ],
  ];
}

/**
 * Builds the bar. Module level and therefore always the same function, which
 * is what lets CodeMirror keep the one bar and only move it while the selection
 * grows, instead of tearing it down and drawing it again on every arrow key.
 */
function createBar(view: EditorView): TooltipView {
  const bar = document.createElement('div');
  bar.className = 'cm-formatbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', copy.editor.bar.label);

  const kinds: Array<[HTMLButtonElement, LineKind]> = [];

  for (const group of buttons()) {
    const set = document.createElement('div');
    set.className = 'cm-formatbar-group';
    for (const button of group) {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = button.face;
      element.title = button.label;
      element.setAttribute('aria-label', button.label);
      if (button.look !== undefined) element.classList.add(`is-${button.look}`);
      if (button.kind !== undefined) kinds.push([element, button.kind]);

      // mousedown, not click: by the time a click arrives the editor has lost
      // focus and, on some browsers, the selection the command was meant for.
      element.addEventListener('mousedown', (event) => {
        event.preventDefault();
        button.run(view);
        view.focus();
      });
      set.append(element);
    }
    bar.append(set);
  }

  const mark = (state: EditorState): void => {
    const line = state.doc.lineAt(state.selection.main.from);
    const now = lineKind(line.text);
    for (const [element, kind] of kinds) element.setAttribute('aria-pressed', String(now === kind));
  };
  mark(view.state);

  return {
    dom: bar,
    update: (update) => {
      if (update.selectionSet || update.docChanged) mark(update.state);
    },
  };
}

function barFor(state: EditorState): Tooltip | null {
  const range = state.selection.main;
  if (range.empty || state.readOnly) return null;

  // A drawn table types into its own inputs; a selection over its hidden source
  // is not something a person made on purpose.
  const drawn = state.field(tableBlocks, false) ?? [];
  const line = state.doc.lineAt(range.from).number;
  if (drawn.some((table) => table.firstLine <= line && line <= table.lastLine)) return null;

  return {
    // Anchored at the start of the selection and above it: below, it would sit
    // on the very lines a person is about to read on and select further into.
    pos: range.from,
    above: true,
    strictSide: false,
    arrow: false,
    create: createBar,
  };
}

const barField = StateField.define<Tooltip | null>({
  create: barFor,
  update(value, transaction) {
    if (!transaction.docChanged && !transaction.selection) return value;
    return barFor(transaction.state);
  },
  provide: (field) => showTooltip.from(field),
});

/**
 * Hidden while the mouse button is still down.
 *
 * Without this the bar follows the pointer through a drag-selection and sits on
 * the line the person is trying to reach. It appears when the selection is
 * finished, which is also when it can be used.
 */
const whileSelecting = EditorView.domEventHandlers({
  mousedown(_event, view) {
    view.dom.classList.add('cm-selecting');
    const done = (): void => {
      view.dom.classList.remove('cm-selecting');
      window.removeEventListener('mouseup', done);
    };
    window.addEventListener('mouseup', done);
    return false;
  },
});

export function formatBar() {
  return [barField, whileSelecting];
}
