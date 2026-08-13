/**
 * The few places where a piece of Markdown is replaced by a real control.
 *
 * Everything else in live preview only hides or restyles text. These four go
 * further and put a DOM element in the document's place, so each one has to
 * earn it: a checkbox you can click, a bullet that reads as a bullet, a rule
 * that looks like a rule, and an image that is actually the image.
 *
 * None of them change the file. The checkbox writes back through the normal
 * edit path, exactly as if the two characters had been typed.
 */

import { EditorView, WidgetType } from '@codemirror/view';

/**
 * A task checkbox standing in for `[ ]` / `[x]`.
 *
 * The position is part of identity, not just the checked state: widgets are
 * reused when they compare equal, and a reused checkbox carrying a stale
 * position would tick the wrong line.
 */
export class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof CheckboxWidget && other.checked === this.checked && other.from === this.from
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.className = 'cm-task';
    box.setAttribute('aria-label', this.checked ? 'erledigt' : 'offen');

    // mousedown rather than change: the default would move the selection into
    // the replaced range first, which reveals the raw `[ ]` under the cursor
    // and makes the box flicker out from under the pointer.
    box.addEventListener('mousedown', (event) => {
      event.preventDefault();
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: this.checked ? '[ ]' : '[x]' },
      });
    });

    return box;
  }

  /** Without this the editor swallows the click before the box sees it. */
  override ignoreEvent(): boolean {
    return false;
  }
}

/** The `-`, `*` or `+` of a bullet list, shown as one. */
export class BulletWidget extends WidgetType {
  override eq(other: WidgetType): boolean {
    return other instanceof BulletWidget;
  }

  override toDOM(): HTMLElement {
    const dot = document.createElement('span');
    dot.className = 'cm-bullet';
    dot.textContent = '•';
    return dot;
  }
}

/** A thematic break, drawn instead of spelled. */
export class RuleWidget extends WidgetType {
  override eq(other: WidgetType): boolean {
    return other instanceof RuleWidget;
  }

  override toDOM(): HTMLElement {
    const rule = document.createElement('span');
    rule.className = 'cm-rule';
    return rule;
  }
}

/**
 * An inline image for `![alt](https://…)`.
 *
 * Only absolute http(s) sources render. The server has no endpoint that serves
 * files out of a vault, so a relative path or an `![[attachment.png]]` embed
 * has nothing to point at — showing a broken frame for those would be worse
 * than leaving the Markdown legible.
 */
export class ImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof ImageWidget && other.url === this.url && other.alt === this.alt;
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-embed';

    const img = document.createElement('img');
    img.src = this.url;
    img.alt = this.alt;
    img.loading = 'lazy';

    // A source that fails to load must not leave a silent hole where text was.
    img.addEventListener('error', () => {
      wrap.classList.add('cm-embed-broken');
      wrap.textContent = this.alt === '' ? this.url : this.alt;
    });

    wrap.append(img);
    return wrap;
  }
}
