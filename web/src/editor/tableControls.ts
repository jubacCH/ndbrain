/**
 * Everything a drawn table offers beyond typing in a cell, after AFFiNE's:
 *
 *  - a handle on every row and column that appears with the pointer — click it
 *    for the row's or column's menu, drag it to move the row or column;
 *  - a bar under the table and one beside it that add a row or a column;
 *  - a range of cells, picked by dragging across them or with Shift, which can
 *    be cleared, copied and cut as a block;
 *  - a block pasted from a spreadsheet filling the cells it lands on, growing
 *    the table where it reaches past it.
 *
 * None of it holds a table of its own. Every action reads the table back from
 * the document at the moment it runs (`ops.live`) and writes the result through
 * the same path as typing (`ops.write`), so an edit here is one transaction
 * over the table's own lines like any other.
 *
 * The pieces that need no browser — what a move, an insert or a paste does to
 * the table — are in `./table` and tested there; this file turns pointers and
 * keys into calls to them.
 */

import type { EditorView } from '@codemirror/view';

import { copy } from '../copy';
import {
  parseGrid,
  rangeBounds,
  rangeText,
  slotAt,
  slotToIndex,
  withAlign,
  withColumnAt,
  withColumnCleared,
  withColumnDuplicated,
  withColumnMoved,
  withGrid,
  withRangeCleared,
  withRowAt,
  withRowCleared,
  withRowDuplicated,
  withRowMoved,
  withoutColumn,
  withoutRow,
  type Align,
  type CellRange,
  type TableBlock,
} from './table';

export interface TableOps {
  /** The table as the document has it now, or null once it is gone. */
  live(): TableBlock | null;
  /** One structural edit; `null` removes the table. */
  write(from: TableBlock, to: TableBlock | null): void;
  focus(line: number, row: number, column: number, caret?: 'start' | 'end' | 'all'): void;
}

type Cell = { row: number; column: number };
type Kind = 'row' | 'column';
/** Where a menu opens: under this point. A cell's or handle's rect will do. */
type Anchor = { left: number; bottom: number };

type Item =
  | { label: string; run: () => void; checked?: boolean; danger?: boolean }
  | { heading: string }
  | 'rule';

/** How far the pointer must travel before a press on a handle becomes a drag. */
const DRAG_THRESHOLD = 4;

export class TableControls {
  private range: CellRange | null = null;
  private menu: HTMLDivElement | null = null;
  /** Where focus goes back to when the menu is dismissed. */
  private menuReturn: HTMLElement | null = null;
  private drag: {
    kind: Kind;
    index: number;
    x: number;
    y: number;
    active: boolean;
    slot: number;
  } | null = null;
  /** A press in a cell that may turn into a range if the pointer leaves it. */
  private press: Cell | null = null;
  /** The click that ends a drag is not a request for the menu. */
  private dragged = false;
  private readonly drop: HTMLDivElement;

  constructor(
    readonly wrap: HTMLElement,
    readonly view: EditorView,
    readonly ops: TableOps,
  ) {
    // Focusable so that a range, which has no caret anywhere, still has an
    // element to receive Delete, Escape and the clipboard keys.
    wrap.tabIndex = -1;

    wrap.append(
      addBar('row', copy.editor.table.addRow),
      addBar('column', copy.editor.table.addColumn),
    );

    this.drop = document.createElement('div');
    this.drop.className = 'cm-table-drop';
    this.drop.hidden = true;
    wrap.append(this.drop);

    wrap.addEventListener('mouseover', this.onOver);
    wrap.addEventListener('mouseleave', this.onLeave);
    wrap.addEventListener('pointerdown', this.onDown);
    wrap.addEventListener('pointermove', this.onMovePointer);
    wrap.addEventListener('pointerup', this.onUp);
    wrap.addEventListener('pointercancel', this.onCancel);
    wrap.addEventListener('click', this.onClick);
    wrap.addEventListener('contextmenu', this.onContextMenu);
    wrap.addEventListener('keydown', this.onKey);
    wrap.addEventListener('paste', this.onPaste);
    wrap.addEventListener('focusin', this.onFocusIn);

    this.refresh();
  }

  private get writable(): boolean {
    return !this.view.state.readOnly;
  }

