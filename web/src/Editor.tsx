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
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, keymap } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { GFM } from '@lezer/markdown';
import { useEffect, useRef } from 'react';

import { completion } from './editor/completion';
import { formatKeymap } from './editor/format';
import { embedContext, livePreview } from './editor/livePreview';
import { markdownTheme } from './editor/theme';

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
}

export function Editor({
  owner,
  path,
  initialContent,
  readOnly = false,
  onChange,
  onAttach,
}: EditorProps): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  // Kept in a ref so that changing the callback does not rebuild the editor and
  // throw away the cursor position mid-sentence.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onAttachRef = useRef(onAttach);
  onAttachRef.current = onAttach;

  useEffect(() => {
    if (host.current === null) return;

    const state = EditorState.create({
      doc: initialContent,
      extensions: [
        history(),
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
          ...historyKeymap,
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
        // Which note this is, so an embed can be turned into a URL against the
        // folder the note lives in.
        embedContext.of({ owner, dir: path.slice(0, Math.max(0, path.lastIndexOf('/'))) }),
        attachments(() => onAttachRef.current, readOnly),
        completion(),
        EditorView.lineWrapping,
        // `readOnly` refuses the edit; `editable` also stops the caret from
        // appearing, so the surface looks like what it is instead of looking
        // broken.
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });

    const instance = new EditorView({ state, parent: host.current });
    view.current = instance;
    if (!readOnly) instance.focus();

    return () => {
      instance.destroy();
      view.current = null;
    };
    // Rebuilt only when the open note changes — not when its content changes,
    // which would fight the person typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, path, readOnly]);

  return <div className="pane" data-readonly={readOnly} ref={host} />;
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
