/**
 * Reading and writing GFM tables, as text.
 *
 * Everything here works on lines of Markdown and hands back lines of Markdown.
 * There is no document model, no AST and nothing that could be called a
 * serialiser for the file: the table the editor draws is built from these
 * functions, and every edit made in it comes back through them as a change to
 * the very lines it came from. That is the whole reason a drawn table is
 * defensible here after v1's rich-text round trip destroyed frontmatter, tables
 * and task lists — the bytes never leave the file's own representation.
 *
 * The splitting rule is taken from the GFM parser this editor already runs
 * (`@lezer/markdown`): cells end at an unescaped `|`, and a backtick does *not*
 * protect one. Reading it any other way would draw a table that disagrees with
 * every other renderer, including the one in this project's own note preview.
 */

export type Align = 'left' | 'center' | 'right' | null;

export interface TableBlock {
  /** 1-based, the way CodeMirror numbers lines. */
  firstLine: number;
  lastLine: number;
  columns: number;
  /** One entry per column, from the delimiter row. */
  align: Align[];
  /** `rows[0]` is the header; the rest are body rows. Cell text as written. */
  rows: string[][];
}

/**
 * A delimiter row: `| --- | :---: |`, starting on column zero.
 *
 * The column matters as much as the pipes. In Markdown leading whitespace is
 * meaning: two spaces put a table inside a list item, four put it inside a code
 * block where it is not a table at all. See `findTables`.
 */
const DELIMITER = /^\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/;

/** Opens or closes a fenced code block. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * The cells of one row, trimmed, with the outer pipes dropped.
 *
 * `| a | b |`, `a | b` and `|a|b|` all mean the same two cells — a leading or
 * trailing pipe is punctuation, an inner one is a boundary. An empty cell is
 * still a cell, which is why the blank segment is only dropped at the ends.
 */
export function splitCells(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let escaped = false;

  for (const character of line) {
    if (character === '|' && !escaped) {
      parts.push(current);
      current = '';
    } else {
      current += character;
    }
    escaped = !escaped && character === '\\';
  }
  parts.push(current);

  if (parts.length > 1 && (parts[0] ?? '').trim() === '') parts.shift();
  if (parts.length > 0 && (parts[parts.length - 1] ?? '').trim() === '') parts.pop();

  return parts.map((part) => part.trim());
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (left) return 'left';
  if (right) return 'right';
  return null;
}

/** Anything with an unescaped pipe in it could be a row. */
function hasPipe(line: string): boolean {
  return splitCells(line).length > 0 && /(?<!\\)\|/.test(line);
}

/**
 * A line that continues the table.
 *
 * A pipe is required, which is marginally stricter than the GFM parser: that one
 * treats the line right after a table as one more row even with no pipe in it,
 * and would pull the first sentence of the next paragraph into the table when
 * somebody forgets the blank line. Stopping instead leaves that sentence as the
 * prose it plainly is, and — this being the point — leaves it out of anything a
 * cell edit could rewrite.
 */
function isBody(line: string): boolean {
  return (
    line.trim() !== '' &&
    !/^[ \t]/.test(line) &&
    !line.startsWith('>') &&
    !FENCE.test(line) &&
    hasPipe(line)
  );
}

/**
 * Every table in a note, in the order they appear.
 *
 * Found by shape rather than from the syntax tree, for two reasons. The tree is
 * parsed in the background and arrives late on a long note, which would make
 * tables blink into existence a beat after the text; and the block decoration
 * that draws a table has to be built from the state, where the tree may not be
 * finished yet. Lines are cheap and always available.
 *
 * Fenced code and frontmatter are skipped: a pipe table in a fence is an example
 * of a table, not a table.
 *
 * Only tables on column zero are offered, for the same reason a blockquoted one
 * is left alone: the whitespace in front of the line is part of what the line
 * means. A drawn table has to be written back as whole lines, and whole lines
 * put back on column zero would lift a table out of the list item it belongs to
 * — or, at four spaces, turn somebody's *example* of a table into a real one by
 * ending the code block it was written in. Telling those two apart needs the
 * block context a line scanner deliberately does not have, so neither is taken.
 * They keep the source presentation they have always had.
 */
