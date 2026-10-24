/**
 * Changing a table's shape: rows and columns inserted, moved, duplicated,
 * cleared and deleted, cells picked as a range, blocks pasted from a
 * spreadsheet, and the arrow keys through and out of the grid.
 *
 * The same promise as `table.test.ts` stands over all of it: whatever the
 * handles do, the file holds a GFM table afterwards and nothing outside the
 * table's lines has changed.
 */

import { undo } from '@codemirror/commands';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import { noteExtensions } from '../src/Editor';
import {
  findTables,
  parseGrid,
  rangeText,
  serializeTable,
  slotAt,
  slotToIndex,
  withAlign,
  withColumnAt,
  withColumnDuplicated,
  withColumnMoved,
  withGrid,
  withRangeCleared,
  withRowAt,
  withRowDuplicated,
  withRowMoved,
  withoutColumn,
  withoutRow,
  type TableBlock,
} from '../src/editor/table';

const GRID = ['| a | b | c |', '| --- | :---: | --- |', '| 1 | 2 | 3 |', '| 4 | 5 | 6 |'].join('\n');

function grid(source = GRID): TableBlock {
  const table = findTables(source)[0];
  if (table === undefined) throw new Error('no table');
  return table;
}

/** What a changed table reads as once it is written and read back. */
function reread(table: TableBlock | null): TableBlock | null {
  if (table === null) return null;
  return findTables(serializeTable(table).join('\n'))[0] ?? null;
}

describe('changing the shape of a table', () => {
  it('inserts a row anywhere, including above the header', () => {
    expect(reread(withRowAt(grid(), 2))?.rows).toEqual([['a', 'b', 'c'], ['1', '2', '3'], ['', '', ''], ['4', '5', '6']]);
    // Above the header: the empty row is the header now, and the old one is
    // still there as the first row of the body.
    expect(reread(withRowAt(grid(), 0))?.rows.slice(0, 2)).toEqual([['', '', ''], ['a', 'b', 'c']]);
  });

  it('inserts a column without moving anybody else\'s alignment', () => {
    const table = reread(withColumnAt(grid(), 1));
    expect(table?.rows[0]).toEqual(['a', '', 'b', 'c']);
    expect(table?.align).toEqual([null, null, 'center', null]);
  });

  it('carries a stray cell beyond the header along with its row', () => {
    const source = '| a | b |\n| --- | --- |\n| 1 | 2 | extra |';
    expect(withColumnAt(grid(source), 0).rows[1]).toEqual(['', '1', '2', 'extra']);
    // Moving a column never takes a cell that belongs to none.
    expect(withColumnMoved(grid(source), 0, 1).rows[1]).toEqual(['2', '1', 'extra']);
  });

  it('deletes a row, and the header with the next row taking its place', () => {
    expect(reread(withoutRow(grid(), 2))?.rows).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
    expect(reread(withoutRow(grid(), 0))?.rows[0]).toEqual(['1', '2', '3']);
  });

  it('deletes a column with its alignment', () => {
    const table = reread(withoutColumn(grid(), 1));
    expect(table?.rows[0]).toEqual(['a', 'c']);
    expect(table?.align).toEqual([null, null]);
  });

  it('answers null for the last row or the last column, which is no table at all', () => {
    expect(withoutRow(grid('| a |\n| --- |'), 0)).toBeNull();
    expect(withoutColumn(grid('| a |\n| --- |\n| 1 |'), 0)).toBeNull();
  });

  it('moves rows and columns to where they are dropped', () => {
    expect(withRowMoved(grid(), 2, 0).rows.map((row) => row[0])).toEqual(['4', 'a', '1']);
    const moved = withColumnMoved(grid(), 0, 2);
    expect(moved.rows[0]).toEqual(['b', 'c', 'a']);
    expect(moved.align).toEqual(['center', null, null]);
  });

  it('duplicates a row below and a column to the right', () => {
    expect(withRowDuplicated(grid(), 1).rows.map((row) => row[0])).toEqual(['a', '1', '1', '4']);
    const table = withColumnDuplicated(grid(), 1);
    expect(table.rows[2]).toEqual(['4', '5', '5', '6']);
    expect(table.align).toEqual([null, 'center', 'center', null]);
  });

  it('writes alignment into the delimiter row', () => {
    const lines = serializeTable(withAlign(grid(), 0, 'right'));
    expect(lines[1]).toMatch(/^\| -+: \| :-+: \| -+ \|$/);
  });
});

