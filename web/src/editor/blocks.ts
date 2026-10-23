/**
 * Blocks: the paragraphs, headings, list items, quotes, code fences and tables
 * a note is made of — and the edits that move them as a whole.
 *
 * A block editor keeps blocks as its document. This one has no such thing: the
 * document is the file's text, and a "block" is only a line range that the
 * Markdown grammar says belongs together, worked out fresh each time it is
 * needed. Moving one is cutting those lines and pasting them elsewhere in one
 * transaction — exactly what somebody could do with the keyboard, so undo,
 * saving and a concurrent agent write all see an ordinary edit.
 *
 * Everything here is a pure function of the state, so the rules can be tested
 * without a browser; `./blockHandle` is the part with a pointer.
 */

import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { ChangeSpec, EditorState, TransactionSpec } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';

import { lineKind, setLineKind, type LineKind } from './format';

export interface Block {
  /** Start of the block's first line. */
  from: number;
  /** End of the block's last line, before its newline. */
  to: number;
  /**
   * A list item. Items sit next to each other without a blank line between
   * them; everything else needs one, or two paragraphs run together.
   */
  item: boolean;
}

/** The end of a frontmatter block, which is addressing and never a block. */
function frontmatterEnd(state: EditorState): number {
  if (state.doc.lines < 2 || state.doc.line(1).text.trim() !== '---') return -1;
  for (let n = 2; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (line.text.trim() === '---') return line.to;
  }
  return -1;
}

/** The last line a node really covers — `to` can sit at the next line's start. */
function lastLine(state: EditorState, node: SyntaxNode): number {
  const end = node.to > node.from && state.doc.lineAt(node.to).from === node.to ? node.to - 1 : node.to;
  return state.doc.lineAt(end).to;
}

/**
 * The block the line at `pos` belongs to.
 *
 * A list item is its own block, children included, so dragging a task carries
 * its sub-tasks with it — the innermost item that *starts* on this line wins, so
 * a sub-item can also be dragged out on its own. Anything else is the top-level
 * node: a whole paragraph, table or code fence, never one line of it.
 */
export function blockAt(state: EditorState, pos: number): Block | null {
  const line = state.doc.lineAt(pos);
  if (line.text.trim() === '' || line.to <= frontmatterEnd(state)) return null;

  const tree = ensureSyntaxTree(state, line.to, 50) ?? syntaxTree(state);
  const indent = /^\s*/.exec(line.text)?.[0].length ?? 0;

  let item: SyntaxNode | null = null;
  let top: SyntaxNode | null = null;
  for (let node: SyntaxNode | null = tree.resolveInner(line.from + indent, 1); node; node = node.parent) {
    if (node.name === 'Document') break;
    if (node.name === 'ListItem' && item === null && state.doc.lineAt(node.from).number === line.number) {
      item = node;
    }
    top = node;
  }

  const chosen = item ?? top;
  if (chosen === null) return { from: line.from, to: line.to, item: false };
  return {
    from: state.doc.lineAt(chosen.from).from,
    to: lastLine(state, chosen),
    item: item !== null,
  };
}

/** The `ListItem` node that starts on the line at `pos`, innermost first. */
function itemAt(state: EditorState, pos: number): SyntaxNode | null {
  const line = state.doc.lineAt(pos);
  const indent = /^\s*/.exec(line.text)?.[0].length ?? 0;
  const tree = ensureSyntaxTree(state, line.to, 50) ?? syntaxTree(state);
  for (let node: SyntaxNode | null = tree.resolveInner(line.from + indent, 1); node; node = node.parent) {
    if (node.name === 'ListItem' && state.doc.lineAt(node.from).number === line.number) return node;
  }
  return null;
}

/**
 * The block before or after this one, skipping blank lines.
 *
 * For a list item that is its sibling in the same list. Going up from an item,
 * the line above is usually the last child of the previous item, and swapping
 * with that child would tear the previous item apart.
 */
export function neighbour(state: EditorState, block: Block, direction: -1 | 1): Block | null {
  let n = state.doc.lineAt(direction === -1 ? block.from : block.to).number + direction;
  while (n >= 1 && n <= state.doc.lines && state.doc.line(n).text.trim() === '') n += direction;
  if (n < 1 || n > state.doc.lines) return null;
  const line = state.doc.line(n);

  const list = block.item ? itemAt(state, block.from)?.parent ?? null : null;
  if (list !== null) {
    const indent = /^\s*/.exec(line.text)?.[0].length ?? 0;
    const tree = ensureSyntaxTree(state, line.to, 50) ?? syntaxTree(state);
    for (let node: SyntaxNode | null = tree.resolveInner(line.from + indent, 1); node; node = node.parent) {
      if (node.name === 'ListItem' && node.parent?.from === list.from && node.parent.to === list.to) {
        return { from: state.doc.lineAt(node.from).from, to: lastLine(state, node), item: true };
      }
    }
  }

  return blockAt(state, line.from);
}

