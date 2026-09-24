/**
 * Vim keys in the note — a setting, off unless somebody asks for it.
 *
 * Four things collide when modal editing is put on top of this editor, and each
 * of them is pinned below rather than argued about:
 *
 *  - **Escape.** The note's way out by keyboard is CodeMirror's own tab-focus
 *    mode: Escape hands the next Tab back to the browser. Vim wants Escape for
 *    Insert → Normal. Which of the two owns it is the setting `vimLeaveInsert`:
 *    Escape by default, or one of the sequences Vim people have always mapped
 *    for themselves. Choosing a sequence gives Escape back to the way out.
 *  - **Tab.** Nothing is being typed in Normal mode, so Tab is not indentation
 *    there and goes back to being the way out. In Insert mode it indents, as it
 *    always has.
 *  - **`/`.** Vim's search in Normal mode; still the slash menu in Insert mode.
 *  - **`⌘K` and the formatting keys.** Vim claims no modified key, so they all
 *    have to go on working — including `⌘K`, which is listened for on the
 *    window and therefore only survives if nothing stops the event.
 *
 * The one thing that may never be lost is the way out by keyboard. It is an
 * accessibility feature, so every combination of the two settings is measured
 * for it here, not only the default one.
 */

import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { getCM } from '@replit/codemirror-vim';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { noteExtensions } from '../src/Editor';
import { copy } from '../src/copy';
import { VIM_OFF, setVimEditing, type VimSettings } from '../src/editor/vim';
import { DEFAULT_PREFS } from '../src/prefs';

const VIM_ON: VimSettings = { on: true, leaveInsert: 'Escape' };
const VIM_SEQUENCE: VimSettings = { on: true, leaveInsert: 'jk' };

let open: EditorView[] = [];

afterEach(() => {
  for (const view of open) view.destroy();
  open = [];
  document.body.innerHTML = '';
});

function note(text: string, at: number, vim?: VimSettings): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      selection: EditorSelection.single(at),
      extensions: noteExtensions({ owner: 'julian', path: 'Notiz.md', vim: vim ?? VIM_OFF }),
    }),
    parent: document.body,
  });
  view.focus();
  open.push(view);
  return view;
}

interface Modifiers {
  shift?: boolean;
  /** The platform's own modifier — what CodeMirror spells `Mod-`. */
  mod?: boolean;
  /** The Mac's ⌘, whatever the platform, for the keys vim must never claim. */
  meta?: boolean;
}

/** `Mod-` resolves to ⌘ on a Mac and to Ctrl everywhere else, jsdom included. */
const MAC = /Mac/.test(navigator.platform);

/**
 * A key the way the browser delivers it.
 *
 * `keyCode` as well as `key`: CodeMirror's own handling of Escape and Tab — the
 * one press it hands back to the browser — reads the numeric code, and a
 * synthetic event without it would pass a check the real key does not.
 *
 * Returns whether the editor claimed the press. `false` on Tab is the whole
 * point of the way out: nothing claimed it, so the browser moves the focus.
 */
function press(view: EditorView, key: string, modifiers: Modifiers = {}): boolean {
  const codes: Record<string, number> = { Tab: 9, Escape: 27 };
  const mod = modifiers.mod ?? false;
  const event = new KeyboardEvent('keydown', {
    key,
    keyCode: codes[key] ?? key.toUpperCase().charCodeAt(0),
    shiftKey: modifiers.shift ?? false,
    metaKey: (modifiers.meta ?? false) || (mod && MAC),
    ctrlKey: mod && !MAC,
    bubbles: true,
    cancelable: true,
  } as KeyboardEventInit);
  view.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
}

/**
 * A printable key in Insert mode, the whole way the browser does it.
 *
 * The keypress alone is not enough: in a real browser an unclaimed letter is
 * inserted by the contenteditable itself, and jsdom does not do that. Vim's
 * Insert-mode sequences depend on it — it lets the `j` of `jk` through and
 * takes it back again when the `k` arrives — so a test that only dispatched the
 * event would measure an editor nobody uses.
 */
function type(view: EditorView, text: string): void {
  for (const char of text) {
    if (press(view, char)) continue;
    const at = view.state.selection.main;
    view.dispatch({
      changes: { from: at.from, to: at.to, insert: char },
      selection: { anchor: at.from + 1 },
      userEvent: 'input.type',
    });
  }
}

