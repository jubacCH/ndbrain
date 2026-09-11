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
  const cell = escapeCell(value.replace(/[\r\n\t]+/g, ' ').trim());
  return {
    ...table,
    rows: table.rows.map((cells, index) =>
      index === rowIndex ? cells.map((old, at) => (at === column ? cell : old)) : cells,
    ),
  };
}

/** A new empty row after `rowIndex`, with the same number of columns. */
export function withRowAfter(table: TableBlock, rowIndex: number): TableBlock {
  const empty = Array.from({ length: table.columns }, () => '');
  const rows = [...table.rows];
  rows.splice(rowIndex + 1, 0, empty);
  return { ...table, rows };
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
