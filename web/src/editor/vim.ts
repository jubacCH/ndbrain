/**
 * Modal editing in the note, as a setting.
 *
 * The reason it exists is not "vim is nice". Notes in this vault are sometimes
 * edited with vim straight in the file system, and vim replaces a file instead
 * of writing into it unless `backupcopy=yes` is set — which silently drops the
 * share on a single note, because the share hangs off the file that was there
 * before. Typing the same keys in the browser makes that detour unnecessary.
 *
 * Off by default, and that is not a formality: switching it on changes what
 * every unmodified key does. Nobody who has not asked for it may find their
 * editor in Normal mode.
 *
 * Three things here are more than wiring the library up:
 *
 *  - **The way out of the note by keyboard survives.** It is CodeMirror's own
 *    tab-focus mode — Escape hands the next Tab back to the browser — and it is
 *    the only way to leave the text without a mouse. Vim wants Escape for
 *    itself, so who gets it is a setting; see `LeaveInsert` in `../prefs`.
 *  - **Tab is not indentation when nothing is being typed.** In Normal mode it
 *    goes back to being the way out, with no Escape in front of it.
 *  - **The mode is visible.** A modal editor that does not say which mode it is
 *    in is a trap, and it is the same trap a forgotten leave-Insert sequence
 *    sets — so the status line names the sequence while it is in Insert mode.
 */

import { completionStatus } from '@codemirror/autocomplete';
import { Compartment, Prec } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, showPanel } from '@codemirror/view';
import type { Panel } from '@codemirror/view';
import { Vim, getCM, vim } from '@replit/codemirror-vim';

import { copy } from '../copy';
import type { LeaveInsert } from '../prefs';

export interface VimSettings {
  on: boolean;
  /** Which key leaves Insert mode, and by the same choice who owns Escape. */
  leaveInsert: LeaveInsert;
}

export const VIM_OFF: VimSettings = { on: false, leaveInsert: 'Escape' };

/**
 * Switched in place, never rebuilt.
 *
 * The editor is only reconstructed when the open note changes. A setting that
 * rebuilt it would throw away whatever has been typed since the last save,
 * which is the one thing this application must never do — so the whole vim
 * stack lives in a compartment and is reconfigured like the delete lock.
 */
const compartment = new Compartment();

export function vimEditing(settings: VimSettings): Extension {
  return compartment.of(build(settings));
}

export function setVimEditing(view: EditorView, settings: VimSettings): void {
  view.dispatch({ effects: compartment.reconfigure(build(settings)) });
}

function build(settings: VimSettings): Extension {
  // Off means off: no plugin, no panel, no key handling at all, so an editor
  // with the setting unset is byte for byte the editor everybody had before.
  if (!settings.on) {
    mapLeaveInsert('Escape');
    return [];
  }

  mapLeaveInsert(settings.leaveInsert);

  return [
    // Before every keymap: vim's own handling is a DOM event handler, and it
    // has to see a key before `indentWithTab` and the default bindings do. The
    // other way round, Normal mode would lose Enter and Backspace to the
    // default bindings, which is far worse than what it costs.
    //
    // What it costs is off the Mac. Vim binds nothing with Meta, so ⌘K and the
    // formatting keys reach their bindings untouched here; but `Mod-` is Ctrl
    // on Windows and Linux, and vim does bind `<C-b>`, `<C-e>` and `<C-i>` —
    // so bold, inline code and italic are vim's there while vim is on.
    vim(),
    modeWatcher,
    showPanel.of(statusPanel(settings.leaveInsert)),
    settings.leaveInsert === 'Escape' ? [] : releaseEscape,
  ];
}

/**
 * Teaches vim the chosen sequence.
 *
 * `Vim.map` writes into the library's one keymap, which every editor shares.
 * That is fine — this is one setting for the whole application — but it means
 * the previous choice has to be taken back rather than left lying there, or
 * somebody who tried `jj` and settled on `jk` would keep both forever.
 */
let mapped: LeaveInsert = 'Escape';

function mapLeaveInsert(leave: LeaveInsert): void {
  if (leave === mapped) return;
  if (mapped !== 'Escape') Vim.unmap(mapped, 'insert');
  if (leave !== 'Escape') Vim.map(leave, '<Esc>', 'insert');
  mapped = leave;
}

/**
 * Escape, when a sequence has taken over the mode change.
 *
 * It cannot be done inside vim: `<Esc>` leaving Insert mode is written into the
 * library ahead of its keymap, so unmapping it does nothing. The press has to
 * be taken before vim's handler sees it, which is what the highest precedence
 * buys — and then it does exactly what CodeMirror itself does with an Escape
 * nobody claimed, which is to hand the next Tab to the browser.
 *
 * Vim's own `Ctrl-[` and `Ctrl-c` still leave Insert mode, so nothing is lost
 * for somebody who reaches for them out of habit.
 */
