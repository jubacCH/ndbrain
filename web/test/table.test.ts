/**
 * Tables in the editor — and, above all, the file underneath them.
 *
 * The first block is the one that matters. v1 was abandoned because its
 * rich-text experiment could not survive a round trip: frontmatter, tables and
 * task lists came back changed. A table that is *drawn* rather than spelled is
 * the same promise all over again, so it is measured the same way — open a real
 * note, look at it, and demand the bytes back unchanged.
 */

import { undo } from '@codemirror/commands';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import { noteExtensions } from '../src/Editor';
import {
  blankTable,
  escapeCell,
  findTables,
  serializeTable,
  splitCells,
  unescapeCell,
  withCell,
} from '../src/editor/table';

/**
 * A note of the kind this is actually for: frontmatter, an imported blockquote
 * header, a wikilink, tasks, a fenced block that contains something shaped like
 * a table, and a table with every awkward cell in it.
 */
const NOTE = [
  '---',
  'type: project',
  'updated: 2026-09-11',
  '---',
  '',
  '> **type:** project **topic:** homelab',
  '',
  '# MOC — Projekte',
  '',
  'Ein Satz mit [[40_MOCs/MOC — Projekte|einem Wikilink]] und `inline code`.',
  '',
  '- [ ] Offene Aufgabe',
  '- [x] Erledigte Aufgabe',
  '',
  '```ts',
  "const pipe = '|';",
  '| not | a | table |',
  '| --- | --- | --- |',
  '```',
  '',
  '| Projekt | Status | Notiz |',
  '| :--- | :---: | ---: |',
  '| [[Nodeglow]] | aktiv | `a\\|b` |',
  '| [[Castaway]] |  | |',
  '| [[MyAI]] | pausiert |',
  '',
  'Text nach der Tabelle.',
  '',
].join('\n');

/** The first line of the table in NOTE, zero-based — everything before it is prose. */
const TABLE_AT = NOTE.split('\n').indexOf('| Projekt | Status | Notiz |');
const TABLE_LINES = 5;

function open(doc: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: noteExtensions({ owner: 'julian', path: '40_MOCs/MOC — Projekte.md' }),
    }),
    parent: document.body,
  });
  return view;
}

/** The input standing in for one cell. Row 0 is the header. */
function cell(view: EditorView, row: number, column: number): HTMLInputElement {
  const input = view.dom.querySelector<HTMLInputElement>(
    `input[data-row="${row}"][data-column="${column}"]`,
  );
  if (input === null) throw new Error(`no cell ${row}/${column}`);
  return input;
}

function type(input: HTMLInputElement, value: string): void {
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The whitespace a line starts with — in Markdown, that is meaning, not layout. */
function prefix(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

function press(input: HTMLInputElement, key: string, shift = false): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true, cancelable: true }));
}

describe('the file is the truth', () => {
  it('gives a note with a table back byte for byte', () => {
    const view = open(NOTE);
    expect(view.state.doc.toString()).toBe(NOTE);
    view.destroy();
  });

  it('draws the table instead of spelling it, without touching the source', () => {
    const view = open(NOTE);

    const table = view.dom.querySelector('table');
    expect(table).not.toBeNull();
    expect(cell(view, 0, 0).value).toBe('Projekt');
    // The pipes are still in the document, only not on the screen.
    expect(view.state.doc.toString()).toBe(NOTE);
    view.destroy();
  });

  it('keeps the table drawn while the cursor is inside it', () => {
    const view = open(NOTE);
    const start = view.state.doc.line(TABLE_AT + 2).from;
    view.dispatch({ selection: EditorSelection.cursor(start) });

    expect(view.dom.querySelector('table')).not.toBeNull();
    expect(view.state.doc.toString()).toBe(NOTE);
    view.destroy();
  });

  it('changes nothing but the table lines when a cell is edited', () => {
    const view = open(NOTE);
    type(cell(view, 1, 1), 'pausiert');

    const before = NOTE.split('\n');
    const after = view.state.doc.toString().split('\n');

    expect(after.slice(0, TABLE_AT)).toEqual(before.slice(0, TABLE_AT));
    expect(after.slice(TABLE_AT + TABLE_LINES)).toEqual(before.slice(TABLE_AT + TABLE_LINES));
    expect(after.slice(TABLE_AT, TABLE_AT + TABLE_LINES).join('\n')).toContain('pausiert');
    // "Only the table's lines changed" is weaker than it sounds: it is also true
    // of a rewrite that puts those lines back on a different column. What has to
    // hold is that each of them keeps the prefix it had.
    expect(after.slice(TABLE_AT, TABLE_AT + TABLE_LINES).map(prefix)).toEqual(
      before.slice(TABLE_AT, TABLE_AT + TABLE_LINES).map(prefix),
    );
    view.destroy();
  });

  it('takes a run of typing back in one go, not letter by letter', () => {
    const view = open(NOTE);
    const input = cell(view, 1, 1);
    for (const value of ['aktiv2', 'aktiv20', 'aktiv202', 'aktiv2026']) type(input, value);
    expect(view.state.doc.toString()).not.toBe(NOTE);

    undo(view);
    expect(view.state.doc.toString()).toBe(NOTE);
    view.destroy();
  });

  it('keeps the alignment markers a person wrote', () => {
    const view = open(NOTE);
    type(cell(view, 1, 1), 'pausiert');

    const delimiter = view.state.doc.line(TABLE_AT + 2).text;
    expect(delimiter).toMatch(/\|\s*:-+\s*\|\s*:-+:\s*\|\s*-+:\s*\|/);
    view.destroy();
  });

  it('escapes a pipe typed into a cell rather than growing a column', () => {
    const view = open(NOTE);
    type(cell(view, 1, 1), 'a|b');

    expect(view.state.doc.line(TABLE_AT + 3).text).toContain('a\\|b');
    // Still three columns, not four.
    expect(splitCells(view.state.doc.line(TABLE_AT + 3).text)).toHaveLength(3);
    view.destroy();
  });

  it('takes a two-line paste as one line', () => {
    const view = open(NOTE);
    // The browser folds a pasted line break into the input's value before the
    // editor ever sees it; the model folds it again on the way to the file, so
    // neither path can add a row.
    type(cell(view, 1, 1), 'erste\nzweite');

    expect(view.state.doc.toString().split('\n')).toHaveLength(NOTE.split('\n').length);
    expect(view.state.doc.line(TABLE_AT + 3).text).toContain('zweite');

    const table = findTables(NOTE)[0];
    expect(withCell(table!, 1, 1, 'erste\nzweite').rows[1]?.[1]).toBe('erste zweite');
    view.destroy();
  });

  it('leaves a read-only note alone', () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: NOTE,
        extensions: noteExtensions({ owner: 'julian', path: 'x.md', readOnly: true }),
      }),
      parent: document.body,
    });

    expect(cell(view, 1, 1).readOnly).toBe(true);
    type(cell(view, 1, 1), 'geht nicht');
    expect(view.state.doc.toString()).toBe(NOTE);
    view.destroy();
  });
});

