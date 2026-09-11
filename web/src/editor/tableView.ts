/**
 * The table, drawn — and typed in.
 *
 * Everywhere else in this editor a piece of notation gives way while the cursor
 * is elsewhere and comes back as source the moment you touch it. A table is the
 * one place where that rule fails on its own terms: a row of pipes reveals
 * nothing when it opens up, because unaligned source is no more readable than
 * the rendered thing it replaced. So the table stays drawn, and the cells are
 * where the writing happens.
 *
 * What keeps this from being the rich-text editor v1 threw away:
 *
 *  - CodeMirror remains the editor and the document remains the file's bytes;
 *  - the only thing that exists is a block decoration over the lines the table
 *    occupies, and those same lines are the only thing an edit can write to;
 *  - there is no second document model and no serialiser for the note — a cell
 *    edit is a normal CodeMirror transaction over a line range, indistinguishable
 *    from having typed the pipes by hand.
 *
 * Tables are found textually rather than from the syntax tree (see `./table`),
 * because a block decoration has to be built from the state, and the tree for a
 * long note is still being parsed at that point.
 */

import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { undo, redo } from '@codemirror/commands';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

import {
  findTables,
  inlineTokens,
  serializeTable,
  unescapeCell,
  withCell,
  withRowAfter,
  type TableBlock,
} from './table';

/** The tables of the current document, recomputed when — and only when — it changes. */
export const tableBlocks = StateField.define<TableBlock[]>({
  create: (state) => findTables(state.doc.toString()),
  update: (value, transaction) =>
    transaction.docChanged ? findTables(transaction.state.doc.toString()) : value,
});

function build(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = state.field(tableBlocks).map((table) =>
    Decoration.replace({ widget: new TableWidget(table), block: true }).range(
      state.doc.line(table.firstLine).from,
      state.doc.line(table.lastLine).to,
    ),
  );
  return Decoration.set(ranges, true);
}

