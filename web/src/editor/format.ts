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
export function toggleWrap(marker: string): StateCommand {
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
export const insertLink: StateCommand = ({ state, dispatch }) => {
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
 * Turns the selection into a link to a note.
 *
 * The selected words become the target, so `Proxmox Cluster` selected and
 * linked reads `[[Proxmox Cluster]]` — a link to the note of that name if there
 * is one, and an honest dangling link the tidy view will report if there is not.
 * Already bracketed text is unwrapped again, for the same reason bold toggles.
 */
export const linkNote: StateCommand = ({ state, dispatch }) => {
  if (state.selection.ranges.every((range) => range.empty)) return false;

  const update = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    // A link spans one line; a selection over two would become a link nobody
    // can resolve, so it is left as it is.
    if (range.empty || text.includes('\n')) return { range };

    const wrapped =
      state.sliceDoc(range.from - 2, range.from) === '[[' &&
      state.sliceDoc(range.to, range.to + 2) === ']]';
    if (wrapped) {
      return {
        changes: [
          { from: range.from - 2, to: range.from },
          { from: range.to, to: range.to + 2 },
        ],
        range: EditorSelection.range(range.from - 2, range.to - 2),
      };
    }

    return {
      changes: [
        { from: range.from, insert: '[[' },
        { from: range.to, insert: ']]' },
      ],
      range: EditorSelection.range(range.from + 2, range.to + 2),
    };
  });

  dispatch(state.update(update, { scrollIntoView: true, userEvent: 'input' }));
  return true;
};

/**
 * What a line can be turned into.
 *
 * Each is nothing but a prefix, which is what makes "turn into" safe here when
 * it is the most dangerous command in a block editor: the words of the line are
 * never touched, only the few characters in front of them.
 */
export type LineKind =
  | 'paragraph'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'task'
  | 'bullet'
  | 'numbered'
  | 'quote'
  | 'callout';

const PREFIX: Record<LineKind, string> = {
  paragraph: '',
  h1: '# ',
  h2: '## ',
  h3: '### ',
  task: '- [ ] ',
  bullet: '- ',
  numbered: '1. ',
  quote: '> ',
  callout: '> [!note] ',
};

/**
 * Every prefix a line can already carry, longest first so that `- [ ] ` is not
 * read as a bullet with `[ ] ` in its text, and `> [!tip]` not as a quote.
 */
const EXISTING =
  /^(#{1,6} |[-*+] \[[ xX]] |[-*+] |\d+[.)] |> ?\[![\w-]+\][+-]? ?|> ?)/;

/** The kind a line is now, for toggling and for the menu's tick. */
export function lineKind(text: string): LineKind {
  const body = text.replace(/^\s*/, '');
  const prefix = EXISTING.exec(body)?.[0] ?? '';
  if (prefix === '') return 'paragraph';
  if (prefix.startsWith('#')) {
    const level = prefix.trim().length;
    return level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3';
  }
  if (/^> ?\[!/.test(prefix)) return 'callout';
  if (prefix.startsWith('>')) return 'quote';
  if (/\[[ xX]]/.test(prefix)) return 'task';
  if (/^\d/.test(prefix)) return 'numbered';
  return 'bullet';
}

/**
 * Gives every line the selection touches the same kind.
 *
 * Asking for the kind all of them already have means "back to text", like the
 * heading shortcuts. Indentation stays where it is, so a nested list item turned
 * into a task stays nested. A checked task changed into another kind loses its
 * tick — the tick is part of the prefix, and there is nowhere left to keep it.
 */
export function setLineKind(
  kind: LineKind,
  lines?: { from: number; to: number },
  toggle = true,
): StateCommand {
  return ({ state, dispatch }) => {
    const numbers = new Set<number>();
    const ranges = lines === undefined ? state.selection.ranges : [lines];
    for (const range of ranges) {
      const first = state.doc.lineAt(range.from).number;
      const last = state.doc.lineAt(range.to).number;
      for (let n = first; n <= last; n++) numbers.add(n);
    }

    const sorted = [...numbers].sort((a, b) => a - b);
    // A menu that ticks the current kind should not untick it when clicked
    // again — that is what `toggle` is for. The bar and the keys do toggle.
    const all = toggle && sorted.every((n) => lineKind(state.doc.line(n).text) === kind);
    const prefix = all ? '' : PREFIX[kind];

    const changes = sorted.map((n) => {
      const line = state.doc.line(n);
      const indent = /^\s*/.exec(line.text)?.[0] ?? '';
      const existing = EXISTING.exec(line.text.slice(indent.length))?.[0] ?? '';
      const from = line.from + indent.length;
      return { from, to: from + existing.length, insert: prefix };
    });

    const changeSet = state.changes(changes);
    dispatch(
      state.update({
        changes: changeSet,
        // Without a selection given the cursor would stay in front of a prefix
        // that just grew, which is in the middle of the notation.
        selection: lines === undefined ? state.selection.map(changeSet, 1) : undefined,
        scrollIntoView: lines === undefined,
        userEvent: 'input',
      }),
    );
    return true;
  };
}

/**
 * `Mod-e` carries inline code rather than the more obvious backtick: `Mod-\``
 * is unreachable on a Swiss keyboard, where the backtick is a dead key.
 */
export const formatKeymap: readonly KeyBinding[] = [
  { key: 'Mod-b', run: toggleWrap('**') },
  { key: 'Mod-i', run: toggleWrap('*') },
  { key: 'Mod-e', run: toggleWrap('`') },
  { key: 'Mod-Shift-x', run: toggleWrap('~~') },
  { key: 'Mod-Shift-h', run: toggleWrap('==') },
  { key: 'Mod-k', run: insertLink },
  { key: 'Mod-Shift-k', run: linkNote },
  { key: 'Mod-1', run: setHeading(1) },
  { key: 'Mod-2', run: setHeading(2) },
  { key: 'Mod-3', run: setHeading(3) },
];