export function findTables(source: string): TableBlock[] {
  const lines = source.split('\n');
  const tables: TableBlock[] = [];

  let index = 0;

  // Frontmatter first: it is delimited by `---`, which is also a table's
  // business, and it is never a table.
  if (lines[0]?.trim() === '---') {
    index = 1;
    while (index < lines.length && lines[index]?.trim() !== '---') index++;
    index++;
  }

  for (; index < lines.length; index++) {
    const line = lines[index] ?? '';

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? '```';
      index++;
      while (index < lines.length && !(lines[index] ?? '').trimStart().startsWith(marker)) index++;
      continue;
    }

    const next = lines[index + 1];
    if (next === undefined || !isBody(line) || !DELIMITER.test(next)) continue;

    const header = splitCells(line);
    const delimiter = splitCells(next);
    if (header.length === 0 || header.length !== delimiter.length) continue;

    const rows = [header];
    let last = index + 1;
    for (let n = index + 2; n < lines.length && isBody(lines[n] ?? ''); n++) {
      rows.push(splitCells(lines[n] ?? ''));
      last = n;
    }

    // The table has as many columns as its header declares. A row may still
    // carry more cells than that: GFM drops them, and this keeps them, because
    // dropping text that is in the file is the failure this whole approach is
    // supposed to make impossible. They stay in the row that has them — see
    // `serializeTable`.
    const columns = header.length;

    tables.push({
      firstLine: index + 1,
      lastLine: last + 1,
      columns,
      align: Array.from({ length: columns }, (_, column) => alignOf(delimiter[column] ?? '')),
      rows: rows.map((row) => padRow(row, columns)),
    });

    index = last;
  }

  return tables;
}

/** Short rows are filled up to the header; a long one keeps what it has. */
function padRow(row: string[], columns: number): string[] {
  return Array.from({ length: Math.max(columns, row.length) }, (_, column) => row[column] ?? '');
}

/** Counted in characters, which is what padding with spaces lines up. */
function width(cell: string): number {
  return [...cell].length;
}

/** The narrowest delimiter that can still carry its marker. */
function minimumWidth(align: Align): number {
  if (align === 'center') return 5;
  return align === null ? 3 : 4;
}

function delimiterCell(align: Align, size: number): string {
  if (align === 'center') return `:${'-'.repeat(size - 2)}:`;
  if (align === 'left') return `:${'-'.repeat(size - 1)}`;
  if (align === 'right') return `${'-'.repeat(size - 1)}:`;
  return '-'.repeat(size);
}

function row(cells: string[], widths: number[]): string {
  const padded = cells.map((cell, column) => cell + ' '.repeat((widths[column] ?? 0) - width(cell)));
  return `| ${padded.join(' | ')} |`;
}

/**
 * A table back to Markdown, with the columns lined up.
 *
 * Alignment is not decoration. Since the table is always drawn in ndBrain, the
 * only places its source is ever read are a file manager, Obsidian and `git
 * diff` — and there a ragged table is unreadable and a one-cell change shows up
 * as a whole-table rewrite. This only ever runs when something was actually
 * edited; merely looking at a note writes nothing at all.
 */
export function serializeTable(table: TableBlock): string[] {
  const across = table.rows.reduce((most, cells) => Math.max(most, cells.length), table.columns);
  const widths = Array.from({ length: across }, (_, column) =>
    table.rows.reduce(
      (widest, cells) => Math.max(widest, width(cells[column] ?? '')),
      minimumWidth(table.align[column] ?? null),
    ),
  );

  const [header = [], ...body] = table.rows;
  return [
    // Header and delimiter keep the table's own width. Widening them to cover a
    // stray cell somewhere below would answer one loose pipe by changing the
    // shape of the whole table.
    row(header.slice(0, table.columns), widths),
    row(
      table.align.map((align, column) => delimiterCell(align, widths[column] ?? 3)),
      widths,
    ),
    ...body.map((cells) => row(cells, widths)),
  ];
}