/** Vim's own idea of where it is, read off the editor rather than inferred. */
function inserting(view: EditorView): boolean {
  return getCM(view)?.state.vim?.insertMode ?? false;
}

describe('with the setting off', () => {
  it('is off for everybody until it is asked for', () => {
    expect(DEFAULT_PREFS.vimMode).toBe(false);
    expect(DEFAULT_PREFS.vimLeaveInsert).toBe('Escape');
  });

  it('puts no vim into the editor at all', () => {
    expect(getCM(note('Text\n', 0))).toBeNull();
    expect(getCM(note('Text\n', 0, { on: false, leaveInsert: 'jk' }))).toBeNull();
    expect(VIM_OFF.on).toBe(false);
  });

  it('leaves Tab indenting and Escape arming the way out', () => {
    const text = '- Homelab\n- Proxmox\n';
    const view = note(text, text.indexOf('Proxmox'));

    expect(press(view, 'Tab')).toBe(true);
    expect(view.state.doc.line(2).text.startsWith(' ')).toBe(true);

    press(view, 'Escape');
    expect(press(view, 'Tab')).toBe(false);
  });
});

describe('with vim switched on', () => {
  it('opens in Normal mode, where letters move rather than type', () => {
    const view = note('Eins\nZwei\n', 0, VIM_ON);

    expect(inserting(view)).toBe(false);
    // `w`, not `j`: a line motion measures the rendered text, and jsdom lays
    // nothing out. What is being asked here is only whether the letter moved
    // the cursor instead of landing in the note.
    press(view, 'w');
    expect(view.state.selection.main.head).toBe(5);
    expect(view.state.doc.toString()).toBe('Eins\nZwei\n');
  });

  it('enters Insert mode on i', () => {
    const view = note('Eins\n', 0, VIM_ON);
    press(view, 'i');
    expect(inserting(view)).toBe(true);
  });

  it('keeps the slash menu in Insert mode', () => {
    const view = note('\n', 0, VIM_ON);
    press(view, 'i');
    type(view, '/');
    expect(view.state.doc.toString()).toBe('/\n');
  });

  it('gives / to vim in Normal mode instead of typing it', () => {
    const view = note('Eins\n', 0, VIM_ON);
    type(view, '/');
    expect(view.state.doc.toString()).toBe('Eins\n');
  });
});

describe('the way out by keyboard', () => {
  it('is Tab alone in Normal mode, since nothing is being typed there', () => {
    const view = note('Eins\nZwei\n', 0, VIM_ON);

    expect(press(view, 'Tab')).toBe(false);
    expect(view.state.doc.toString()).toBe('Eins\nZwei\n');
  });

  it('is still Tab-as-indentation in Insert mode', () => {
    const text = '- Homelab\n- Proxmox\n';
    const view = note(text, text.indexOf('Proxmox'), VIM_ON);

    press(view, 'i');
    expect(press(view, 'Tab')).toBe(true);
    expect(view.state.doc.line(2).text.startsWith(' ')).toBe(true);
  });

  it('comes back after Escape has taken the note out of Insert mode', () => {
    const view = note('Eins\n', 0, VIM_ON);

    press(view, 'i');
    expect(press(view, 'Tab')).toBe(true);
    press(view, 'Escape');
    expect(inserting(view)).toBe(false);
    expect(press(view, 'Tab')).toBe(false);
  });

  it('is Escape then Tab from Insert mode once a sequence owns the mode change', () => {
    const view = note('Eins\n', 0, VIM_SEQUENCE);

    press(view, 'i');
    expect(inserting(view)).toBe(true);
    // Escape is no longer vim's: it stays in Insert mode and hands the next Tab
    // to the browser, which is what makes the note leavable from where you are.
    press(view, 'Escape');
    expect(inserting(view)).toBe(true);
    expect(press(view, 'Tab')).toBe(false);
  });

  it('leaves Insert mode on the sequence itself', () => {
    const view = note('Eins\n', 0, VIM_SEQUENCE);

    press(view, 'i');
    type(view, 'jk');
    expect(inserting(view)).toBe(false);
    // And the two letters that carried the command are not left in the note.
    expect(view.state.doc.toString()).toBe('Eins\n');
  });
});

