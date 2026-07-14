/** Single-user CodeMirror 6 markdown editor for local (device-only) notes.
 *
 *  Deliberately NOT the collaborative `<Editor>`: it never constructs a
 *  `y-codemirror.next` `yCollab` extension, never touches `Y.Doc`/awareness,
 *  and never opens a Hocuspocus WebSocket — local notes are strictly
 *  isolated from the server and from any multi-writer sync (see
 *  `local/localStore.ts`'s doc comment). This component is the minimal
 *  CodeMirror setup that operates directly on a plain string: `basicSetup` +
 *  `markdown()`, exactly like `<Editor>` uses, plus a single
 *  `EditorView.updateListener` extension (`localEditorExtensions`) that
 *  reports the full document text back to the caller on every change, which
 *  `LocalNotesView` uses to drive `writeLocal`. */

import { useEffect, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import styles from "./LocalEditor.module.css";

export interface LocalEditorProps {
  /** Local-notes-root-relative path of the note being edited — used only as
   *  the React re-mount key trigger (see the effect below), not read inside it. */
  path: string;
  /** The note's content at the moment this component (re)mounts. Only read
   *  once per `path` (to seed the CodeMirror doc); later prop changes while
   *  `path` stays the same are intentionally NOT re-applied, so the user's
   *  own typing is never clobbered by a stale re-render of the same value
   *  this component itself just reported via `onChange`. */
  content: string;
  /** Fired with the full document text on every doc change. */
  onChange: (content: string) => void;
}

/** The one piece of CodeMirror wiring specific to this component: reports the
 *  full doc text on every change that actually touches the document (ignores
 *  selection-only transactions). Exported so it can be unit-tested against a
 *  detached `EditorView` without simulating real DOM typing (see
 *  `LocalEditor.test.tsx`). */
export function localEditorExtensions(onChange: (content: string) => void): Extension {
  return EditorView.updateListener.of((update) => {
    if (update.docChanged) onChange(update.state.doc.toString());
  });
}

export function LocalEditor({ path, content, onChange }: LocalEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Always call the latest onChange without that identity forcing the editor
  // (and the user's cursor/scroll position) to be torn down and rebuilt.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: content,
        extensions: [basicSetup, markdown(), localEditorExtensions((text) => onChangeRef.current(text))],
      }),
    });

    return () => view.destroy();
    // Intentionally re-creates only on `path` change: `content` is the seed
    // value for a freshly opened note, not a controlled prop to keep back in
    // sync with on every keystroke (see the prop doc comment above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return <div ref={hostRef} className={styles.host} data-testid="local-editor-host" />;
}