/**
 * Indentation is not layout in Markdown. Two spaces put a table inside a list
 * item; four put it inside a code block, where it is not a table at all. A
 * drawn table that came back on column zero would quietly take a row out of its
 * list — or turn somebody's example of a table into a real one.
 */
describe('what is not offered as a table', () => {
  const SHAPES: Array<[string, string]> = [
    ['a table under a bullet', '- Punkt:\n  | a | b |\n  | --- | --- |\n  | 1 | 2 |\n'],
    ['a table under a numbered item', '1. Punkt:\n   | a | b |\n   | --- | --- |\n   | 1 | 2 |\n'],
    ['a table two levels in', '- A\n  - B:\n    | a | b |\n    | --- | --- |\n    | 1 | 2 |\n'],
    ['an indented code block', 'Beispiel:\n\n    | a | b |\n    | --- | --- |\n    | 1 | 2 |\n'],
    ['a quoted table', '> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n'],
  ];

  for (const [what, source] of SHAPES) {
    it(`leaves ${what} as the text it is`, () => {
      const view = open(source);

      // Nothing drawn, so there is no cell an edit could start from.
      expect(view.dom.querySelector('.cm-table')).toBeNull();
      expect(view.state.doc.toString()).toBe(source);
      view.destroy();
    });
  }

  it('finds none of them', () => {
    for (const [, source] of SHAPES) expect(findTables(source)).toEqual([]);
  });
});

describe('reading a table', () => {
  it('splits on unescaped pipes and drops the outer ones', () => {
    expect(splitCells('| a | b |')).toEqual(['a', 'b']);
    expect(splitCells('a | b')).toEqual(['a', 'b']);
    expect(splitCells('| | |')).toEqual(['', '']);
    expect(splitCells('| a \\| b |')).toEqual(['a \\| b']);
  });

  it('reads an unescaped pipe in inline code the way every renderer does', () => {
    // GFM splits the cell here — backticks do not protect a pipe. Showing four
    // columns is the honest reading; pretending otherwise would put something
    // on screen that no other tool agrees with.
    expect(splitCells('| `a|b` | c |')).toEqual(['`a', 'b`', 'c']);
  });

  it('finds the table in a note and leaves the one inside a fence alone', () => {
    const tables = findTables(NOTE);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.firstLine).toBe(TABLE_AT + 1);
    expect(tables[0]?.lastLine).toBe(TABLE_AT + TABLE_LINES);
  });

  it('reads the alignment markers', () => {
    expect(findTables(NOTE)[0]?.align).toEqual(['left', 'center', 'right']);
    expect(findTables('| a |\n| --- |\n| 1 |')[0]?.align).toEqual([null]);
  });

  it('fills a row that is shorter than the header', () => {
    const table = findTables(NOTE)[0];
    // Row 0 is the header, so the body starts at 1.
    expect(table?.rows[3]).toEqual(['[[MyAI]]', 'pausiert', '']);
    expect(table?.rows[2]).toEqual(['[[Castaway]]', '', '']);
  });

  it('needs a delimiter row before it calls something a table', () => {
    expect(findTables('| a | b |\n| c | d |')).toEqual([]);
    expect(findTables('kein | Tisch')).toEqual([]);
  });

  it('leaves a quoted table as source', () => {
    // A table inside a blockquote would need the `>` of every line preserved,
    // and a widget that swallows it would change what the file means.
    expect(findTables('> | a |\n> | --- |\n> | 1 |')).toEqual([]);
  });
});