  /** Called after the widget repaints in place. */
  refresh(): void {
    this.wrap.classList.toggle('is-readonly', !this.writable);
    this.paint();
  }

  destroy(): void {
    this.closeMenu(false);
  }

  /* ---- the handles that follow the pointer ------------------------------ */

  private onOver = (event: MouseEvent): void => {
    if (this.drag?.active) return;
    const cell = cellOf(event.target);
    if (cell === null) return;
    this.hot(cell);
  };

  private onLeave = (): void => {
    if (this.menu === null && !this.drag?.active) this.hot(null);
  };

  /** Shows the handles of one cell's row and column, and hides the rest. */
  private hot(cell: Cell | null): void {
    for (const grip of this.wrap.querySelectorAll('.cm-table-grip.is-hot')) grip.classList.remove('is-hot');
    if (cell === null) return;
    this.wrap.querySelector(`.cm-table-grip-row[data-row="${cell.row}"]`)?.classList.add('is-hot');
    this.wrap.querySelector(`.cm-table-grip-column[data-column="${cell.column}"]`)?.classList.add('is-hot');
  }

  /* ---- pressing: a handle drag, or a range across cells ----------------- */

  private onDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;

    const grip = target?.closest<HTMLElement>('.cm-table-grip');
    if (grip != null) {
      if (!this.writable) return;
      // A handle never takes the focus. It sits inside a cell, and a focused
      // cell hides its drawn text for the field over it — which, with the
      // field not the one focused, left the cell blank for the whole drag.
      event.preventDefault();
      const kind = grip.dataset['grip'] as Kind;
      this.drag = {
        kind,
        index: Number(grip.dataset[kind]),
        x: event.clientX,
        y: event.clientY,
        active: false,
        slot: 0,
      };
      // jsdom has no pointer capture; a browser without it still gets the
      // moves while the pointer stays over the table.
      grip.setPointerCapture?.(event.pointerId);
      return;
    }

    const cell = cellOf(target);
    if (cell === null) return;

    if (event.shiftKey) {
      const from = this.range?.anchor ?? this.focusedCell();
      if (from !== null) {
        event.preventDefault();
        this.select(from, cell);
        return;
      }
    }