/**
 * `\|` is the only escape a table cell has of its own.
 *
 * Anything else — `\\`, or a backslash before an ordinary letter — is left
 * exactly as written, so a cell nobody edited comes back identical. The pair is
 * lossless in both directions for every text a cell can hold; the one thing it
 * cannot represent is a literal backslash directly before a pipe, which no GFM
 * table can express either.
 */
export function unescapeCell(raw: string): string {
  return raw.replace(/\\\|/g, '|');
}

export function escapeCell(text: string): string {
  return text.replace(/\\?\|/g, '\\|');
}

/**
 * One cell replaced.
 *
 * Line breaks become spaces rather than being refused: pasting two lines into a
 * cell is a thing people do, and the alternative to folding them is a paste that
 * tears the table in half.
 */
export function withCell(table: TableBlock, rowIndex: number, column: number, value: string): TableBlock {
  const cell = cellSource(value);
  return {
    ...table,
    rows: table.rows.map((cells, index) =>
      index === rowIndex ? cells.map((old, at) => (at === column ? cell : old)) : cells,
    ),
  };
}

/** What a typed or pasted value becomes in the file: one line, pipes escaped. */
function cellSource(value: string): string {
  return escapeCell(value.replace(/[\r\n\t]+/g, ' ').trim());
}

/** A new empty row after `rowIndex`, with the same number of columns. */
export function withRowAfter(table: TableBlock, rowIndex: number): TableBlock {
  return withRowAt(table, rowIndex + 1);
}

/*
 * Rows and columns, the way the handles in the drawn table change them.
 *
 * The first row is the header only because GFM needs one; to a person it is
 * the top row of a grid, and AFFiNE, which these follow, has no header at all.
 * So the header is a row like any other here: inserting above it, moving a row
 * to the top or deleting it simply makes another row the header. The
 * alternative — a row that can be neither moved nor removed — reads as a bug.
 *
 * Anything that would leave no row or no column at all answers `null`, which
 * the view takes as "remove the table": a table without cells is not a thing
 * Markdown can write.
 */

function emptyRow(table: TableBlock): string[] {
  return Array.from({ length: table.columns }, () => '');
}

/** An empty row that ends up at `index`; 0 puts it above the header. */
export function withRowAt(table: TableBlock, index: number): TableBlock {
  const rows = [...table.rows];
  rows.splice(clamp(index, 0, rows.length), 0, emptyRow(table));
  return { ...table, rows };
}

/** An empty column that ends up at `index`, unaligned. */
export function withColumnAt(table: TableBlock, index: number): TableBlock {
  const at = clamp(index, 0, table.columns);
  const align = [...table.align];
  align.splice(at, 0, null);
  return {
    ...table,
    columns: table.columns + 1,
    align,
    // Every row has at least `columns` cells (see `padRow`), so `at` is always
    // inside it; a stray cell beyond the header moves right with its row.
    rows: table.rows.map((cells) => [...cells.slice(0, at), '', ...cells.slice(at)]),
  };
}

export function withoutRow(table: TableBlock, index: number): TableBlock | null {
  if (table.rows.length <= 1) return null;
  return { ...table, rows: table.rows.filter((_, at) => at !== index) };
}

export function withoutColumn(table: TableBlock, index: number): TableBlock | null {
  if (table.columns <= 1) return null;
  return {
    ...table,
    columns: table.columns - 1,
    align: table.align.filter((_, at) => at !== index),
    rows: table.rows.map((cells) => cells.filter((_, at) => at !== index)),
  };
}

/** A copy of the row directly below it. */
export function withRowDuplicated(table: TableBlock, index: number): TableBlock {
  const source = table.rows[index];
  if (source === undefined) return table;
  const rows = [...table.rows];
  rows.splice(index + 1, 0, [...source]);
  return { ...table, rows };
}

