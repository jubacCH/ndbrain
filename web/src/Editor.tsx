/**
 * The writing surface: CodeMirror over the note's Markdown source.
 *
 * The document is the file, byte for byte — that is the product promise and the
 * reason v1's rich-text experiment was thrown away, since a converter round-trip
 * came back with escaped wikilinks and mangled tables. What sits on top is only
 * presentation: `./editor/livePreview` hides notation while the cursor is
 * elsewhere and `./editor/theme` gives structure size and weight instead of
 * colour. Nothing there can reach the text.
 *
 * Saving is debounced rather than immediate. Typing produces a keystroke every
 * few dozen milliseconds and each save is a file write plus a reindex; batching
 * turns a paragraph into one write instead of two hundred.
 */

import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, keymap } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { GFM } from '@lezer/markdown';
import { useEffect, useRef } from 'react';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { tagContext } from './editor/commands';
import { completion } from './editor/completion';
import { formatKeymap } from './editor/format';
import { embedContext, livePreview } from './editor/livePreview';
import { contentStart, frontmatter } from './editor/frontmatterView';
import { tables } from './editor/tableView';
import { markdownTheme } from './editor/theme';
import { VIM_OFF, setVimEditing, vimEditing, type VimSettings } from './editor/vim';
import type { LeaveInsert } from './prefs';

export interface EditorProps {
  /**
   * Identifies the open note; changing either part replaces the document.
   *
   * The owner belongs in the identity, not just the path: two vaults can hold a
   * `Projekte/Notizen.md`, and switching between them must not leave the first
   * one's text on screen under the second one's name.
   */
  owner: string;
  path: string;
  initialContent: string;
  /**
   * A note the caller may read but not write — shared read-only.
   *
   * Locked here as well as at the server, so the text cannot be typed into in
   * the first place. Letting somebody write a paragraph and only then telling
   * them it cannot be saved is how a person loses work in a tool that keeps
   * exactly one copy.
   */
  readOnly?: boolean;
  /**
   * Refuses input for a moment without rebuilding the editor — while the note
   * is being deleted. `readOnly` cannot do this: changing it rebuilds from
   * `initialContent` and would throw away text that has not been saved yet,
   * which matters exactly when the delete is cancelled.
   */
  locked?: boolean;
  /**
   * The tags the vault allows, for `/tag`.
   *
   * `null` means the registry could not be read. The menu then says so instead
   * of falling back to the tags already in use — offering those would let a
   * typo that is already in the vault spread further, which is the opposite of
   * what the registry is for.
   */
  tags?: readonly string[] | null;
  /**
   * A 1-based, file-relative line to put the cursor on and scroll into view —
   * the task list's "open at the right line". Re-applied whenever it changes,
   * even while this note stays open, so clicking a second task in the note
   * that is already on screen jumps again without rebuilding the editor.
   */
  line: number | undefined;
  onChange: (content: string) => void;
  /**
   * Stores a pasted or dropped file beside this note and answers with its name.
   *
   * Beside the note rather than in one central folder: that is what makes a bare
   * `![[rack.png]]` resolvable without an index lookup, and it means moving a
   * note and its picture together is a folder move rather than a broken link.
   *
   * Returns null when the upload failed; the editor then leaves the text alone
   * rather than inserting a link to something that is not there.
   */
  onAttach?: (file: File) => Promise<string | null>;
  /**
   * Modal editing, from the preferences.
   *
   * Two plain values rather than one object, because they are effect
   * dependencies: a fresh `{ on, leaveInsert }` on every render would
   * reconfigure the editor on every keystroke.
   */
  vimMode?: boolean;
  vimLeaveInsert?: LeaveInsert;
  /**
   * The live room for this note, once it has synced. `null` or absent is
   * today's mode.
   *
   * The document then comes from `text` rather than from `initialContent`, and
   * changing that is a rebuild for the same reason changing `readOnly` is: the
   * editor's document is a different object. That is safe here because the
   * prop only appears once the first sync is done, and the room holds
   * everything typed before then — which is nothing, because the editor is
   * locked until it arrives.
   */
  collab?: { text: Y.Text; awareness: Awareness } | null;
}

export interface NoteExtensions {
  owner: string;
  path: string;
  readOnly?: boolean;
  /** Read through a getter, so a later answer reaches an editor already built. */
  attach?: () => ((file: File) => Promise<string | null>) | undefined;
  tags?: () => readonly string[] | null;
  onChange?: (content: string) => void;
  /**
   * Modal editing, as it stands when the editor is built.
   *
   * Only the starting value: the extension sits in a compartment of its own and
   * is reconfigured from the component when the setting changes, because
   * rebuilding the editor would throw away unsaved text. Left out, vim is off.
   */
  vim?: VimSettings;
  /**
   * A live room.
   *
   * The document then comes from the shared text rather than from a string,
   * and undo is Yjs's, scoped to this tab's own operations: ⌘Z must never take
   * back what somebody else typed. Live preview, tables, completion and vim
   * are untouched, because they sit on CodeMirror state only.
   */
  collab?: { text: Y.Text; awareness: Awareness; undo: Y.UndoManager };
}

