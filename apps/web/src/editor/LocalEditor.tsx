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

import { useEffect, useRef, useState } from "react";
import { Prec, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { livePreviewExtensions, rawCompartment, setRawMode } from "./live-preview/extensions";
import { MermaidEditPanel } from "./live-preview/MermaidEditPanel.tsx";
import { applyMermaidEdit, mermaidEditorHandler, type MermaidEditRequest } from "./live-preview/mermaidEditor";
// Explicit `.tsx` suffix: on a case-insensitive filesystem, a bare
// `"./live-preview/Toolbar"` specifier can wrongly resolve to the sibling
// `toolbar.ts` (formatting commands) instead of this component (Task 7
// finding) - the extension pins it to the right file.
import { EditorToolbar } from "./live-preview/Toolbar.tsx";
import { formatKeymap } from "./live-preview/toolbar";
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
  // Holds the live `EditorView` so the raw/formatted toggle below can reach it
  // without forcing a remount - the view itself is still (re)created by the
  // effect further down whenever `path` changes.
  const viewRef = useRef<EditorView | null>(null);
  // Mirrors `viewRef` in React state, purely so `<EditorToolbar>` (which needs
  // the view as a prop to dispatch formatting commands) re-renders once the
  // real view exists - set at the end of the mount effect below and cleared
  // in its cleanup. Kept separate from `viewRef` (rather than replacing it)
  // so the mount effect's dependency array doesn't have to change: code that
  // only needs synchronous access to the current view (the raw-mode effect,
  // the mermaid-save handler) keeps reading `viewRef`.
  const [view, setView] = useState<EditorView | null>(null);
  // Always call the latest onChange without that identity forcing the editor
  // (and the user's cursor/scroll position) to be torn down and rebuilt.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Raw (plain markdown source, today's behavior) vs. formatted (live-preview
  // decorations) display mode. Default is formatted (`false`) - see
  // `live-preview/extensions.ts`. The actual toggle button is a later task
  // (Plan 7 Task 7's `EditorToolbar`); this is the state + wiring it will
  // call into.
  const [raw, setRaw] = useState(false);
  // The diagram currently open in the split edit panel (Plan 7 Task 6), or
  // null when it's closed - drives whether `<MermaidEditPanel>` renders at
  // all. Set by clicking a rendered diagram, via `mermaidEditorHandler`
  // below.
  const [mermaidEdit, setMermaidEdit] = useState<MermaidEditRequest | null>(null);
  // The live "open the split editor" handler the `mermaidEditorHandler`
  // facet extension (added to the view's extensions once, below) forwards
  // to. Written directly during render (not in an effect) - same pattern as
  // `onChangeRef` just below.
  const openMermaidEditorRef = useRef<(request: MermaidEditRequest) => void>(() => {});
  openMermaidEditorRef.current = (request) => setMermaidEdit(request);
  // Mirrors `raw` for the mount effect below (which intentionally does NOT
  // depend on `raw` - only on `path` - so toggling it never recreates the
  // view), so a freshly (re)mounted view (e.g. after a `path` change) still
  // starts in whatever mode was last set.
  const rawRef = useRef(raw);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: content,
        extensions: [
          basicSetup,
          // `Mod-i` collides with `basicSetup`'s own `defaultKeymap` binding
          // (`selectParentSyntax`, with `preventDefault: true`) - verified
          // live against the installed `@codemirror/commands@6.10.4`.
          // `Prec.high` makes these bindings win regardless of extension
          // array order, without needing to fork or reorder `basicSetup`.
          Prec.high(keymap.of(formatKeymap)),
          markdown({ extensions: [GFM] }),
          rawCompartment.of(livePreviewExtensions()),
          mermaidEditorHandler.of((request) => openMermaidEditorRef.current(request)),
          localEditorExtensions((text) => onChangeRef.current(text)),
        ],
      }),
    });
    viewRef.current = view;
    // Sync the freshly created view to whatever raw/formatted mode was last
    // set (see `rawRef`'s doc comment above) - a no-op the first time round.
    setRawMode(view, rawRef.current);
    setView(view);

    return () => {
      viewRef.current = null;
      setView(null);
      view.destroy();
    };
    // Intentionally re-creates only on `path` change: `content` is the seed
    // value for a freshly opened note, not a controlled prop to keep back in
    // sync with on every keystroke (see the prop doc comment above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Applies a `raw` toggle to the already-mounted view in place (via the
  // compartment), instead of remounting the whole editor - see
  // `live-preview/extensions.ts`'s `setRawMode`.
  useEffect(() => {
    rawRef.current = raw;
    if (viewRef.current) setRawMode(viewRef.current, raw);
  }, [raw]);

  return (
    <>
      {/* A sibling of the host div (not a wrapping element) so the host keeps
       *  its existing `flex: 1` layout inside `LocalNotesView`'s flex-column
       *  `.editorPane` unchanged. */}
      <EditorToolbar view={view} raw={raw} onToggleRaw={() => setRaw((current) => !current)} />
      <div ref={hostRef} className={styles.host} data-testid="local-editor-host" />

      {mermaidEdit && (
        <MermaidEditPanel
          code={mermaidEdit.code}
          onSave={(newCode) => {
            if (viewRef.current) applyMermaidEdit(viewRef.current, mermaidEdit, newCode);
            setMermaidEdit(null);
          }}
          onClose={() => setMermaidEdit(null)}
        />
      )}
    </>
  );
}