    if (this.range !== null) this.clearRange();
    this.press = cell;
  };

  private onMovePointer = (event: PointerEvent): void => {
    const drag = this.drag;
    if (drag !== null) {
      if (!drag.active) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_THRESHOLD) return;
        drag.active = true;
        this.closeMenu(false);
        this.wrap.classList.add('is-dragging');
      }
      this.showDrop(drag, event);
      return;
    }

    // Dragging out of the cell the press began in turns the press into a range,
    // the way it does in a spreadsheet. Within the cell it stays a text
    // selection in that cell's field.
    if (this.press === null || (event.buttons & 1) === 0) return;
    const under = document.elementFromPoint?.(event.clientX, event.clientY) ?? event.target;
    const cell = cellOf(under);
    if (cell === null) return;
    if (this.range === null && cell.row === this.press.row && cell.column === this.press.column) return;
    event.preventDefault();
    this.select(this.press, cell);
  };

  private onUp = (event: PointerEvent): void => {
    this.press = null;
    const drag = this.drag;
    if (drag === null) return;
    this.endDrag(event);
    if (!drag.active) return;

    this.dragged = true;
    const table = this.ops.live();
    if (table === null) return;
    const to = slotToIndex(drag.index, drag.slot);
    if (to === drag.index) return;

    if (drag.kind === 'row') {
      this.ops.write(table, withRowMoved(table, drag.index, to));
      this.ops.focus(table.firstLine, to, 0);
    } else {
      this.ops.write(table, withColumnMoved(table, drag.index, to));
      this.ops.focus(table.firstLine, 0, to);
    }
  };

  private onCancel = (event: PointerEvent): void => {
    this.press = null;
    if (this.drag !== null) this.endDrag(event);
  };

  private endDrag(event: PointerEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
    this.wrap.classList.remove('is-dragging');
    this.drop.hidden = true;
    this.drag = null;
  }

  /** The line that shows where a dragged row or column would land. */
  private showDrop(drag: NonNullable<TableControls['drag']>, event: PointerEvent): void {
    const box = this.wrap.getBoundingClientRect();
    const frame = this.wrap.querySelector('.cm-table-frame')?.getBoundingClientRect() ?? box;

    if (drag.kind === 'row') {
      const rows = [...this.wrap.querySelectorAll('tr')].map((row) => row.getBoundingClientRect());
      drag.slot = slotAt(rows.map((rect) => ({ start: rect.top, end: rect.bottom })), event.clientY);
      const y = drag.slot < rows.length ? rows[drag.slot]!.top : rows[rows.length - 1]!.bottom;
      Object.assign(this.drop.style, {
        top: `${y - box.top - 1}px`,
        left: `${frame.left - box.left}px`,
        width: `${frame.width}px`,
        height: '2px',
      });
    } else {
      const cells = [...this.wrap.querySelectorAll('thead .cm-cell')]
        .slice(0, this.ops.live()?.columns ?? 0)
        .map((cell) => cell.getBoundingClientRect());
      drag.slot = slotAt(cells.map((rect) => ({ start: rect.left, end: rect.right })), event.clientX);
      const x = drag.slot < cells.length ? cells[drag.slot]!.left : cells[cells.length - 1]!.right;
      Object.assign(this.drop.style, {
        top: `${frame.top - box.top}px`,
        left: `${x - box.left - 1}px`,
        width: '2px',
        height: `${frame.height}px`,
      });
    }
    this.drop.hidden = false;
  }

  /* ---- clicks: handle menus and the add bars ---------------------------- */

  private onClick = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : null;

    const grip = target?.closest<HTMLElement>('.cm-table-grip');
    if (grip != null) {
      event.preventDefault();
      if (this.dragged) {
        this.dragged = false;
        return;
      }
      if (!this.writable) return;
      const kind = grip.dataset['grip'] as Kind;
      this.openMenu(this.gripItems(kind, Number(grip.dataset[kind])), grip.getBoundingClientRect(), grip);
      return;
    }

    const add = target?.closest<HTMLElement>('.cm-table-add');
    if (add != null) {
      event.preventDefault();
      const table = this.ops.live();
      if (table === null || !this.writable) return;
      if (add.dataset['add'] === 'row') {
        this.ops.write(table, withRowAt(table, table.rows.length));
        this.ops.focus(table.firstLine, table.rows.length, 0);
      } else {
        this.ops.write(table, withColumnAt(table, table.columns));
        this.ops.focus(table.firstLine, 0, table.columns);
      }
    }
  };

  private onContextMenu = (event: MouseEvent): void => {
    const cell = cellOf(event.target);
    if (cell === null || !this.writable) return;
    event.preventDefault();
    const at = { left: event.clientX, bottom: event.clientY };
    this.openCellMenu(cell.row, cell.column, at);
  };

  /** The menu for one cell: its row's and its column's, or the range's. */
  openCellMenu(row: number, column: number, anchor: Anchor): void {
    if (!this.writable) return;
    const range = this.range;
    const inside =
      range !== null &&
      (() => {
        const { top, bottom, left, right } = rangeBounds(range);
        return row >= top && row <= bottom && column >= left && column <= right;
      })();

    const t = copy.editor.table;
    const items: Item[] = inside
      ? [{ heading: t.cells(this.rangeSize()) }, ...this.rangeItems()]
      : [{ heading: t.row }, ...this.gripItems('row', row), 'rule', { heading: t.column }, ...this.gripItems('column', column)];

    const returnTo = this.cellInput(row, column);
    this.openMenu(items, anchor, returnTo ?? this.wrap);
  }

  private gripItems(kind: Kind, index: number): Item[] {
    const t = copy.editor.table;
    const table = this.ops.live();
    if (table === null) return [];

    // Each action reads the table again when it runs: the menu may have been
    // open while a save from elsewhere moved the lines.
    const act = (change: (table: TableBlock) => TableBlock | null, focus?: Cell): (() => void) => () => {
      const now = this.ops.live();
      if (now === null) return;
      const next = change(now);
      this.ops.write(now, next);
      if (next !== null && focus !== undefined) {
        this.ops.focus(now.firstLine, Math.min(focus.row, next.rows.length - 1), Math.min(focus.column, next.columns - 1));
      }
    };

    if (kind === 'row') {
      const last = table.rows.length - 1;
      const items: Item[] = [
        { label: t.insertAbove, run: act((now) => withRowAt(now, index), { row: index, column: 0 }) },
        { label: t.insertBelow, run: act((now) => withRowAt(now, index + 1), { row: index + 1, column: 0 }) },
      ];
      if (index > 0) items.push({ label: t.moveUp, run: act((now) => withRowMoved(now, index, index - 1), { row: index - 1, column: 0 }) });
      if (index < last) items.push({ label: t.moveDown, run: act((now) => withRowMoved(now, index, index + 1), { row: index + 1, column: 0 }) });
      items.push(
        { label: t.duplicate, run: act((now) => withRowDuplicated(now, index), { row: index + 1, column: 0 }) },
        { label: t.clear, run: act((now) => withRowCleared(now, index), { row: index, column: 0 }) },
        { label: t.removeRow, danger: true, run: act((now) => withoutRow(now, index), { row: index, column: 0 }) },
      );
      return items;
    }

    const last = table.columns - 1;
    const align = table.align[index] ?? null;
    // Choosing the alignment a column already has takes it off again, back to
    // the plain `---` the column had before anybody asked.
    const aligned = (to: Align): (() => void) => act((now) => withAlign(now, index, now.align[index] === to ? null : to), { row: 0, column: index });
    const items: Item[] = [
      { label: t.insertLeft, run: act((now) => withColumnAt(now, index), { row: 0, column: index }) },
      { label: t.insertRight, run: act((now) => withColumnAt(now, index + 1), { row: 0, column: index + 1 }) },
    ];
    if (index > 0) items.push({ label: t.moveLeft, run: act((now) => withColumnMoved(now, index, index - 1), { row: 0, column: index - 1 }) });
    if (index < last) items.push({ label: t.moveRight, run: act((now) => withColumnMoved(now, index, index + 1), { row: 0, column: index + 1 }) });
    items.push(
      'rule',
      { label: t.alignLeft, checked: align === 'left', run: aligned('left') },
      { label: t.alignCenter, checked: align === 'center', run: aligned('center') },
      { label: t.alignRight, checked: align === 'right', run: aligned('right') },
      'rule',
      { label: t.duplicate, run: act((now) => withColumnDuplicated(now, index), { row: 0, column: index + 1 }) },
      { label: t.clear, run: act((now) => withColumnCleared(now, index), { row: 0, column: index }) },
      { label: t.removeColumn, danger: true, run: act((now) => withoutColumn(now, index), { row: 0, column: index }) },
    );
    return items;
  }

  private rangeItems(): Item[] {
    const t = copy.editor.table;
    return [
      { label: t.copyCells, run: () => void this.copyRange(false) },
      { label: t.clearCells, run: () => this.clearCells() },
    ];
  }

  /* ---- the menu --------------------------------------------------------- */

  private openMenu(items: Item[], anchor: Anchor, returnTo: HTMLElement): void {
    this.closeMenu(false);
    if (items.length === 0) return;

    const menu = document.createElement('div');
    menu.className = 'cm-block-menu cm-table-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', copy.editor.table.menu);

    for (const item of items) {
      if (item === 'rule') {
        const rule = document.createElement('div');
        rule.className = 'cm-block-menu-rule';
        menu.append(rule);
        continue;
      }
      if ('heading' in item) {
        const heading = document.createElement('div');
        heading.className = 'cm-block-menu-heading';
        heading.textContent = item.heading;
        menu.append(heading);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemradio');
      if (item.checked !== undefined) button.setAttribute('aria-checked', String(item.checked));
      if (item.danger === true) button.classList.add('is-danger');
      button.textContent = item.label;
      button.addEventListener('click', () => {
        // Closed first and without handing focus back: the action decides
        // where the caret goes, usually a cell of a table that was just
        // redrawn.
        this.closeMenu(false);
        item.run();
      });
      menu.append(button);
    }

    const frame = this.view.dom.getBoundingClientRect();
    menu.style.top = `${anchor.bottom - frame.top + 4}px`;
    menu.style.left = `${Math.max(4, anchor.left - frame.left)}px`;

    menu.addEventListener('keydown', this.onMenuKey);
    this.view.dom.append(menu);
    this.menu = menu;
    this.menuReturn = returnTo;
    if (returnTo.hasAttribute('aria-haspopup')) returnTo.setAttribute('aria-expanded', 'true');
    this.wrap.classList.add('has-menu');
    menu.querySelector<HTMLButtonElement>('button')?.focus();
    // Next tick, or the press that opened the menu would close it again.
    setTimeout(() => document.addEventListener('mousedown', this.onOutside), 0);
  }

  private closeMenu(restore: boolean): void {
    if (this.menu === null) return;
    this.menu.remove();
    this.menu = null;
    this.wrap.classList.remove('has-menu');
    document.removeEventListener('mousedown', this.onOutside);
    this.menuReturn?.removeAttribute('aria-expanded');
    if (restore) this.menuReturn?.focus();
    this.menuReturn = null;
  }

  private onOutside = (event: MouseEvent): void => {
    if (this.menu?.contains(event.target as Node)) return;
    this.closeMenu(false);
  };

  private onMenuKey = (event: KeyboardEvent): void => {
    const buttons = [...(this.menu?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.closeMenu(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      buttons[(index + step + buttons.length) % buttons.length]?.focus();
    }
  };

  /* ---- a range of cells ------------------------------------------------- */

  /** Picks the rectangle between two cells and takes the keyboard for it. */
  select(anchor: Cell, head: Cell): void {
    this.range = { anchor, head };
    this.paint();
    window.getSelection?.()?.removeAllRanges();
    if (document.activeElement !== this.wrap) this.wrap.focus({ preventScroll: true });
  }

  private clearRange(): void {
    this.range = null;
    this.paint();
  }

  private rangeSize(): number {
    if (this.range === null) return 0;
    const { top, bottom, left, right } = rangeBounds(this.range);
    return (bottom - top + 1) * (right - left + 1);
  }

  private paint(): void {
    for (const cell of this.wrap.querySelectorAll('.cm-cell.is-picked')) cell.classList.remove('is-picked');
    this.wrap.classList.toggle('has-range', this.range !== null);
    if (this.range === null) return;
    const { top, bottom, left, right } = rangeBounds(this.range);
    for (const cell of this.wrap.querySelectorAll<HTMLElement>('.cm-cell')) {
      const row = Number(cell.dataset['row']);
      const column = Number(cell.dataset['column']);
      if (row >= top && row <= bottom && column >= left && column <= right) cell.classList.add('is-picked');
    }
  }

  /** A cell getting the caret ends the range, as clicking into one does. */
  private onFocusIn = (event: FocusEvent): void => {
    if (event.target instanceof HTMLInputElement && this.range !== null) this.clearRange();
  };

  private onKey = (event: KeyboardEvent): void => {
    if (event.target !== this.wrap || this.range === null) return;
    const range = this.range;
    const table = this.ops.live();
    if (table === null) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;

    if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault();
      this.clearCells();
      return;
    }
    if (mod && (key === 'c' || key === 'C' || key === 'x' || key === 'X')) {
      event.preventDefault();
      void this.copyRange(key.toLowerCase() === 'x');
      return;
    }
    if (key === 'Escape') {
      event.preventDefault();
      this.clearRange();
      this.ops.focus(table.firstLine, range.anchor.row, range.anchor.column);
      return;
    }
    if (key === 'Enter') {
      event.preventDefault();
      this.clearRange();
      this.ops.focus(table.firstLine, range.head.row, range.head.column);
      return;
    }
    if ((key === 'F10' && event.shiftKey) || key === 'ContextMenu') {
      event.preventDefault();
      const cell = this.wrap.querySelector(`.cm-cell[data-row="${range.head.row}"][data-column="${range.head.column}"]`);
      this.openCellMenu(range.head.row, range.head.column, cell?.getBoundingClientRect() ?? { left: 0, bottom: 0 });
      return;
    }

    const moves: Record<string, Cell> = {
      ArrowUp: { row: -1, column: 0 },
      ArrowDown: { row: 1, column: 0 },
      ArrowLeft: { row: 0, column: -1 },
      ArrowRight: { row: 0, column: 1 },
    };
    const move = moves[key];
    if (move !== undefined && !mod) {
      event.preventDefault();
      const head = {
        row: Math.min(Math.max(range.head.row + move.row, 0), table.rows.length - 1),
        column: Math.min(Math.max(range.head.column + move.column, 0), table.columns - 1),
      };
      if (event.shiftKey) {
        this.select(range.anchor, head);
      } else {
        this.clearRange();
        this.ops.focus(table.firstLine, head.row, head.column);
      }
      return;
    }

    // Typing over a range starts writing in its last cell, replacing what was
    // there, the way a spreadsheet does. The key itself is not consumed: focus
    // moves first and the browser delivers the character to the cell.
    if (key.length === 1 && !mod && !event.altKey) {
      this.clearRange();
      this.ops.focus(table.firstLine, range.head.row, range.head.column, 'all');
    }
  };

  private clearCells(): void {
    const table = this.ops.live();
    const range = this.range;
    if (table === null || range === null) return;
    this.ops.write(table, withRangeCleared(table, range));
    // The write may have redrawn the table; if it did not, the range stays
    // picked so it can be acted on again.
    this.paint();
  }

  private async copyRange(cut: boolean): Promise<void> {
    const table = this.ops.live();
    const range = this.range;
    if (table === null || range === null) return;
    const text = rangeText(table, range);
    if (cut) this.clearCells();
    try {
      // HTML beside the text, as spreadsheets write it: a single column has no
      // tabs, and the table is what tells a paste — here or in Excel — that
      // its lines are rows rather than a paragraph.
      if (typeof ClipboardItem === 'function') {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([text], { type: 'text/plain' }),
            'text/html': new Blob([gridHtml(text)], { type: 'text/html' }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      // No clipboard access (an insecure origin, a denied permission): the
      // cells are still there, and so is the cut — undo brings them back.
    }
  }

  /* ---- pasting a block -------------------------------------------------- */

  private onPaste = (event: ClipboardEvent): void => {
    if (!this.writable) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    const html = event.clipboardData?.getData('text/html') ?? '';
    const grid = parseGrid(text);
    // A block is what a spreadsheet copies: tabs between values, or — for a
    // single column, which has no tabs — a table on the clipboard beside the
    // text. Two lines of plain prose are not a block: they go into the cell
    // as one line, as they always did, instead of tearing it into rows.
    const block = (text.includes('\t') || /<table/i.test(html)) && (grid.length > 1 || (grid[0]?.length ?? 0) > 1);
    if (!block) return;

    const at = this.range !== null ? rangeTopLeft(this.range) : (cellOf(event.target) ?? this.focusedCell());
    const table = this.ops.live();
    if (at === null || table === null) return;

    event.preventDefault();
    this.ops.write(table, withGrid(table, at.row, at.column, grid));
    this.range = null;
    this.ops.focus(table.firstLine, at.row, at.column);
  };

  /* ---- helpers ---------------------------------------------------------- */

  private focusedCell(): Cell | null {
    const active = document.activeElement;
    return active instanceof HTMLInputElement && this.wrap.contains(active) ? cellOf(active) : null;
  }

  private cellInput(row: number, column: number): HTMLInputElement | null {
    return this.wrap.querySelector<HTMLInputElement>(`input[data-row="${row}"][data-column="${column}"]`);
  }
}

function gridHtml(text: string): string {
  const escape = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = parseGrid(text).map((cells) => `<tr>${cells.map((cell) => `<td>${escape(cell)}</td>`).join('')}</tr>`);
  return `<table>${rows.join('')}</table>`;
}

function rangeTopLeft(range: CellRange): Cell {
  const { top, left } = rangeBounds(range);
  return { row: top, column: left };
}

/** The cell an element is in, from the coordinates the cell carries. */
function cellOf(target: EventTarget | Element | null): Cell | null {
  if (!(target instanceof Element)) return null;
  const cell = target.closest<HTMLElement>('.cm-cell');
  if (cell === null) return null;
  return { row: Number(cell.dataset['row']), column: Number(cell.dataset['column']) };
}

function addBar(kind: Kind, label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `cm-table-add cm-table-add-${kind}`;
  button.dataset['add'] = kind;
  // Out of the Tab order for the same reason as the handles: Tab from the last
  // cell leaves the table, it does not stop at a bar first.
  button.tabIndex = -1;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.textContent = '+';
  return button;
}