/**
 * Everything the writing surface is made of, as one list.
 *
 * Pulled out of the component so that the round-trip tests can open a note
 * through the very stack the application uses. A test that assembled its own
 * subset would prove that *some* editor leaves the bytes alone, which is not the
 * promise being made.
 */
export function noteExtensions({
  owner,
  path,
  readOnly = false,
  attach,
  tags,
  onChange,
  vim,
  collab,
}: NoteExtensions): Extension[] {
  return [
    /**
     * The file's own line endings, kept as characters.
     *
     * Without this CodeMirror splits the document on `\r\n` as well as `\n`
     * and joins it back with `\n`, so a note written with CRLF comes out of
     * the editor one character per line shorter than it went in. That is a
     * changed file on its own; with a room it is worse, because every offset
     * `y-codemirror.next` maps between the view and the shared text would be
     * off by one per line and an edit would land somewhere else entirely.
     *
     * Set for both modes, not only the live one: the promise that the document
     * is the file byte for byte is older than collaboration, and having the
     * two modes disagree about it would be a second bug rather than a fix.
     */
    EditorState.lineSeparator.of('\n'),
    // First, and before every keymap: vim answers a key press with a DOM event
    // handler, and in Normal mode it has to see the key before `indentWithTab`
    // and the default bindings do.
    vimEditing(vim ?? VIM_OFF),
    // A room brings its own history, scoped to this tab; see `collab`.
    ...(collab === undefined
      ? [history()]
      : [yCollab(collab.text, collab.awareness, { undoManager: collab.undo })]),
    drawSelection(),
    highlightActiveLine(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    // Finding something inside a long note should not mean scrolling it.
    search({ top: true }),
    highlightSelectionMatches(),
    keymap.of([
      // Before the default bindings: both claim Backspace, and the
      // bracket-aware one has to win when it applies. Formatting comes
      // early too, since `Mod-i` and `Mod-k` are otherwise unclaimed but
      // `Mod-e` is not.
      ...closeBracketsKeymap,
      ...formatKeymap,
      ...searchKeymap,
      ...(collab === undefined ? historyKeymap : yUndoManagerKeymap),
      // Tab indents, Shift-Tab outdents. Left unbound it belongs to the
      // browser and moves the focus out of the note, which is the accessible
      // default and the wrong one here: this is a text editor, and a nested
      // list is typed with Tab.
      //
      // The way out by keyboard stays: CodeMirror answers Escape by handing
      // Tab back to the browser for two seconds, or until the next other key,
      // so Escape and then Tab leaves the note. Nothing needs binding for it.
      //
      // A table cell takes Tab first — the table editor reads it off its own
      // inputs — and the completion list takes it through its own keymap.
      indentWithTab,
      ...defaultKeymap,
    ]),
    // GFM is needed for task lists, strikethrough and tables, all of which
    // appear in ordinary notes. `markdown()` also installs its own keymap,
    // which is what continues a list on Enter.
    //
    // `languages` is loaded for fenced blocks; each mode is a dynamic
    // import, so the bundle grows by a lazy chunk rather than by every
    // grammar CodeMirror ships.
    markdown({ extensions: [GFM], codeLanguages: languages }),
    markdownTheme(),
    livePreview(),
    // Tables are the one element that stays drawn while it is being written in,
    // so this is a state field rather than part of live preview's view plugin.
    tables(),
    // The frontmatter fold, a state field for the same reason: it replaces line
    // breaks, which a view plugin may not do.
    frontmatter(),
    // Which note this is, so an embed can be turned into a URL against the
    // folder the note lives in.
    embedContext.of({ owner, dir: path.slice(0, Math.max(0, path.lastIndexOf('/'))) }),
    tagContext.of(tags ?? (() => null)),
    attachments(attach ?? (() => undefined), readOnly),
    completion(),
    EditorView.lineWrapping,
    // `readOnly` refuses the edit; `editable` also stops the caret from
    // appearing, so the surface looks like what it is instead of looking
    // broken.
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange?.(update.state.doc.toString());
    }),
  ];
}

