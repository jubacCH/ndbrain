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
 * This file draws the table and runs the keyboard inside a cell. The handles on
 * rows and columns, their menu, dragging, ranges of cells and the clipboard are
 * in `./tableControls`, which edits through the same `writeTable` as typing does.
 *
 * Tables are found textually rather than from the syntax tree (see `./table`),
 * because a block decoration has to be built from the state, and the tree for a
 * long note is still being parsed at that point.
 */

import { Prec, StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { undo, redo } from '@codemirror/commands';
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from '@codemirror/view';

import { copy } from '../copy';
import {
  findTables,
  inlineTokens,
  serializeTable,
  unescapeCell,
  withCell,
  withRowAfter,
  type TableBlock,
} from './table';
import { TableControls } from './tableControls';

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
 * Arrow keys from the line next to a table go into it.
 *
 * Without this the atomic range below carries the caret straight over the
 * table, and the only way into a cell is the mouse. Only from the visual line
 * that actually borders the table: in a paragraph that wraps, Down on its first
 * line still means the paragraph's next line.
 */
function enterTable(direction: 1 | -1) {
  return (view: EditorView): boolean => {
    const selection = view.state.selection.main;
    if (!selection.empty) return false;

    const line = view.state.doc.lineAt(selection.head);
    const table = view.state
      .field(tableBlocks, false)
      ?.find((candidate) =>
        direction === 1 ? candidate.firstLine === line.number + 1 : candidate.lastLine === line.number - 1,
      );
    if (table === undefined) return false;

    const next = view.moveVertically(selection, direction === 1);
    if (next.head !== selection.head && next.head >= line.from && next.head <= line.to) return false;

    focusCell(view, table.firstLine, direction === 1 ? 0 : table.rows.length - 1, 0);
    return true;
  };
}

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
    Prec.high(
      keymap.of([
        { key: 'ArrowDown', run: enterTable(1) },
        { key: 'ArrowUp', run: enterTable(-1) },
      ]),
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
 * be touched even if the serialiser were wrong. `null` removes the table: its
 * lines and the line break after them, so the prose around it closes up the way
 * it does when a paragraph is deleted.
 *
 * Typing passes `input.type`: the history only joins transactions whose user
 * event matches `input.type` or `delete`, so a plain `input` made every
 * keystroke its own undo step — five letters, five undos, where typing the same
 * five letters as text is one. Everything structural — a row inserted, a column
 * moved — passes plain `input` for the opposite reason: each is one step back.
 */
export function writeTable(
  view: EditorView,
  from: TableBlock,
  to: TableBlock | null,
  userEvent = 'input',
): void {
  if (view.state.readOnly) return;

  const doc = view.state.doc;
  const start = doc.line(from.firstLine).from;
  const end = doc.line(from.lastLine).to;

  if (to === null) {
    const after = from.lastLine < doc.lines ? doc.line(from.lastLine + 1).from : end;
    const before = after === end && start > 0 ? start - 1 : start;
    view.dispatch({ changes: { from: before, to: after }, userEvent: 'delete', selection: { anchor: before } });
    view.focus();
    return;
  }

  view.dispatch({
    changes: { from: start, to: end, insert: serializeTable(to).join('\n') },
    userEvent,
  });
}

/**
 * Puts the caret in one cell of the table that starts on `line`.
 *
 * By line number rather than by holding on to an element: a transaction may have
 * replaced the widget's DOM in the meantime, and a stale node would take the
 * focus out of the document altogether.
 */
export function focusCell(
  view: EditorView,
  line: number,
  row: number,
  column: number,
  caret: 'start' | 'end' | 'all' = 'end',
): void {
  const input = view.dom.querySelector<HTMLInputElement>(
    `[data-table-line="${line}"] input[data-row="${row}"][data-column="${column}"]`,
  );
  if (input === null) return;
  input.focus();
  if (caret === 'all') input.select();
  else if (caret === 'start') input.setSelectionRange(0, 0);
  else input.setSelectionRange(input.value.length, input.value.length);
}

/** Back into the prose above the table, at the end of the line there. */
function leaveAbove(view: EditorView, table: TableBlock): void {
  if (table.firstLine <= 1) return;
  view.focus();
  view.dispatch({ selection: { anchor: view.state.doc.line(table.firstLine - 1).to }, scrollIntoView: true });
}

/**
 * Back into the prose below the table. A table that ends the note gets a line
 * after it first — otherwise the only way to write below a table at the end of
 * a note would be to go and type pipes.
 */
function leaveBelow(view: EditorView, table: TableBlock): void {
  const doc = view.state.doc;
  view.focus();
  if (table.lastLine < doc.lines) {
    view.dispatch({ selection: { anchor: doc.line(table.lastLine + 1).from }, scrollIntoView: true });
    return;
  }
  if (view.state.readOnly) return;
  view.dispatch({
    changes: { from: doc.length, insert: '\n' },
    selection: { anchor: doc.length + 1 },
    userEvent: 'input',
    scrollIntoView: true,
  });
}

/** Each drawn table's controls, so the widget can hand over and clean up. */
const controlsOf = new WeakMap<HTMLElement, TableControls>();

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
    const wrap = document.createElement('div');
    wrap.className = 'cm-table';
    wrap.dataset['tableLine'] = String(this.table.firstLine);

    // `tablewrap` and `tablescroll` are the app's own table furniture: one
    // border, one radius, and a wide table scrolling inside itself instead of
    // pushing the pane sideways. Two table looks in one application would be a
    // mistake worth more than the few lines saved here. They sit on an inner
    // frame so the bars that add a row or a column can live outside it.
    const frame = document.createElement('div');
    frame.className = 'cm-table-frame tablewrap tablescroll';

    const table = document.createElement('table');
    const head = document.createElement('thead');
    const body = document.createElement('tbody');

    this.table.rows.forEach((cells, row) => {
      const line = document.createElement('tr');
      line.dataset['row'] = String(row);
      cells.forEach((cell, column) => {
        line.append(this.cell(view, cell, row, column));
      });
      (row === 0 ? head : body).append(line);
    });

    table.append(head, body);
    frame.append(table);
    wrap.append(frame);

    const live = (): TableBlock | null => {
      try {
        return tableAt(view.state, view.posAtDOM(wrap));
      } catch {
        return null;
      }
    };

    wrap.addEventListener('input', (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || !input.classList.contains('cm-cellinput')) return;
      const current = live();
      if (current === null) return;
      writeTable(
        view,
        current,
        withCell(current, Number(input.dataset['row']), Number(input.dataset['column']), input.value),
        'input.type',
      );
    });

    wrap.addEventListener('keydown', (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || !input.classList.contains('cm-cellinput')) return;
      const current = live();
      if (current === null) return;
      cellKeydown(event, view, wrap, current, input);
    });

    controlsOf.set(
      wrap,
      new TableControls(wrap, view, {
        live,
        write: (from, to) => writeTable(view, from, to),
        focus: (line, row, column, caret) => focusCell(view, line, row, column, caret),
      }),
    );

    return wrap;
  }

  /**
   * Repaints in place rather than being rebuilt, as long as the shape holds.
   *
   * Rebuilding would take the focus out of the cell being typed in after every
   * single keystroke, since each keystroke is a document change and every
   * document change rebuilds the decoration.
   */
  override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const rows = dom.querySelectorAll('tr');
    if (rows.length !== this.table.rows.length) return false;

    for (const [row, cells] of this.table.rows.entries()) {
      const line = rows[row];
      if (line === undefined || line.children.length !== cells.length) return false;

      for (const [column, cell] of cells.entries()) {
        const holder = line.children[column];
        const shown = holder?.querySelector('.cm-cellview');
        const input = holder?.querySelector<HTMLInputElement>('input');
        if (!(holder instanceof HTMLElement) || shown == null || input == null) return false;

        shown.replaceChildren(render(cell));
        // Alignment changes without the shape changing, so it is repainted
        // here too — or a column set to centre would only show it after the
        // next row was added.
        holder.style.textAlign = this.table.align[column] ?? '';

        // The cell being typed in keeps its own text: the document holds the
        // trimmed version, and forcing that back would eat the space somebody
        // just typed. It is only overwritten when the two genuinely disagree,
        // which is what an undo looks like from in here.
        const next = unescapeCell(cell);
        if (input !== dom.ownerDocument.activeElement || next !== input.value.trim()) {
          input.value = next;
        }
        input.readOnly = view.state.readOnly;
      }
    }

    dom.dataset['tableLine'] = String(this.table.firstLine);
    controlsOf.get(dom)?.refresh();
    return true;
  }

  override destroy(dom: HTMLElement): void {
    controlsOf.get(dom)?.destroy();
    controlsOf.delete(dom);
  }

  /** The cells run their own keyboard; CodeMirror must not also read it. */
  override ignoreEvent(): boolean {
    return true;
  }

  private cell(view: EditorView, text: string, row: number, column: number): HTMLElement {
    const holder = document.createElement(row === 0 ? 'th' : 'td');
    holder.className = 'cm-cell';
    holder.dataset['row'] = String(row);
    holder.dataset['column'] = String(column);
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
    input.setAttribute('aria-label', copy.editor.table.cell(row + 1, column + 1));

    holder.append(shown, input);

    // The handles: one on top of every column, one at the start of every row.
    // Inside the cell rather than outside the table, because the frame scrolls
    // and clips — a handle outside it would part from its column the moment a
    // wide table is scrolled.
    if (row === 0 && column < this.table.columns) {
      holder.append(grip('column', column, copy.editor.table.columnHandle(column + 1)));
    }
    if (column === 0) holder.append(grip('row', row, copy.editor.table.rowHandle(row + 1)));

    return holder;
  }
}