describe('ranges and the clipboard', () => {
  const range = { anchor: { row: 2, column: 2 }, head: { row: 1, column: 1 } };

  it('clears a rectangle picked in either direction, and nothing else', () => {
    expect(withRangeCleared(grid(), range).rows).toEqual([['a', 'b', 'c'], ['1', '', ''], ['4', '', '']]);
  });

  it('copies a rectangle as tab-separated lines, unescaping pipes', () => {
    const source = '| a | b |\n| --- | --- |\n| x\\|y | z |';
    expect(rangeText(grid(source), { anchor: { row: 0, column: 0 }, head: { row: 1, column: 1 } })).toBe('a\tb\nx|y\tz');
  });

  it('reads clipboard text the way spreadsheets write it', () => {
    expect(parseGrid('a\tb\r\nc\td\r\n')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseGrid('one')).toEqual([['one']]);
  });

  it('pastes a block over the cells it lands on and grows the table past its edge', () => {
    const table = reread(withGrid(grid(), 2, 2, [['x', 'y'], ['p|q', 'two\nlines']]));
    expect(table?.columns).toBe(4);
    expect(table?.rows).toEqual([
      ['a', 'b', 'c', ''],
      ['1', '2', '3', ''],
      ['4', '5', 'x', 'y'],
      ['', '', 'p\\|q', 'two lines'],
    ]);
  });
});

describe('where a drag lands', () => {
  const spans = [
    { start: 0, end: 10 },
    { start: 10, end: 20 },
    { start: 20, end: 30 },
  ];

  it('finds the gap under the pointer', () => {
    expect(slotAt(spans, 2)).toBe(0);
    expect(slotAt(spans, 12)).toBe(1);
    expect(slotAt(spans, 29)).toBe(3);
  });

  it('leaves an item where it was when dropped right beside itself', () => {
    expect(slotToIndex(1, 1)).toBe(1);
    expect(slotToIndex(1, 2)).toBe(1);
    expect(slotToIndex(1, 3)).toBe(2);
    expect(slotToIndex(1, 0)).toBe(0);
  });
});

/* ---- in the editor ------------------------------------------------------ */

const NOTE = ['# Liste', '', GRID, '', 'Text nach der Tabelle.'].join('\n');

function open(doc: string, readOnly = false): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: noteExtensions({ owner: 'julian', path: 'x.md', readOnly }),
    }),
    parent: document.body,
  });
}

function cell(view: EditorView, row: number, column: number): HTMLInputElement {
  const input = view.dom.querySelector<HTMLInputElement>(`input[data-row="${row}"][data-column="${column}"]`);
  if (input === null) throw new Error(`no cell ${row}/${column}`);
  return input;
}

function press(target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function rows(view: EditorView): string[][] {
  return findTables(view.state.doc.toString())[0]?.rows ?? [];
}

/** Clicks a row's or column's handle and then the menu entry with this label. */
function choose(view: EditorView, kind: 'row' | 'column', index: number, label: string): void {
  const grip = view.dom.querySelector<HTMLButtonElement>(`.cm-table-grip-${kind}[data-${kind}="${index}"]`);
  if (grip === null) throw new Error(`no ${kind} handle ${index}`);
  grip.click();
  const item = [...view.dom.querySelectorAll<HTMLButtonElement>('.cm-table-menu button')].find(
    (button) => button.textContent === label,
  );
  if (item === undefined) throw new Error(`no menu entry ${label}`);
  item.click();
}

function paste(target: Element, text: string, html = ''): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? text : type === 'text/html' ? html : '') },
  });
  target.dispatchEvent(event);
  return event;
}