const releaseEscape = Prec.highest(
  EditorView.domEventHandlers({
    keydown(event, view) {
      if (event.key !== 'Escape' || event.ctrlKey || event.altKey || event.metaKey) return false;
      // A menu owns Escape while it is open: there it means "close this", and
      // taking that away would leave the slash menu with no way to be dismissed.
      if (completionStatus(view.state) !== null) return false;

      view.setTabFocusMode(2000);
      return true;
    },
  }),
);

/**
 * Keeps Tab in step with the mode.
 *
 * Normal mode is not typing, so Tab there is not indentation; handing it to the
 * browser permanently — rather than for the two seconds an Escape buys — makes
 * leaving the note one key from wherever the cursor is. Insert mode takes it
 * straight back, because a nested list is still typed with Tab.
 *
 * Read from vim's own mode change rather than from a view update: entering
 * Insert mode with `i` changes no document and may dispatch no transaction.
 */
const modeWatcher = ViewPlugin.fromClass(
  class {
    private readonly view: EditorView;
    private readonly onMode: () => void;
    /** What was last asked for, so a two-second Escape window is not undone. */
    private armed: boolean | null = null;

    constructor(view: EditorView) {
      this.view = view;
      this.onMode = (): void => this.apply();
      getCM(view)?.on('vim-mode-change', this.onMode);
    }

    update(): void {
      if (this.armed === null) this.apply();
    }

    destroy(): void {
      getCM(this.view)?.off('vim-mode-change', this.onMode);
      // Switched off again: the note goes back to CodeMirror's default, where
      // Tab indents until an Escape says otherwise.
      if (this.armed !== null) this.view.setTabFocusMode(false);
    }

    apply(): void {
      const armed = !inserting(this.view);
      if (armed === this.armed) return;
      // `setTabFocusMode` writes into the view's input state, which does not
      // exist yet while the plugins are being built — hence the focus handler
      // below rather than a call from the constructor. The guard is what makes
      // that ordering a fact rather than a hope.
      if (!hasInputState(this.view)) return;
      this.armed = armed;
      this.view.setTabFocusMode(armed);
    }
  },
  {
    eventHandlers: {
      // The first arming, and the only moment that is certainly both after the
      // view is finished and before a key can be pressed: nobody presses Tab
      // in a note that does not have the focus.
      focus() {
        this.apply();
        return false;
      },
    },
  },
);

function hasInputState(view: EditorView): boolean {
  return (view as unknown as { inputState?: unknown }).inputState !== undefined;
}

function inserting(view: EditorView): boolean {
  return getCM(view)?.state.vim?.insertMode ?? false;
}

/**
 * The mode, named, at the foot of the note.
 *
 * Announced to a screen reader as well as drawn: in a modal editor the reason
 * a letter did not appear is the mode, and somebody who cannot see the line has
 * no other way to find that out.
 *
 * In Insert mode it also names the key that leaves it. That is the answer to
 * the dead end the setting could otherwise create — pick `kj`, forget it, and
 * every key you press is text.
 */
function statusPanel(leaveInsert: LeaveInsert): (view: EditorView) => Panel {
  return (view) => {
    const dom = document.createElement('div');
    dom.className = 'cm-vim-status';
    dom.setAttribute('role', 'status');

    const name = document.createElement('span');
    name.className = 'cm-vim-mode';
    const hint = document.createElement('span');
    hint.className = 'cm-vim-hint';
    dom.append(name, hint);

    const render = (mode: string, subMode?: string): void => {
      name.textContent = modeName(mode, subMode);
      hint.textContent =
        mode === 'insert' && leaveInsert !== 'Escape' ? copy.editor.vim.leaveWith(leaveInsert) : '';
    };
    const onMode = (event: { mode: string; subMode?: string }): void =>
      render(event.mode, event.subMode);
    // Held rather than looked up again on the way out: by the time the panel is
    // taken down, the plugin that owns the vim instance may already be gone.
    let listening: ReturnType<typeof getCM> = null;

    return {
      dom,
      top: false,
      // Subscribed on mount rather than here: a panel is built from the state,
      // which can happen before the plugin that owns the vim instance exists.
      mount: () => {
        listening = getCM(view);
        listening?.on('vim-mode-change', onMode);
        render(inserting(view) ? 'insert' : 'normal');
      },
      destroy: () => listening?.off('vim-mode-change', onMode),
    };
  };
}

function modeName(mode: string, subMode?: string): string {
  const words = copy.editor.vim;
  if (mode === 'insert') return words.insert;
  if (mode === 'replace') return words.replace;
  if (mode === 'visual') {
    if (subMode === 'linewise') return words.visualLine;
    if (subMode === 'blockwise') return words.visualBlock;
    return words.visual;
  }
  return words.normal;
}