describe('the keys vim does not claim', () => {
  it('still makes a heading with Mod-1 in both modes', () => {
    const view = note('Homelab\n', 0, VIM_ON);

    press(view, '1', { mod: true });
    expect(view.state.doc.toString()).toBe('# Homelab\n');

    press(view, 'i');
    press(view, '1', { mod: true });
    expect(view.state.doc.toString()).toBe('Homelab\n');
  });

  it('still links with Mod-k in both modes', () => {
    const view = note('Homelab\n', 0, VIM_ON);
    view.dispatch({ selection: EditorSelection.single(0, 7) });

    press(view, 'k', { mod: true });
    expect(view.state.doc.toString()).toBe('[Homelab]()\n');

    press(view, 'i');
    view.dispatch({ selection: EditorSelection.single(1, 8) });
    press(view, 'k', { mod: true });
    expect(view.state.doc.toString()).toBe('[[Homelab]()]()\n');
  });

  it('claims nothing that is pressed with ⌘, in either mode', () => {
    const view = note('Eins\n', 0, VIM_ON);
    const heard = vi.fn();
    window.addEventListener('keydown', heard);

    // ⌘K is listened for on the window, so anything below that stopped the
    // event — or answered it — would take the palette away from the note.
    expect(press(view, 'k', { meta: true })).toBe(MAC);
    press(view, 'i');
    expect(press(view, 'b', { meta: true })).toBe(MAC);
    window.removeEventListener('keydown', heard);

    // Two of the three: `i` is vim's own and it stops the event, which is
    // right. The two pressed with ⌘ have to get past it.
    const withMeta = heard.mock.calls.filter(([event]) => (event as KeyboardEvent).metaKey);
    expect(withMeta).toHaveLength(2);
    expect(view.state.doc.toString()).toBe('Eins\n');
  });
});

describe('the mode line', () => {
  const line = (view: EditorView): string => view.dom.querySelector('.cm-vim-status')?.textContent ?? '';

  it('names the mode, so the editor is never silently modal', () => {
    const view = note('Eins\n', 0, VIM_ON);

    expect(line(view)).toContain(copy.editor.vim.normal);
    press(view, 'i');
    expect(line(view)).toContain(copy.editor.vim.insert);
  });

  it('names the sequence while it is the one that leaves Insert mode', () => {
    const view = note('Eins\n', 0, VIM_SEQUENCE);

    // The answer to the dead end: a sequence you cannot remember is one the
    // note tells you about, in the mode where it is the way out.
    expect(line(view)).not.toContain('jk');
    press(view, 'i');
    expect(line(view)).toContain(copy.editor.vim.leaveWith('jk'));
  });

  it('says nothing about a key that is not in use', () => {
    const view = note('Eins\n', 0, VIM_ON);
    press(view, 'i');
    expect(line(view)).toBe(copy.editor.vim.insert);
  });
});

describe('switching the setting while a note is open', () => {
  it('keeps text that has not been saved yet', () => {
    const view = note('Eins\n', 0);
    view.dispatch({ changes: { from: 5, insert: 'Ein Satz, noch nirgends gespeichert.\n' } });
    const written = view.state.doc.toString();

    setVimEditing(view, VIM_ON);
    expect(getCM(view)).not.toBeNull();
    expect(view.state.doc.toString()).toBe(written);

    setVimEditing(view, { on: false, leaveInsert: 'Escape' });
    expect(getCM(view)).toBeNull();
    expect(view.state.doc.toString()).toBe(written);
  });

  it('gives the note its Tab back when vim is switched off again', () => {
    const view = note('- Eins\n- Zwei\n', 8, VIM_ON);
    expect(press(view, 'Tab')).toBe(false);

    setVimEditing(view, { on: false, leaveInsert: 'Escape' });
    expect(press(view, 'Tab')).toBe(true);
  });
});

describe('the live preview under a cursor that moves all the time', () => {
  /** What the reader actually sees — the notation live preview has hidden. */
  const shown = (view: EditorView): string => view.contentDOM.textContent ?? '';

  it('hides and reveals per line under a vim motion, exactly as it does otherwise', () => {
    const text = 'Ein **fetter** Satz.\nZweite Zeile.\n';

    const vim = note(text, 0, VIM_ON);
    expect(shown(vim)).toContain('**');

    // `G` and `gg`, since jsdom lays nothing out and `j` measures the screen.
    press(vim, 'G');
    expect(shown(vim)).not.toContain('**');

    press(vim, 'g');
    press(vim, 'g');
    expect(shown(vim)).toContain('**');

    // The same note with the same cursor, without vim: reveal is a property of
    // the line the cursor is on, so both have to draw the same thing.
    const plain = note(text, 0);
    expect(shown(plain)).toBe(shown(vim));
  });
});
