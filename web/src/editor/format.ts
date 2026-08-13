/**
 * Keyboard formatting for text that already exists.
 *
 * The `/` menu inserts new structure; it cannot help once something is written
 * and selected, because typing a slash would replace the selection. These
 * bindings cover that half: wrap the selection, or set the level of the line
 * the cursor is on.
 *
 * Wrapping and heading commands are toggles. Pressing bold twice returns the
 * text to what it was, rather than producing `****word****` — the second press
 * is almost always a correction, not a request for more asterisks. Linking
 * cannot toggle in the same way, so it declines to act rather than nesting.
 */

import type { StateCommand } from '@codemirror/state';
import { EditorSelection } from '@codemirror/state';
import type { KeyBinding } from '@codemirror/view';

/** Wraps or unwraps each selection range in a marker such as `**`. */
function toggleWrap(marker: string): StateCommand {
  return ({ state, dispatch }) => {
    const width = marker.length;

    const update = state.changeByRange((range) => {
      const wrapped =
        state.sliceDoc(range.from - width, range.from) === marker &&
        state.sliceDoc(range.to, range.to + width) === marker;

      if (wrapped) {
        return {
          changes: [
            { from: range.from - width, to: range.from },
            { from: range.to, to: range.to + width },
          ],
          range: EditorSelection.range(range.from - width, range.to - width),
        };
      }

      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        // On an empty selection this leaves the cursor between the markers,
        // which is where someone who just pressed bold wants to type.
        range: EditorSelection.range(range.from + width, range.to + width),
      };
    });

    dispatch(state.update(update, { scrollIntoView: true, userEvent: 'input' }));
    return true;
  };
}

/** Sets the heading level of the cursor's line, or clears it if unchanged. */
function setHeading(level: number): StateCommand {
  return ({ state, dispatch }) => {
    const prefix = `${'#'.repeat(level)} `;

    const update = state.changeByRange((range) => {
      const line = state.doc.lineAt(range.head);
      const existing = /^#{1,6} /.exec(line.text)?.[0] ?? '';
      // Asking for the level a line already has means "make this a paragraph".
      const insert = existing === prefix ? '' : prefix;
      const shift = insert.length - existing.length;

      return {
        changes: { from: line.from, to: line.from + existing.length, insert },
        range: EditorSelection.cursor(Math.max(line.from, range.head + shift)),
      };
    });

    dispatch(state.update(update, { scrollIntoView: true, userEvent: 'input' }));
    return true;
  };
}

/**
 * Turns the selection into a link.
 *
 * Which half the selected text belongs in depends on what it looks like: a URL
 * goes in the parentheses and the cursor waits in the label, anything else is
 * the label and the cursor waits for the address.
 */
const insertLink: StateCommand = ({ state, dispatch }) => {
  // Pressing the shortcut a second time lands on the empty half of the link
  // just created — the label or the address. Wrapping that empty selection
  // again would nest a link inside a link (`[Welt]([]())`), which is never what
  // the second press meant. Refusing is the whole fix.
  const idle = state.selection.ranges.every((range) => {
    if (!range.empty) return false;
    const inAddress =
      state.sliceDoc(range.from - 2, range.from) === '](' &&
      state.sliceDoc(range.from, range.from + 1) === ')';
    const inLabel =
      state.sliceDoc(range.from - 1, range.from) === '[' &&
      state.sliceDoc(range.from, range.from + 2) === '](';
    return inAddress || inLabel;
  });
  if (idle) return false;

  const update = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const isUrl = /^(https?:\/\/|mailto:)\S+$/.test(text);
    const insert = isUrl ? `[](${text})` : `[${text}]()`;
    const caret = isUrl ? range.from + 1 : range.from + text.length + 3;

    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(caret),
    };
  });

  dispatch(state.update(update, { scrollIntoView: true, userEvent: 'input' }));
  return true;
};

/**
 * `Mod-e` carries inline code rather than the more obvious backtick: `Mod-\``
 * is unreachable on a Swiss keyboard, where the backtick is a dead key.
 */
export const formatKeymap: readonly KeyBinding[] = [
  { key: 'Mod-b', run: toggleWrap('**') },
  { key: 'Mod-i', run: toggleWrap('*') },
  { key: 'Mod-e', run: toggleWrap('`') },
  { key: 'Mod-k', run: insertLink },
  { key: 'Mod-1', run: setHeading(1) },
  { key: 'Mod-2', run: setHeading(2) },
  { key: 'Mod-3', run: setHeading(3) },
];
