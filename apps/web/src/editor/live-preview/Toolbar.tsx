/** Formatting toolbar for the markdown editor (Plan 7 Task 7): one button per
 *  command in `toolbar.ts`, plus a raw/formatted toggle button. Deliberately
 *  standalone - NOT wired into `Editor.tsx`/`LocalEditor.tsx` yet (that's a
 *  later integration task, kept separate to avoid file conflicts with other
 *  Plan 7 tasks running in parallel against those two files). */

import type { EditorView } from "@codemirror/view";
import {
  insertLink,
  insertMermaid,
  setHeading,
  toggleBold,
  toggleBulletList,
  toggleInlineCode,
  toggleItalic,
  toggleStrike,
} from "./toolbar";
import styles from "./Toolbar.module.css";

export interface EditorToolbarProps {
  /** The live `EditorView` the commands dispatch against, or `null` while the
   *  editor hasn't mounted yet - format buttons are disabled in that case. */
  view: EditorView | null;
  /** Whether the editor is currently showing raw markdown source (`true`) or
   *  the formatted live-preview (`false`). Purely a display flag - this
   *  component doesn't own the mode itself, it just reflects it. */
  raw: boolean;
  /** Called when the raw/formatted toggle button is clicked. */
  onToggleRaw: () => void;
}

interface FormatButton {
  label: string;
  title: string;
  run: (view: EditorView) => void;
}

const FORMAT_BUTTONS: FormatButton[] = [
  { label: "B", title: "Bold (Mod-b)", run: toggleBold },
  { label: "I", title: "Italic (Mod-i)", run: toggleItalic },
  { label: "S", title: "Strikethrough", run: toggleStrike },
  { label: "</>", title: "Inline code (Mod-e)", run: toggleInlineCode },
  { label: "H2", title: "Heading", run: (view) => setHeading(view, 2) },
  { label: "•", title: "Bullet list", run: toggleBulletList },
  { label: "Link", title: "Insert link", run: insertLink },
  { label: "Mermaid einfügen", title: "Insert a Mermaid diagram skeleton", run: insertMermaid },
];

export function EditorToolbar({ view, raw, onToggleRaw }: EditorToolbarProps) {
  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Formatting">
      {FORMAT_BUTTONS.map((button) => (
        <button
          key={button.label}
          type="button"
          className={styles.button}
          title={button.title}
          disabled={!view}
          // A button click first fires `mousedown`, which - unless
          // prevented - moves focus off the editor and onto the button
          // before the format command even runs. Preventing the default
          // here keeps focus (and the just-computed selection) in the
          // editor throughout the click, so the command applies where the
          // user was actually looking and typing resumes right where it
          // left off, with no extra click back into the editor needed.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (view) button.run(view);
          }}
        >
          {button.label}
        </button>
      ))}

      <button
        type="button"
        className={`${styles.button} ${styles.rawToggle}`}
        title={raw ? "Zu formatierter Ansicht wechseln" : "Zu Rohtext wechseln"}
        aria-pressed={raw}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onToggleRaw}
      >
        {raw ? "Roh" : "Formatiert"}
      </button>
    </div>
  );
}