/** The newlines a block needs around it: one between items, a blank line otherwise. */
function separator(a: Block, b: Block): string {
  return a.item && b.item ? '\n' : '\n\n';
}

/**
 * The range a block occupies including the gap it leaves behind.
 *
 * Taking a paragraph out must also take one blank line, or the note collects a
 * growing stack of empty lines where things used to be.
 */
function removal(state: EditorState, block: Block): { from: number; to: number } {
  const doc = state.doc;
  if (block.to < doc.length) {
    let to = block.to + 1;
    if (!block.item && to < doc.length && doc.lineAt(to).text.trim() === '') {
      to = Math.min(doc.length, doc.lineAt(to).to + 1);
    }
    return { from: block.from, to };
  }
  // The last block: the newline that goes is the one in front of it.
  let from = Math.max(0, block.from - 1);
  if (!block.item && from > 0 && doc.lineAt(from).text.trim() === '') {
    from = Math.max(0, doc.lineAt(from).from - 1);
  }
  return { from, to: block.to };
}

/**
 * Moves a block before or after another one.
 *
 * Null when the move would not change anything — dropping a block onto itself
 * or onto the gap it already sits in — so the caller does not record an empty
 * edit in the undo history.
 */
export function moveBlock(
  state: EditorState,
  source: Block,
  target: Block,
  place: 'before' | 'after',
): TransactionSpec | null {
  if (target.from === source.from) return null;
  const cut = removal(state, source);
  const at = place === 'before' ? target.from : target.to;
  if (at >= cut.from && at <= cut.to) return null;
  if (target.from >= source.from && target.to <= source.to) return null;

  const text = state.sliceDoc(source.from, source.to);
  const gap = separator(source, target);
  const insert = place === 'before' ? text + gap : gap + text;
  const changes: ChangeSpec[] = [
    { from: cut.from, to: cut.to },
    { from: at, insert },
  ];

  const changeSet = state.changes(changes);
  const landed = changeSet.mapPos(at, place === 'before' ? -1 : 1) + (place === 'before' ? 0 : gap.length);
  return {
    changes: changeSet,
    selection: { anchor: Math.min(landed, changeSet.newLength) },
    scrollIntoView: true,
    userEvent: 'move.drop',
  };
}

/** A copy of the block, straight after it. */
export function duplicateBlock(state: EditorState, block: Block): TransactionSpec {
  const text = state.sliceDoc(block.from, block.to);
  const gap = separator(block, block);
  return {
    changes: { from: block.to, insert: gap + text },
    selection: { anchor: block.to + gap.length },
    scrollIntoView: true,
    userEvent: 'input.copy',
  };
}

export function deleteBlock(state: EditorState, block: Block): TransactionSpec {
  const cut = removal(state, block);
  return {
    changes: cut,
    selection: { anchor: Math.min(cut.from, state.doc.length - (cut.to - cut.from)) },
    userEvent: 'delete',
  };
}

/**
 * Turns a block into another kind.
 *
 * The kind belongs to the block's first line — a heading or a task is one line
 * long, and a list item's children stay what they are. Quotes and callouts are
 * the exception: every line of them carries the `>`, so every line gets it, and
 * every line loses it again when the block is turned back into text.
 */
export function turnBlockInto(state: EditorState, block: Block, kind: LineKind): TransactionSpec | null {
  const first = state.doc.lineAt(block.from);
  const last = state.doc.lineAt(block.to);
  const was = lineKind(first.text);
  const quoted = kind === 'quote' || kind === 'callout';
  const wasQuoted = was === 'quote' || was === 'callout';

  // The first line goes through the same command the bar and the keys use, so
  // there is one definition of what a heading prefix is.
  const head: ChangeSpec[] = [];
  setLineKind(kind, { from: first.from, to: first.to }, false)({
    state,
    dispatch: (transaction) => {
      head.push(transaction.changes);
    },
  });
  if (head.length === 0) return null;

  // The rest of a multi-line quote or paragraph.
  const rest: ChangeSpec[] = [];
  if (quoted !== wasQuoted) {
    for (let n = first.number + 1; n <= last.number; n++) {
      const line = state.doc.line(n);
      if (quoted) {
        rest.push({ from: line.from, insert: '> ' });
      } else {
        const marker = /^\s*>\s?/.exec(line.text)?.[0] ?? '';
        if (marker !== '') rest.push({ from: line.from, to: line.from + marker.length });
      }
    }
  }

  // All of them against the original document, which is what one `changes`
  // array means — they touch different lines and cannot overlap.
  const changes = state.changes([...head, ...rest]);
  if (changes.empty) return null;
  return { changes, userEvent: 'input' };
}
