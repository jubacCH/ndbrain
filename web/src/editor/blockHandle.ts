/**
 * The handle in the margin: drag a block somewhere else, or click it for the
 * block's menu.
 *
 * It appears beside whatever block the pointer is over and nowhere else, so a
 * note at rest has no extra furniture. Phones do not get it — there is no hover
 * to reveal it by, and a drag handle under a thumb competes with scrolling. The
 * bar over a selection covers "turn into" there.
 *
 * All the actual edits are in `./blocks`. This file only turns pointer
 * positions into blocks and places a few elements.
 */

import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';

import { copy } from '../copy';
import {
  blockAt,
  deleteBlock,
  duplicateBlock,
  moveBlock,
  neighbour,
  turnBlockInto,
  type Block,
} from './blocks';
import { lineKind, type LineKind } from './format';

/** How far the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 4;

/** The menu's "turn into" list, in the order the `/` menu uses. */
const KINDS: LineKind[] = ['paragraph', 'h1', 'h2', 'h3', 'task', 'bullet', 'numbered', 'quote', 'callout'];

class BlockHandle {
  readonly handle: HTMLButtonElement;
  readonly line: HTMLDivElement;
  menu: HTMLDivElement | null = null;
  block: Block | null = null;
  drag: { startY: number; active: boolean; target: { block: Block; place: 'before' | 'after' } | null } | null =
    null;

  constructor(readonly view: EditorView) {
    this.handle = document.createElement('button');
    this.handle.type = 'button';
    this.handle.className = 'cm-block-handle';
    this.handle.textContent = '⋮⋮';
    this.handle.title = copy.editor.block.handle;
    this.handle.setAttribute('aria-label', copy.editor.block.handle);
    this.handle.setAttribute('aria-haspopup', 'menu');
    this.handle.hidden = true;

    this.line = document.createElement('div');
    this.line.className = 'cm-drop-line';
    this.line.hidden = true;

    view.dom.append(this.handle, this.line);

    view.scrollDOM.addEventListener('mousemove', this.onMove);
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    view.dom.addEventListener('mouseleave', this.onLeave);
    this.handle.addEventListener('pointerdown', this.onPress);
    this.handle.addEventListener('keydown', this.onHandleKey);
  }

  get enabled(): boolean {
    return !this.view.state.readOnly;
  }

  /* ---- placing the handle ---------------------------------------------- */

  blockAtY(clientY: number): Block | null {
    const block = this.view.lineBlockAtHeight(clientY - this.view.documentTop);
    return blockAt(this.view.state, block.from);
  }

  place(block: Block): void {
    const start = this.view.coordsAtPos(block.from, 1);
    if (start === null) return;
    const frame = this.view.dom.getBoundingClientRect();
    const lineHeight = Math.max(start.bottom - start.top, 18);
    // A heading or callout already has its fold triangle in the margin; the
    // handle steps further out rather than covering it.
    const line = this.view.domAtPos(block.from).node;
    const element = line instanceof Element ? line : line.parentElement;
    const folds = element?.closest('.cm-line')?.querySelector('.cm-fold-toggle') != null;

    this.block = block;
    this.handle.hidden = false;
    this.handle.style.top = `${start.top - frame.top + (lineHeight - 22) / 2}px`;
    this.handle.style.left = `${start.left - frame.left - (folds ? 50 : 30)}px`;
  }

  hide(): void {
    if (this.drag?.active || this.menu !== null) return;
    this.handle.hidden = true;
    this.block = null;
  }

  onMove = (event: MouseEvent): void => {
    if (!this.enabled || this.drag !== null || this.menu !== null) return;
    if (event.target === this.handle) return;
    const block = this.blockAtY(event.clientY);
    if (block === null) {
      this.hide();
      return;
    }
    if (this.block?.from !== block.from || this.block.to !== block.to || this.handle.hidden) this.place(block);
  };

  onScroll = (): void => {
    if (this.drag?.active) return;
    this.closeMenu();
    this.hide();
  };

  onLeave = (event: MouseEvent): void => {
    if (event.relatedTarget instanceof Node && this.view.dom.contains(event.relatedTarget)) return;
    this.hide();
  };

  /* ---- dragging -------------------------------------------------------- */

  onPress = (event: PointerEvent): void => {
    if (!this.enabled || this.block === null || event.button !== 0) return;
    event.preventDefault();
    this.handle.setPointerCapture(event.pointerId);
    this.drag = { startY: event.clientY, active: false, target: null };
    this.handle.addEventListener('pointermove', this.onDrag);
    this.handle.addEventListener('pointerup', this.onRelease);
    this.handle.addEventListener('pointercancel', this.onCancel);
  };

  onDrag = (event: PointerEvent): void => {
    const drag = this.drag;
    if (drag === null || this.block === null) return;
    if (!drag.active) {
      if (Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD) return;
      drag.active = true;
      this.view.dom.classList.add('cm-dragging-block');
    }

    // Near the top or bottom edge the note scrolls, so a block can travel
    // further than one screen.
    const scroller = this.view.scrollDOM.getBoundingClientRect();
    if (event.clientY < scroller.top + 40) this.view.scrollDOM.scrollTop -= 12;
    else if (event.clientY > scroller.bottom - 40) this.view.scrollDOM.scrollTop += 12;

    const target = this.blockAtY(event.clientY);
    if (target === null) {
      drag.target = null;
      this.line.hidden = true;
      return;
    }

    const top = this.view.coordsAtPos(target.from, 1);
    const bottom = this.view.coordsAtPos(target.to, -1);
    if (top === null || bottom === null) return;
    const place = event.clientY < (top.top + bottom.bottom) / 2 ? 'before' : 'after';
    drag.target = { block: target, place };

    const frame = this.view.dom.getBoundingClientRect();
    const content = this.view.contentDOM.querySelector('.cm-line')?.getBoundingClientRect();
    this.line.hidden = false;
    this.line.style.top = `${(place === 'before' ? top.top - 2 : bottom.bottom + 1) - frame.top}px`;
    this.line.style.left = `${(content?.left ?? top.left) - frame.left}px`;
    this.line.style.width = `${content?.width ?? 320}px`;
  };