describe('the handles', () => {
  it('puts one on every column and every row', () => {
    const view = open(NOTE);
    expect(view.dom.querySelectorAll('.cm-table-grip-column')).toHaveLength(3);
    expect(view.dom.querySelectorAll('.cm-table-grip-row')).toHaveLength(3);
    view.destroy();
  });

  it('inserts a row below from the row menu and puts the caret in it', () => {
    const view = open(NOTE);
    choose(view, 'row', 1, 'Insert below');

    expect(rows(view)).toEqual([['a', 'b', 'c'], ['1', '2', '3'], ['', '', ''], ['4', '5', '6']]);
    expect(document.activeElement).toBe(cell(view, 2, 0));
    // Nothing outside the table moved.
    expect(view.state.doc.line(1).text).toBe('# Liste');
    expect(view.state.doc.line(view.state.doc.lines).text).toBe('Text nach der Tabelle.');
    view.destroy();
  });

  it('deletes a column from the column menu', () => {
    const view = open(NOTE);
    choose(view, 'column', 0, 'Delete column');
    expect(rows(view)[0]).toEqual(['b', 'c']);
    view.destroy();
  });

  it('centres a column and shows it without the table being rebuilt', () => {
    const view = open(NOTE);
    choose(view, 'column', 2, 'Align centre');

    expect(findTables(view.state.doc.toString())[0]?.align[2]).toBe('center');
    expect(cell(view, 1, 2).closest('td')?.style.textAlign).toBe('center');
    view.destroy();
  });

  it('takes an alignment off again when it is chosen a second time', () => {
    const view = open(NOTE);
    choose(view, 'column', 1, 'Align centre');
    expect(findTables(view.state.doc.toString())[0]?.align[1]).toBeNull();
    view.destroy();
  });

  it('moves a row down', () => {
    const view = open(NOTE);
    choose(view, 'row', 1, 'Move down');
    expect(rows(view).map((row) => row[0])).toEqual(['a', '4', '1']);
    view.destroy();
  });

  it('removes the whole table with its last row, and the prose closes up', () => {
    const view = open('Vorher\n\n| a |\n| --- |\n\nNachher');
    choose(view, 'row', 0, 'Delete row');
    expect(view.state.doc.toString()).toBe('Vorher\n\n\nNachher');
    view.destroy();
  });

  it('makes each change one step of undo', () => {
    const view = open(NOTE);
    choose(view, 'row', 1, 'Insert below');
    choose(view, 'column', 0, 'Insert left');
    undo(view);
    expect(rows(view)[0]).toEqual(['a', 'b', 'c']);
    expect(rows(view)).toHaveLength(4);
    undo(view);
    expect(view.state.doc.toString()).toBe(NOTE);
    view.destroy();
  });

  it('adds a row and a column from the bars beside the table', () => {
    const view = open(NOTE);
    view.dom.querySelector<HTMLButtonElement>('.cm-table-add-row')?.click();
    expect(rows(view)).toHaveLength(4);
    expect(document.activeElement).toBe(cell(view, 3, 0));

    view.dom.querySelector<HTMLButtonElement>('.cm-table-add-column')?.click();
    expect(rows(view)[0]).toEqual(['a', 'b', 'c', '']);
    view.destroy();
  });

  it('opens the same menu from the keyboard', () => {
    const view = open(NOTE);
    const input = cell(view, 1, 1);
    input.focus();
    press(input, 'F10', { shiftKey: true });

    const labels = [...view.dom.querySelectorAll('.cm-table-menu button')].map((button) => button.textContent);
    expect(labels).toContain('Insert below');
    expect(labels).toContain('Insert right');
    view.destroy();
  });

  it('offers none of it on a note that cannot be written', () => {
    const view = open(NOTE, true);
    expect(view.dom.querySelector('.cm-table')?.classList.contains('is-readonly')).toBe(true);
    view.dom.querySelector<HTMLButtonElement>('.cm-table-grip-row')?.click();
    expect(view.dom.querySelector('.cm-table-menu')).toBeNull();
    view.dom.querySelector<HTMLButtonElement>('.cm-table-add-row')?.click();
    expect(view.state.doc.toString()).toBe(NOTE);
    view.destroy();
  });
});