/** A copy of the column directly to its right, alignment included. */
export function withColumnDuplicated(table: TableBlock, index: number): TableBlock {
  if (index < 0 || index >= table.columns) return table;
  const align = [...table.align];
  align.splice(index + 1, 0, table.align[index] ?? null);
  return {
    ...table,
    columns: table.columns + 1,
    align,
    rows: table.rows.map((cells) => [...cells.slice(0, index + 1), cells[index] ?? '', ...cells.slice(index + 1)]),
  };
}

/**
 * The row at `from` taken out and put back so that it ends up at `to`.
 *
 * `to` is the row's index afterwards, not a gap between rows — see
 * `slotToIndex` for turning a drop position into one.
 */
export function withRowMoved(table: TableBlock, from: number, to: number): TableBlock {
  return { ...table, rows: moved(table.rows, from, clamp(to, 0, table.rows.length - 1)) };
}

/**
 * Columns move within the header's width. A cell some row carries beyond it
 * stays where it is: it belongs to no column, so no column can take it along.
 */
export function withColumnMoved(table: TableBlock, from: number, to: number): TableBlock {
  const target = clamp(to, 0, table.columns - 1);
  if (from < 0 || from >= table.columns || from === target) return table;
  return {
    ...table,
    align: moved(table.align, from, target),
    rows: table.rows.map((cells) => [
      ...moved(cells.slice(0, table.columns), from, target),
      ...cells.slice(table.columns),
    ]),
  };
}

export function withAlign(table: TableBlock, column: number, align: Align): TableBlock {
  return { ...table, align: table.align.map((old, at) => (at === column ? align : old)) };
}

/** A rectangle of cells, both corners included, in either order. */
export interface CellRange {
  anchor: { row: number; column: number };
  head: { row: number; column: number };
}

export function rangeBounds(range: CellRange): { top: number; bottom: number; left: number; right: number } {
  return {
    top: Math.min(range.anchor.row, range.head.row),
    bottom: Math.max(range.anchor.row, range.head.row),
    left: Math.min(range.anchor.column, range.head.column),
    right: Math.max(range.anchor.column, range.head.column),
  };
}

/** Every cell inside the range emptied; the shape stays. */
export function withRangeCleared(table: TableBlock, range: CellRange): TableBlock {
  const { top, bottom, left, right } = rangeBounds(range);
  return {
    ...table,
    rows: table.rows.map((cells, row) =>
      row < top || row > bottom ? cells : cells.map((cell, column) => (column < left || column > right ? cell : '')),
    ),
  };
}

export function withRowCleared(table: TableBlock, index: number): TableBlock {
  const last = Math.max(table.columns, table.rows[index]?.length ?? 0) - 1;
  return withRangeCleared(table, { anchor: { row: index, column: 0 }, head: { row: index, column: last } });
}

export function withColumnCleared(table: TableBlock, index: number): TableBlock {
  return withRangeCleared(table, {
    anchor: { row: 0, column: index },
    head: { row: table.rows.length - 1, column: index },
  });
}

/**
 * A range as tab-separated text — what a spreadsheet puts on the clipboard,
 * and so what one takes back. Cells are given as a person reads them, with the
 * `\|` of the file undone.
 */
export function rangeText(table: TableBlock, range: CellRange): string {
  const { top, bottom, left, right } = rangeBounds(range);
  const lines: string[] = [];
  for (let row = top; row <= bottom; row++) {
    const cells: string[] = [];
    for (let column = left; column <= right; column++) cells.push(unescapeCell(table.rows[row]?.[column] ?? ''));
    lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}

/**
 * Clipboard text read as a grid of cells.
 *
 * Lines are rows and tabs are cells, which is the format Excel, Numbers,
 * Google Sheets and AFFiNE all write. A final line break is the end of the
 * last row, not an empty row after it.
 */
export function parseGrid(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => line.split('\t'));
}

