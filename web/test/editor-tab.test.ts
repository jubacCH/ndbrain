/**
 * Tab in a note: indentation, not a jump to the next control.
 *
 * CodeMirror leaves Tab to the browser unless something binds it, which moves
 * the focus out of the note — correct for a control in a form, wrong for the
 * surface a nested list is typed on. The way out by keyboard stays: Escape
 * hands the next Tab back to the browser.
 */

import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { beforeEach, describe, expect, it } from 'vitest';

import { noteExtensions } from '../src/Editor';

function open(text: string, at: number): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      selection: EditorSelection.single(at),
      extensions: noteExtensions({ owner: 'julian', path: 'Notiz.md' }),
    }),
    parent: document.body,
  });
  view.focus();
  return view;
}

/** A key the way the browser delivers it, so the editor's own handling decides. */
function press(view: EditorView, key: string, shift = false): boolean {
  // `keyCode` as well as `key`: CodeMirror's own handling of Escape and Tab —
  // the one press it hands back to the browser — reads the numeric code, and a
  // synthetic event without it would pass a check the real key does not.
  const codes: Record<string, number> = { Tab: 9, Escape: 27 };
  const event = new KeyboardEvent('keydown', {
    key,
    keyCode: codes[key] ?? 0,
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  } as KeyboardEventInit);
  view.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('Tab inside a note', () => {
  let view: EditorView;

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('indents the line instead of leaving the note', () => {
    const text = '- Homelab\n- Proxmox\n';
    view = open(text, text.indexOf('Proxmox'));
    const handled = press(view, 'Tab');

    expect(handled).toBe(true);
    expect(view.state.doc.line(2).text.startsWith(' ')).toBe(true);
    view.destroy();
  });

  it('takes the indentation back with Shift-Tab', () => {
    const text = '- Homelab\n    - Proxmox\n';
    view = open(text, text.indexOf('Proxmox'));
    press(view, 'Tab', true);

    expect(view.state.doc.line(2).text).toBe('  - Proxmox');
    view.destroy();
  });

  it('hands Tab back to the browser after Escape, so the note can be left', () => {
    view = open('Text\n', 0);
    press(view, 'Escape');
    const handled = press(view, 'Tab');

    expect(handled).toBe(false);
    expect(view.state.doc.toString()).toBe('Text\n');
    view.destroy();
  });

  it('goes back to indenting as soon as anything else is typed', () => {
    view = open('Text\n', 0);
    press(view, 'Escape');
    // Any key other than Escape ends the handover, so the note does not keep
    // losing its Tab for the rest of the two seconds.
    press(view, 'a');

    expect(press(view, 'Tab')).toBe(true);
    view.destroy();
  });
});
