/** Split-panel editor for a single ```mermaid diagram (Plan 7 Task 6):
 *  raw code in a `<textarea>` on the left, a debounced live preview
 *  (via `renderMermaid`) on the right. Fully controlled - `code` seeds the
 *  local draft once, `onSave`/`onClose` are the only way out, and neither
 *  the rest of the document nor the underlying `EditorView` is touched here
 *  at all (that wiring lives in `Editor.tsx`/`LocalEditor.tsx`, which turns
 *  `onSave`'s string into a `view.dispatch` via `mermaidEditor.ts`'s
 *  `applyMermaidEdit`). No "reveal the rest of the document" behavior - this
 *  component only ever sees the one diagram's source. */

import { useEffect, useRef, useState } from "react";
import { renderMermaid } from "./mermaid";
import styles from "./MermaidEditPanel.module.css";

export interface MermaidEditPanelProps {
  /** The diagram's current source (the fence's `CodeText` content) - seeds
   *  the textarea once on mount; later prop changes are intentionally NOT
   *  re-applied (this panel is only ever mounted for a single click, so
   *  there's nothing to resync to while it's open). */
  code: string;
  /** Called with the textarea's current content when "Übernehmen" is
   *  clicked. Does not close the panel itself - the caller decides (in
   *  practice: dispatches the doc change, then unmounts this component). */
  onSave: (newCode: string) => void;
  /** Called when "Abbrechen" is clicked - discards the draft, `onSave` is
   *  never called. */
  onClose: () => void;
  /** Debounce delay before re-rendering the preview after a keystroke.
   *  Defaults to 300ms; overridable so tests don't have to wait on the
   *  real-world value (same convention as `SearchPalette`'s `debounceMs`). */
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 300;

let previewIdSeq = 0;

export function MermaidEditPanel({ code, onSave, onClose, debounceMs = DEFAULT_DEBOUNCE_MS }: MermaidEditPanelProps) {
  const [draft, setDraft] = useState(code);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Stable across the component's lifetime - mermaid uses this as the
  // rendered `<svg>`'s root id (see mermaid.ts's `renderMermaid` doc
  // comment), so it must stay unique and unchanging across re-renders.
  const previewId = useRef(`mermaid-edit-preview-${++previewIdSeq}`).current;
  // Guards against a stale, superseded render resolving after a later
  // keystroke's - same pattern as SearchPalette's `requestId` ref.
  const requestId = useRef(0);

  useEffect(() => {
    const id = ++requestId.current;
    const timer = setTimeout(() => {
      renderMermaid(draft, previewId).then(
        (result) => {
          if (requestId.current !== id) return;
          setSvg(result);
          setError(null);
        },
        (err: unknown) => {
          if (requestId.current !== id) return;
          setError(err instanceof Error ? err.message : String(err));
        },
      );
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [draft, previewId, debounceMs]);

  return (
    <div className={styles.overlay} role="presentation">
      <div className={styles.panel} role="dialog" aria-modal="true" aria-label="Mermaid-Diagramm bearbeiten">
        <div className={styles.split}>
          <textarea
            className={styles.textarea}
            aria-label="Mermaid-Code"
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />

          <div className={styles.previewPane}>
            {error ? (
              <div className={styles.error} role="alert">
                {`Mermaid render error: ${error}`}
              </div>
            ) : (
              <div
                className={styles.preview}
                data-testid="mermaid-edit-preview"
                // The rendered SVG comes from mermaid's own `render()` under
                // `securityLevel: "strict"` (see mermaid.ts) - the same trust
                // boundary the live-preview widget itself already relies on.
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            )}
          </div>
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.cancelButton} onClick={onClose}>
            Abbrechen
          </button>
          <button type="button" className={styles.saveButton} onClick={() => onSave(draft)}>
            Übernehmen
          </button>
        </div>
      </div>
    </div>
  );
}