/**
 * A grid written into the table with its top left corner at (`row`, `column`),
 * growing the table where the grid reaches past it — the way pasting a block
 * of a spreadsheet into one does.
 */
export function withGrid(table: TableBlock, row: number, column: number, grid: string[][]): TableBlock {
  const across = grid.reduce((most, cells) => Math.max(most, cells.length), 0);
  const columns = Math.max(table.columns, column + across);
  const align = Array.from({ length: columns }, (_, at) => table.align[at] ?? null);

  const height = Math.max(table.rows.length, row + grid.length);
  const rows = Array.from({ length: height }, (_, at) => {
    const cells = padRow(table.rows[at] ?? [], columns);
    const pasted = grid[at - row];
    if (pasted === undefined) return cells;
    return cells.map((cell, index) => {
      const value = pasted[index - column];
      return value === undefined ? cell : cellSource(value);
    });
  });

  return { ...table, columns, align, rows };
}

/**
 * Where a dragged row or column lands.
 *
 * `slot` is the gap the pointer is over — 0 before the first, n after the last
 * — and the answer is the index the moved item has once it is there. Dropping
 * into either gap beside an item leaves it where it was.
 */
export function slotToIndex(from: number, slot: number): number {
  return slot > from ? slot - 1 : slot;
}

/** Which gap a pointer coordinate is in, given each item's start and end. */
export function slotAt(spans: Array<{ start: number; end: number }>, pointer: number): number {
  let slot = 0;
  for (const span of spans) if (pointer > (span.start + span.end) / 2) slot++;
  return slot;
}

function moved<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined) return [...items];
  next.splice(to, 0, item);
  return next;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** An empty grid, `rows` including the header. */
export function blankTable(rows: number, columns: number): string {
  const empty = Array.from({ length: Math.max(1, rows) }, () =>
    Array.from({ length: Math.max(1, columns) }, () => ''),
  );

  return serializeTable({
    firstLine: 1,
    lastLine: 1,
    columns: Math.max(1, columns),
    align: Array.from({ length: Math.max(1, columns) }, () => null),
    rows: empty,
  }).join('\n');
}

export type Token =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string };

/**
 * Just enough inline Markdown to draw a cell.
 *
 * Deliberately not a Markdown renderer: the project has none and is not getting
 * one for the sake of table cells. These five are what actually appears in them
 * — a wikilink above all, since half this vault's tables are lists of links —
 * and anything else stays the text it is, which is the safe way to be wrong.
 */
const INLINE =
  /(`[^`]+`)|(!?\[\[[^\]\n]+]])|(\[[^\]\n]*]\([^)\n]*\))|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)/g;

export function inlineTokens(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;

  INLINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > at) tokens.push({ kind: 'text', text: text.slice(at, match.index) });
    at = match.index + match[0].length;

    const [, code, wikilink, link, strong, em] = match;
    if (code !== undefined) tokens.push({ kind: 'code', text: code.slice(1, -1) });
    else if (wikilink !== undefined) tokens.push({ kind: 'link', text: wikilinkLabel(wikilink) });
    else if (link !== undefined) tokens.push({ kind: 'link', text: /^\[([^\]]*)]/.exec(link)?.[1] ?? link });
    else if (strong !== undefined) tokens.push({ kind: 'strong', text: strong.slice(2, -2) });
    else if (em !== undefined) tokens.push({ kind: 'em', text: em.slice(1, -1) });
  }

  if (at < text.length) tokens.push({ kind: 'text', text: text.slice(at) });
  return tokens;
}

/** `[[Ziel|Text]]` shows its label, `[[Ziel#Abschnitt]]` its target. */
function wikilinkLabel(raw: string): string {
  const inner = raw.replace(/^!?\[\[/, '').replace(/]]$/, '');
  const pipe = inner.lastIndexOf('|');
  return pipe === -1 ? inner : inner.slice(pipe + 1);
}
