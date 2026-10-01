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
 *
 * The table widget is not here but in `./tableView`, with the state field that
 * places it. It is a different animal: a block that replaces whole lines and is
 * typed into, and it cannot be understood apart from the field that decides
 * which lines it owns and the writes that go back into them.
 */

import { EditorView, WidgetType } from '@codemirror/view';

import { copy } from '../copy';

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
    box.setAttribute('aria-label', this.checked ? copy.editor.taskDone : copy.editor.taskOpen);

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

/**
 * The frontmatter block, standing in for itself while nobody is editing it.
 *
 * Every note in this vault opens with five or so lines of YAML, and most carry a
 * blockquote header underneath repeating part of it. Together they filled the
 * first fifth of the editor before the first sentence — administration, set at
 * the size of writing.
 *
 * What the summary shows is what somebody actually looks for: the tags, and when
 * the note was last touched. The rest stays one keystroke away, because the
 * block reveals itself the moment the cursor enters it — the same rule every
 * other line in live preview follows.
 *
 * It renders what it was given rather than parsing YAML properly. A real parser
 * would be a second opinion about a file format the server already reads, and
 * the cost of being wrong here is a summary that says less than it could, not a
 * note that breaks: the document is never modified, only covered.
 */
export class FrontmatterWidget extends WidgetType {
  constructor(
    readonly tags: readonly string[],
    readonly updated: string,
    readonly fields: number,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof FrontmatterWidget &&
      other.updated === this.updated &&
      other.fields === this.fields &&
      other.tags.length === this.tags.length &&
      other.tags.every((tag, i) => tag === this.tags[i])
    );
  }

  /**
   * Clicks reach the editor rather than stopping at the bar.
   *
   * Widgets swallow events by default, which would leave the folded block with
   * no way in but the arrow keys — and the way in is the whole contract: put the
   * cursor there and it opens. A button saying so would be a second mechanism
   * for what the rest of live preview does without one.
   */
  override ignoreEvent(): boolean {
    return false;
  }

  override toDOM(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'cm-frontmatter-bar';
    // Said out loud, because the block it replaces is not visible to say it
    // itself: without this a screen reader meets a row of tags with no account
    // of where they came from or how to reach the rest.
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', copy.editor.frontmatterLabel(this.fields));

    for (const tag of this.tags) {
      const pill = document.createElement('span');
      pill.className = 'cm-frontmatter-tag';
      pill.textContent = tag;
      bar.append(pill);
    }

    if (this.updated !== '') {
      const when = document.createElement('span');
      when.className = 'cm-frontmatter-when';
      when.textContent = this.updated;
      bar.append(when);
    }

    // Nothing to show is still worth a mark: an empty bar would read as a
    // rendering fault rather than as a note whose frontmatter carries no tags.
    if (this.tags.length === 0 && this.updated === '') {
      const empty = document.createElement('span');
      empty.className = 'cm-frontmatter-when';
      empty.textContent = copy.editor.frontmatterPlain(this.fields);
      bar.append(empty);
    }

    return bar;
  }
}