describe('the arrow keys', () => {
  it('move up and down a column', () => {
    const view = open(NOTE);
    const input = cell(view, 1, 2);
    input.focus();
    press(input, 'ArrowDown');
    expect(document.activeElement).toBe(cell(view, 2, 2));
    press(cell(view, 2, 2), 'ArrowUp');
    expect(document.activeElement).toBe(cell(view, 1, 2));
    view.destroy();
  });

  it('cross into the next cell only from the edge of the text', () => {
    const view = open(NOTE);
    const input = cell(view, 1, 0);
    input.focus();
    input.setSelectionRange(0, 0);
    // Not at the end yet: the caret moves through the text, the browser's job.
    expect(press(input, 'ArrowRight').defaultPrevented).toBe(false);

    input.setSelectionRange(1, 1);
    press(input, 'ArrowRight');
    expect(document.activeElement).toBe(cell(view, 1, 1));
    view.destroy();
  });

  it('leave the table below the last row, into the line after it', () => {
    const view = open(NOTE);
    const input = cell(view, 2, 1);
    input.focus();
    press(input, 'ArrowDown');

    expect(view.hasFocus).toBe(true);
    expect(view.state.selection.main.head).toBe(view.state.doc.line(7).from);
    view.destroy();
  });

  it('make a line to write on when the table ends the note', () => {
    const view = open('Text\n\n' + GRID);
    const input = cell(view, 2, 0);
    input.focus();
    press(input, 'ArrowDown');

    expect(view.state.doc.toString()).toBe('Text\n\n' + GRID + '\n');
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    view.destroy();
  });

  it('go into the table from the line above it', () => {
    // Moving by visual line asks the layout where the lines are, and jsdom has
    // no layout: a range there has no client rects at all. Empty ones are the
    // honest stand-in — one unwrapped line, nothing below it on screen.
    const had = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    try {
      const view = open('Oben\n' + GRID);
      view.focus();
      view.dispatch({ selection: EditorSelection.cursor(2) });
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));

      expect(document.activeElement).toBe(cell(view, 0, 0));
      view.destroy();
    } finally {
      if (had === undefined) delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
      else Object.defineProperty(Range.prototype, 'getClientRects', had);
    }
  });
});

describe('a range of cells', () => {
  it('is picked with Shift and the arrow keys, and cleared with Delete', () => {
    const view = open(NOTE);
    const input = cell(view, 1, 1);
    input.focus();
    press(input, 'ArrowDown', { shiftKey: true });

    const wrap = view.dom.querySelector<HTMLElement>('.cm-table')!;
    expect(document.activeElement).toBe(wrap);
    expect(wrap.querySelectorAll('.cm-cell.is-picked')).toHaveLength(2);

    press(wrap, 'ArrowRight', { shiftKey: true });
    expect(wrap.querySelectorAll('.cm-cell.is-picked')).toHaveLength(4);

    press(wrap, 'Delete');
    expect(rows(view)).toEqual([['a', 'b', 'c'], ['1', '', ''], ['4', '', '']]);
    view.destroy();
  });

  it('lets go on Escape and gives the caret back to where it started', () => {
    const view = open(NOTE);
    const input = cell(view, 1, 1);
    input.focus();
    press(input, 'ArrowDown', { shiftKey: true });
    const wrap = view.dom.querySelector<HTMLElement>('.cm-table')!;
    press(wrap, 'Escape');

    expect(wrap.querySelectorAll('.cm-cell.is-picked')).toHaveLength(0);
    expect(document.activeElement).toBe(cell(view, 1, 1));
    view.destroy();
  });
});

describe('pasting', () => {
  it('fills cells from a spreadsheet block and grows the table where it must', () => {
    const view = open(NOTE);
    const input = cell(view, 2, 1);
    input.focus();
    const event = paste(input, 'x\ty\nz\tw\n');

    expect(event.defaultPrevented).toBe(true);
    expect(rows(view)).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['4', 'x', 'y'],
      ['', 'z', 'w'],
    ]);
    expect(view.state.doc.line(view.state.doc.lines).text).toBe('Text nach der Tabelle.');
    view.destroy();
  });

  it('takes a single spreadsheet column as rows when the clipboard says it is a table', () => {
    const view = open(NOTE);
    paste(cell(view, 1, 0), 'p\nq', '<table><tr><td>p</td></tr><tr><td>q</td></tr></table>');
    expect(rows(view).map((row) => row[0])).toEqual(['a', 'p', 'q']);
    view.destroy();
  });

  it('leaves two lines of prose to the cell, as one line', () => {
    const view = open(NOTE);
    const event = paste(cell(view, 1, 0), 'erste\nzweite');
    // Not taken: the browser pastes into the field, which folds the break.
    expect(event.defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe(NOTE);
    view.destroy();
  });
});