  onRelease = (event: PointerEvent): void => {
    const drag = this.drag;
    this.endDrag(event.pointerId);
    if (drag === null || this.block === null) return;

    if (!drag.active) {
      this.openMenu();
      return;
    }
    if (drag.target === null) return;
    const spec = moveBlock(this.view.state, this.block, drag.target.block, drag.target.place);
    if (spec !== null) this.view.dispatch(spec);
    this.block = null;
    this.handle.hidden = true;
    this.view.focus();
  };

  onCancel = (event: PointerEvent): void => {
    this.endDrag(event.pointerId);
  };

  endDrag(pointer: number): void {
    if (this.handle.hasPointerCapture(pointer)) this.handle.releasePointerCapture(pointer);
    this.handle.removeEventListener('pointermove', this.onDrag);
    this.handle.removeEventListener('pointerup', this.onRelease);
    this.handle.removeEventListener('pointercancel', this.onCancel);
    this.view.dom.classList.remove('cm-dragging-block');
    this.line.hidden = true;
    this.drag = null;
  }

  /* ---- the menu -------------------------------------------------------- */

  onHandleKey = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
      event.preventDefault();
      this.openMenu();
    }
  };

  openMenu(): void {
    const block = this.block;
    if (block === null) return;
    this.closeMenu();

    const t = copy.editor.block;
    const menu = document.createElement('div');
    menu.className = 'cm-block-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', t.menu);

    const current = lineKind(this.view.state.doc.lineAt(block.from).text);
    const item = (label: string, run: () => void, checked?: boolean): void => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemradio');
      if (checked !== undefined) button.setAttribute('aria-checked', String(checked));
      button.textContent = label;
      button.addEventListener('click', () => {
        this.closeMenu();
        run();
        this.view.focus();
      });
      menu.append(button);
    };
    const heading = (label: string): void => {
      const element = document.createElement('div');
      element.className = 'cm-block-menu-heading';
      element.textContent = label;
      menu.append(element);
    };

    heading(t.turnInto);
    for (const kind of KINDS) {
      item(
        t.kinds[kind],
        () => {
          const spec = turnBlockInto(this.view.state, block, kind);
          if (spec !== null) this.view.dispatch(spec);
        },
        kind === current,
      );
    }

    const rule = document.createElement('div');
    rule.className = 'cm-block-menu-rule';
    menu.append(rule);

    const above = neighbour(this.view.state, block, -1);
    const below = neighbour(this.view.state, block, 1);
    if (above !== null) {
      item(t.moveUp, () => {
        const spec = moveBlock(this.view.state, block, above, 'before');
        if (spec !== null) this.view.dispatch(spec);
      });
    }
    if (below !== null) {
      item(t.moveDown, () => {
        const spec = moveBlock(this.view.state, block, below, 'after');
        if (spec !== null) this.view.dispatch(spec);
      });
    }
    item(t.duplicate, () => this.view.dispatch(duplicateBlock(this.view.state, block)));
    item(t.remove, () => this.view.dispatch(deleteBlock(this.view.state, block)));

    const frame = this.view.dom.getBoundingClientRect();
    const anchor = this.handle.getBoundingClientRect();
    menu.style.top = `${anchor.bottom - frame.top + 4}px`;
    menu.style.left = `${Math.max(4, anchor.left - frame.left)}px`;

    menu.addEventListener('keydown', this.onMenuKey);
    this.view.dom.append(menu);
    this.menu = menu;
    this.handle.setAttribute('aria-expanded', 'true');
    menu.querySelector<HTMLButtonElement>('button')?.focus();
    // Next tick, or the click that opened the menu would close it again.
    setTimeout(() => document.addEventListener('mousedown', this.onOutside), 0);
  }

  closeMenu(): void {
    if (this.menu === null) return;
    this.menu.remove();
    this.menu = null;
    this.handle.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', this.onOutside);
  }

  onOutside = (event: MouseEvent): void => {
    if (this.menu?.contains(event.target as Node)) return;
    this.closeMenu();
    this.hide();
  };

  onMenuKey = (event: KeyboardEvent): void => {
    const buttons = [...(this.menu?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeMenu();
      this.handle.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      buttons[(index + step + buttons.length) % buttons.length]?.focus();
    }
  };

  /* ---- lifecycle ------------------------------------------------------- */

  update(): void {
    // Any edit can move or dissolve the block the handle points at.
    if (this.drag === null && this.menu === null) this.hide();
  }

  destroy(): void {
    this.closeMenu();
    this.view.scrollDOM.removeEventListener('mousemove', this.onMove);
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    this.view.dom.removeEventListener('mouseleave', this.onLeave);
    this.handle.remove();
    this.line.remove();
  }
}

const handlePlugin = ViewPlugin.fromClass(
  class {
    readonly handle: BlockHandle;

    constructor(view: EditorView) {
      this.handle = new BlockHandle(view);
    }

    update(update: { docChanged: boolean }): void {
      if (update.docChanged) this.handle.update();
    }

    destroy(): void {
      this.handle.destroy();
    }
  },
);

export function blockHandle(): Extension {
  return handlePlugin;
}