describe('writing a table', () => {
  it('lines the columns up so the file reads outside ndBrain too', () => {
    const table = findTables('| a | bbbb |\n| --- | --- |\n| ccccc | d |')[0];
    expect(table).toBeDefined();
    expect(serializeTable(table!)).toEqual([
      '| a     | bbbb |',
      '| ----- | ---- |',
      '| ccccc | d    |',
    ]);
  });

  it('keeps left, centre and right while padding them', () => {
    const table = findTables('| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |')[0];
    expect(serializeTable(table!)[1]).toBe('| :--- | :---: | ---: |');
  });

  it('keeps a cell nobody asked about exactly as it was written', () => {
    const source = '| a | b |\n| --- | --- |\n| `x\\|y` | alt |';
    const table = findTables(source)[0];
    const edited = withCell(table!, 1, 1, 'neu');
    expect(serializeTable(edited)[2]).toContain('`x\\|y`');
  });

  it('never drops a cell a row has beyond the header, and never spreads it', () => {
    const table = findTables('| a | b |\n| --- | --- |\n| 1 | 2 | 3 |')[0];
    expect(table?.rows[1]).toEqual(['1', '2', '3']);

    const lines = serializeTable(table!);
    expect(lines[2]).toContain('3');
    // The odd cell stays in the row that has it. Growing the header and the
    // delimiter to match would answer one person's stray pipe by changing the
    // shape of their table.
    expect(splitCells(lines[0] ?? '')).toHaveLength(2);
    expect(splitCells(lines[1] ?? '')).toHaveLength(2);
  });

  it('spells a pipe out of and back into a cell unchanged', () => {
    for (const raw of ['a\\|b', '`code`', 'plain', 'a\\\\b', '[[Ziel]]']) {
      expect(escapeCell(unescapeCell(raw))).toBe(raw);
    }
  });

  it('makes an empty grid of the size asked for', () => {
    expect(blankTable(2, 2).split('\n')).toHaveLength(3);
    expect(blankTable(3, 4).split('\n')).toHaveLength(4);
    expect(splitCells(blankTable(3, 4).split('\n')[0]!)).toHaveLength(4);
  });
});

describe('filling a table in', () => {
  it('moves to the next cell on Tab and back on Shift-Tab', () => {
    const view = open(NOTE);
    const first = cell(view, 1, 0);
    first.focus();
    press(first, 'Tab');
    expect(document.activeElement).toBe(cell(view, 1, 1));

    press(cell(view, 1, 1), 'Tab', true);
    expect(document.activeElement).toBe(cell(view, 1, 0));
    view.destroy();
  });

  it('wraps to the next row at the end of one', () => {
    const view = open(NOTE);
    const last = cell(view, 1, 2);
    last.focus();
    press(last, 'Tab');
    expect(document.activeElement).toBe(cell(view, 2, 0));
    view.destroy();
  });

  it('walks a row that carries one cell more than the header', () => {
    const view = open('| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n');
    const second = cell(view, 1, 1);
    second.focus();
    press(second, 'Tab');

    expect(document.activeElement).toBe(cell(view, 1, 2));
    view.destroy();
  });

  it('lets Tab out of the table at the last cell', () => {
    const view = open('| a | b |\n| --- | --- |\n| 1 | 2 |\n');
    const last = cell(view, 1, 1);
    last.focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    last.dispatchEvent(event);

    // Not claimed: Tab goes on meaning what it means everywhere else.
    expect(event.defaultPrevented).toBe(false);
    view.destroy();
  });

  it('adds a row with the same columns on Enter in the last one', () => {
    const view = open(NOTE);
    const lines = view.state.doc.lines;
    const last = cell(view, 3, 2);
    last.focus();
    press(last, 'Enter');

    expect(view.state.doc.lines).toBe(lines + 1);
    // Header plus four body rows.
    expect(findTables(view.state.doc.toString())[0]?.rows).toHaveLength(5);
    expect(document.activeElement).toBe(cell(view, 4, 0));
    view.destroy();
  });

  it('leaves Tab and Enter alone outside a table', () => {
    // The one thing that must not break: Tab is indentation and Enter is a new
    // line everywhere else in the note.
    const view = open('- eine Liste\n');
    view.dispatch({ selection: EditorSelection.cursor(12) });
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    expect(view.state.doc.toString()).toBe('- eine Liste\n- \n');
    view.destroy();
  });
});