export function Editor({
  owner,
  path,
  initialContent,
  readOnly = false,
  locked = false,
  tags = null,
  line,
  onChange,
  onAttach,
  vimMode = false,
  vimLeaveInsert = 'Escape',
  collab = null,
}: EditorProps): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lock = useRef(new Compartment());
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  // Kept in a ref so that changing the callback does not rebuild the editor and
  // throw away the cursor position mid-sentence.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onAttachRef = useRef(onAttach);
  onAttachRef.current = onAttach;
  // The tag registry arrives from the server after the editor is built, so the
  // menu reads it through a ref rather than the editor being rebuilt for it —
  // rebuilding would throw away the cursor mid-sentence.
  const tagsRef = useRef(tags);
  tagsRef.current = tags;
  // Read through a ref for the same reason: the build effect must not list the
  // vim setting among its dependencies, or switching it would rebuild the
  // editor and lose whatever has not been saved.
  const vimRef = useRef<VimSettings>({ on: vimMode, leaveInsert: vimLeaveInsert });
  vimRef.current = { on: vimMode, leaveInsert: vimLeaveInsert };

  useEffect(() => {
    if (host.current === null) return;

    // One undo manager per editor, because undo is per tab: it is built here
    // rather than passed in so that it lives and dies with the view it serves.
    const live = collab === null ? undefined : { ...collab, undo: new Y.UndoManager(collab.text) };

    const text = live === undefined ? initialContent : live.text.toString();
    const state = EditorState.create({
      // From the shared text when there is one: `initialContent` is the REST
      // read, which is a second, older copy of the same note.
      doc: text,
      // Past the frontmatter. Left at the default the caret opens inside the
      // YAML block, which unfolds it on every single open and puts the cursor
      // in the bookkeeping rather than in the writing.
      selection: { anchor: contentStart(text) },
      // The lock goes first: `readOnly` and `editable` take the first value
      // given, and `noteExtensions` gives one of its own.
      extensions: [
        lock.current.of(lockExtension(lockedRef.current)),
        ...noteExtensions({
          owner,
          path,
          readOnly,
          attach: () => onAttachRef.current,
          tags: () => tagsRef.current,
          onChange: (content) => onChangeRef.current(content),
          vim: vimRef.current,
          ...(live === undefined ? {} : { collab: live }),
        }),
      ],
    });

    const instance = new EditorView({ state, parent: host.current });
    view.current = instance;
    if (!readOnly) instance.focus();

    return () => {
      instance.destroy();
      view.current = null;
      live?.undo.destroy();
    };
    // Rebuilt only when the open note changes, or when the room's shared text
    // arrives or goes — not when its content changes, which would fight the
    // person typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, path, readOnly, collab?.text]);

  // Reconfigured in place, so the document and the cursor stay as they are.
  useEffect(() => {
    view.current?.dispatch({ effects: lock.current.reconfigure(lockExtension(locked)) });
  }, [locked]);

  // The same treatment for vim, and for the same reason: somebody who switches
  // modal editing on halfway through a paragraph keeps the paragraph.
  useEffect(() => {
    const instance = view.current;
    if (instance !== null) setVimEditing(instance, { on: vimMode, leaveInsert: vimLeaveInsert });
  }, [vimMode, vimLeaveInsert]);

  // Placing the cursor is a second effect rather than part of the document's
  // initial selection above: that effect only runs when the note switches, so
  // a second click from the task list — same note, a different line — would
  // otherwise do nothing. Declared after the build effect, so on the render
  // that opens a new note it runs against the instance that effect just
  // created rather than a stale or missing one.
  useEffect(() => {
    const instance = view.current;
    if (instance === null || line === undefined) return;

    const clamped = Math.min(Math.max(1, Math.trunc(line)), instance.state.doc.lines);
    const pos = instance.state.doc.line(clamped).from;
    instance.dispatch({ selection: { anchor: pos, head: pos }, scrollIntoView: true });
    if (!readOnly) instance.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, path, line]);

  return <div className="pane" data-readonly={readOnly} data-locked={locked} ref={host} />;
}

function lockExtension(locked: boolean): Extension {
  return locked ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];
}

/**
 * Paste and drop, for anything that is not text.
 *
 * The guard matters more than it looks: a paste carrying both an image and its
 * HTML wrapper — which is what copying from a browser produces — must not become
 * two insertions, and a paste of plain text must go on behaving exactly as it
 * always has. So this only claims the event when there is a file *and* no text
 * alternative, and otherwise lets CodeMirror handle it.
 *
 * Insertion happens after the upload, at the position the cursor was in when it
 * started. A placeholder would read better on a slow connection, but it would
 * also have to be found again afterwards in a document somebody has gone on
 * typing into — and getting that wrong edits the wrong part of a note.
 */
function attachments(
  get: () => ((file: File) => Promise<string | null>) | undefined,
  readOnly: boolean,
): Extension {
  const take = (files: FileList | null | undefined, view: EditorView, at: number): boolean => {
    const attach = get();
    const list = [...(files ?? [])];
    if (readOnly || attach === undefined || list.length === 0) return false;

    void (async () => {
      for (const file of list) {
        const name = await attach(file);
        if (name === null) continue;

        const embed = `![[${name}]]`;
        const pos = Math.min(at, view.state.doc.length);
        view.dispatch({
          changes: { from: pos, insert: embed },
          selection: { anchor: pos + embed.length },
        });
        at = pos + embed.length;
      }
    })();

    return true;
  };

  return EditorView.domEventHandlers({
    paste(event, view) {
      const data = event.clipboardData;
      // Text wins whenever there is any: copying from a browser puts the image
      // *and* its markup on the clipboard, and pasting a link should paste a link.
      if (data === null || data.getData('text/plain') !== '') return false;
      if (!take(data.files, view, view.state.selection.main.from)) return false;
      event.preventDefault();
      return true;
    },

    drop(event, view) {
      const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (at === null) return false;
      if (!take(event.dataTransfer?.files, view, at)) return false;
      event.preventDefault();
      return true;
    },
  });
}