const tableDecorations = StateField.define<DecorationSet>({
  create: build,
  update: (value, transaction) => (transaction.docChanged ? build(transaction.state) : value),
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * A block decoration that replaces line breaks cannot come from a view plugin —
 * CodeMirror requires it to be part of the state, since it changes what a block
 * is. That is why this lives in a field of its own rather than beside the rest
 * of live preview.
 */
export function tables(): Extension {
  return [
    tableBlocks,
    tableDecorations,
    // So that arrow keys step over the drawn table rather than into the middle
    // of a row that is not on screen.
    EditorView.atomicRanges.of(
      (view) => view.state.field(tableDecorations, false) ?? Decoration.none,
    ),
  ];
}

/** The table containing a position, if there is one. */
export function tableAt(state: EditorState, pos: number): TableBlock | null {
  const line = state.doc.lineAt(Math.min(pos, state.doc.length)).number;
  return (
    state.field(tableBlocks, false)?.find(
      (table) => table.firstLine <= line && line <= table.lastLine,
    ) ?? null
  );
}

/**
 * Writes a changed table back over the lines it came from.
 *
 * The range is the table's own first and last line, so nothing outside it can
 * be touched even if the serialiser were wrong.
 */
function writeTable(view: EditorView, from: TableBlock, to: TableBlock): void {
  if (view.state.readOnly) return;

  view.dispatch({
    changes: {
      from: view.state.doc.line(from.firstLine).from,
      to: view.state.doc.line(from.lastLine).to,
      insert: serializeTable(to).join('\n'),
    },
    // `input.type` rather than `input`: the history only joins transactions
    // whose user event matches `input.type` or `delete`, so a plain `input`
    // made every keystroke its own undo step — five letters, five undos, where
    // typing the same five letters as text is one.
    userEvent: 'input.type',
  });
}

/**
 * Puts the caret in one cell of the table that starts on `line`.
 *
 * By line number rather than by holding on to an element: a transaction may have
 * replaced the widget's DOM in the meantime, and a stale node would take the
 * focus out of the document altogether.
 */
export function focusCell(view: EditorView, line: number, row: number, column: number): void {
  const input = view.dom.querySelector<HTMLInputElement>(
    `[data-table-line="${line}"] input[data-row="${row}"][data-column="${column}"]`,
  );
  if (input === null) return;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

class TableWidget extends WidgetType {
  constructor(readonly table: TableBlock) {
    super();
  }

  private key(): string {
    return JSON.stringify([this.table.firstLine, this.table.align, this.table.rows]);
  }

  override eq(other: WidgetType): boolean {
    return other instanceof TableWidget && other.key() === this.key();
  }

  override toDOM(view: EditorView): HTMLElement {
    // `tablewrap` and `tablescroll` are the app's own table furniture: one
    // border, one radius, and a wide table scrolling inside itself instead of
    // pushing the pane sideways. Two table looks in one application would be a
    // mistake worth more than the few lines saved here.
    const wrap = document.createElement('div');
    wrap.className = 'cm-table tablewrap tablescroll';
    wrap.dataset['tableLine'] = String(this.table.firstLine);

    const table = document.createElement('table');
    const head = document.createElement('thead');
    const body = document.createElement('tbody');

    this.table.rows.forEach((cells, row) => {
      const line = document.createElement('tr');
      cells.forEach((cell, column) => {
        line.append(this.cell(view, cell, row, column));
      });
      (row === 0 ? head : body).append(line);
    });

    table.append(head, body);
    wrap.append(table);
    return wrap;
  }

  /**
   * Repaints in place rather than being rebuilt, as long as the shape holds.
   *
   * Rebuilding would take the focus out of the cell being typed in after every
   * single keystroke, since each keystroke is a document change and every
   * document change rebuilds the decoration.
   */
  override updateDOM(dom: HTMLElement, _view: EditorView): boolean {
    const rows = dom.querySelectorAll('tr');
    if (rows.length !== this.table.rows.length) return false;

    for (const [row, cells] of this.table.rows.entries()) {
      const line = rows[row];
      if (line === undefined || line.children.length !== cells.length) return false;

      for (const [column, cell] of cells.entries()) {
        const holder = line.children[column];
        const shown = holder?.querySelector('.cm-cellview');
        const input = holder?.querySelector<HTMLInputElement>('input');
        if (shown === null || shown === undefined || input === null || input === undefined) {
          return false;
        }

        shown.replaceChildren(render(cell));

        // The cell being typed in keeps its own text: the document holds the
        // trimmed version, and forcing that back would eat the space somebody
        // just typed. It is only overwritten when the two genuinely disagree,
        // which is what an undo looks like from in here.
        const next = unescapeCell(cell);
        if (input !== dom.ownerDocument.activeElement || next !== input.value.trim()) {
          input.value = next;
        }
      }
    }

    dom.dataset['tableLine'] = String(this.table.firstLine);
    return true;
  }

  /** The cells run their own keyboard; CodeMirror must not also read it. */
  override ignoreEvent(): boolean {
    return true;
  }

  private cell(view: EditorView, text: string, row: number, column: number): HTMLElement {
    const holder = document.createElement(row === 0 ? 'th' : 'td');
    holder.className = 'cm-cell';
    const align = this.table.align[column];
    if (align !== null && align !== undefined) holder.style.textAlign = align;

    const shown = document.createElement('span');
    shown.className = 'cm-cellview';
    shown.append(render(text));

    // An ordinary text input, lying transparently over the drawn cell: typing,
    // selecting, copying and pasting are then the browser's own and need no
    // imitation. It also folds a pasted line break into one line by itself,
    // which is exactly what a table row can survive.
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cm-cellinput';
    input.value = unescapeCell(text);
    input.readOnly = view.state.readOnly;
    input.spellcheck = false;
    input.dataset['row'] = String(row);
    input.dataset['column'] = String(column);
    input.setAttribute('aria-label', `Zelle ${row + 1}/${column + 1}`);

    input.addEventListener('input', () => {
      const table = this.live(view, holder);
      if (table === null) return;
      writeTable(view, table, withCell(table, row, column, input.value));
    });

    input.addEventListener('keydown', (event) =>
      this.keydown(event, view, holder, input, row, column),
    );

    holder.append(shown, input);
    return holder;
  }

  /**
   * The table as the document has it right now.
   *
   * Read back from the state on every edit instead of trusting the copy this
   * widget was built with: an undo, a save from elsewhere or a second cursor can
   * all have moved the lines since, and writing to remembered line numbers would
   * edit whatever happens to be there now.
   */
  private live(view: EditorView, holder: HTMLElement): TableBlock | null {
    try {
      return tableAt(view.state, view.posAtDOM(holder));
    } catch {
      return null;
    }
  }

  private keydown(
    event: KeyboardEvent,
    view: EditorView,
    holder: HTMLElement,
    input: HTMLInputElement,
    row: number,
    column: number,
  ): void {
    const table = this.live(view, holder);
    if (table === null) return;

    const lastRow = table.rows.length - 1;

    if (event.key === 'Tab') {
      // Walked over the cells as they are drawn rather than counted out of the
      // column count: a row may carry one cell more than the header declares,
      // and arithmetic over a width that row does not have skips or repeats a
      // cell. At either end the key is left alone, so Tab still leaves the
      // table the way it leaves any other control.
      const cells = [
        ...(holder.closest('.cm-table')?.querySelectorAll<HTMLInputElement>('input.cm-cellinput') ??
          []),
      ];
      const next = cells[cells.indexOf(input) + (event.shiftKey ? -1 : 1)];
      if (next === undefined) return;

      event.preventDefault();
      next.focus();
      next.setSelectionRange(next.value.length, next.value.length);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (row === lastRow) {
        writeTable(view, table, withRowAfter(table, row));
        focusCell(view, table.firstLine, row + 1, 0);
        return;
      }
      focusCell(view, table.firstLine, row + 1, column);
      return;
    }

    // Escape is the way back out to the prose, since the caret is not in the
    // document while a cell has it.
    if (event.key === 'Escape') {
      event.preventDefault();
      const after = Math.min(table.lastLine + 1, view.state.doc.lines);
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.line(after).from } });
      return;
    }

    // The browser's own undo would take the input's text back without telling
    // the document, and the two would be different from then on.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo(view);
      else undo(view);
      focusCell(view, table.firstLine, row, column);
    }
  }
}

/** A cell's Markdown as elements, with the same classes live preview uses. */
function render(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();

  for (const token of inlineTokens(unescapeCell(text))) {
    if (token.kind === 'text') {
      fragment.append(token.text);
      continue;
    }

    const tag =
      token.kind === 'code'
        ? 'code'
        : token.kind === 'strong'
          ? 'strong'
          : token.kind === 'em'
            ? 'em'
            : 'span';
    const element = document.createElement(tag);
    if (token.kind === 'code') element.className = 'cm-inline-code';
    if (token.kind === 'link') element.className = 'cm-wikilink';
    element.textContent = token.text;
    fragment.append(element);
  }

  return fragment;
}
