/**
 * The writing surface: CodeMirror over the note's Markdown source.
 *
 * Plain source, not a WYSIWYG. v1 proved by experiment that a rich-text editor
 * destroys the Markdown round-trip — wikilinks come back escaped, frontmatter and
 * tables mangled — and the files being untouched is the whole product promise.
 *
 * Saving is debounced rather than immediate. Typing produces a keystroke every
 * few dozen milliseconds and each save is a file write plus a reindex; batching
 * turns a paragraph into one write instead of two hundred.
 */

import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, drawSelection, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { GFM } from '@lezer/markdown';
import { useEffect, useRef } from 'react';

import { wikilinkCompletion } from './wikilink';

export interface EditorProps {
  /** Identifies the open note; changing it replaces the document. */
  path: string;
  initialContent: string;
  onChange: (content: string) => void;
}

export function Editor({ path, initialContent, onChange }: EditorProps): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  // Kept in a ref so that changing the callback does not rebuild the editor and
  // throw away the cursor position mid-sentence.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (host.current === null) return;

    const state = EditorState.create({
      doc: initialContent,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        // GFM is needed for task lists and strikethrough, both of which appear
        // in ordinary notes.
        markdown({ extensions: [GFM] }),
        wikilinkCompletion(),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });

    const instance = new EditorView({ state, parent: host.current });
    view.current = instance;
    instance.focus();

    return () => {
      instance.destroy();
      view.current = null;
    };
    // Rebuilt only when the open note changes — not when its content changes,
    // which would fight the person typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return <div className="pane" ref={host} />;
}