function grip(kind: 'row' | 'column', index: number, label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `cm-table-grip cm-table-grip-${kind}`;
  button.dataset['grip'] = kind;
  button.dataset[kind] = String(index);
  // Out of the Tab order: Tab walks the cells, and a handle between every two
  // of them would double the presses. The keyboard reaches the same menu with
  // Shift+F10 in any cell.
  button.tabIndex = -1;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-haspopup', 'menu');
  return button;
}

function cellKeydown(
  event: KeyboardEvent,
  view: EditorView,
  wrap: HTMLElement,
  table: TableBlock,
  input: HTMLInputElement,
): void {
  const row = Number(input.dataset['row']);
  const column = Number(input.dataset['column']);
  const lastRow = table.rows.length - 1;
  const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
  const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
  const modified = event.altKey || event.ctrlKey || event.metaKey;

  if (event.key === 'Tab') {
    // Walked over the cells as they are drawn rather than counted out of the
    // column count: a row may carry one cell more than the header declares,
    // and arithmetic over a width that row does not have skips or repeats a
    // cell. At either end the key is left alone, so Tab still leaves the
    // table the way it leaves any other control.
    const next = step(wrap, input, event.shiftKey ? -1 : 1);
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

  // Up and down move by row, the way they move by line in the prose around the
  // table, and carry on out of it at either end.
  if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !modified) {
    event.preventDefault();
    const down = event.key === 'ArrowDown';
    if (event.shiftKey) {
      controlsOf.get(wrap)?.select({ row, column }, { row: clampRow(row + (down ? 1 : -1), lastRow), column });
      return;
    }
    if (down && row === lastRow) leaveBelow(view, table);
    else if (!down && row === 0) leaveAbove(view, table);
    else focusCell(view, table.firstLine, row + (down ? 1 : -1), column);
    return;
  }

  // Left and right only leave a cell from its edge; inside it they move the
  // caret through the text, as they do in any field.
  if (event.key === 'ArrowLeft' && atStart && !modified && !event.shiftKey) {
    const previous = step(wrap, input, -1);
    if (previous === undefined) return;
    event.preventDefault();
    previous.focus();
    previous.setSelectionRange(previous.value.length, previous.value.length);
    return;
  }
  if (event.key === 'ArrowRight' && atEnd && !modified && !event.shiftKey) {
    const next = step(wrap, input, 1);
    if (next === undefined) return;
    event.preventDefault();
    next.focus();
    next.setSelectionRange(0, 0);
    return;
  }

  // The keyboard's way to what a right click opens.
  if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
    event.preventDefault();
    controlsOf.get(wrap)?.openCellMenu(row, column, input.getBoundingClientRect());
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

/** The cell input `offset` places away in drawing order, if there is one. */
function step(wrap: HTMLElement, input: HTMLInputElement, offset: number): HTMLInputElement | undefined {
  const cells = [...wrap.querySelectorAll<HTMLInputElement>('input.cm-cellinput')];
  return cells[cells.indexOf(input) + offset];
}

function clampRow(row: number, last: number): number {
  return Math.min(Math.max(row, 0), last);
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
