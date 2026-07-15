/** Live-preview decoration support for GFM task-list checkboxes
 *  (`- [ ] todo` / `- [x] done`). `@lezer/markdown`'s `Task` node only
 *  exists when the markdown extension set includes `GFM` (or `Task`)
 *  (verified live - see marks.ts's doc comment); its `TaskMarker` child is
 *  the literal `[ ]`/`[x]` text, which this module replaces with an
 *  interactive checkbox widget. Clicking the checkbox dispatches a document
 *  edit that toggles the marker text - the widget never mutates state on
 *  its own. */

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { WIDGET_CLASS } from "./marks";

interface DecoPiece {
  from: number;
  to: number;
  decoration: Decoration;
}

/** Renders a GFM task-list marker as a real `<input type=checkbox>`. Its
 *  document position (the `TaskMarker`'s `[from, to)`) is captured at
 *  decoration-build time so a click can dispatch a source-text toggle
 *  without needing to re-locate the marker from the DOM. */
export class TaskCheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }

  eq(other: TaskCheckboxWidget): boolean {
    return other.checked === this.checked && other.from === this.from && other.to === this.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = WIDGET_CLASS.taskCheckbox;
    input.checked = this.checked;
    input.addEventListener("click", (event) => {
      event.preventDefault();
      const insert = this.checked ? "[ ]" : "[x]";
      view.dispatch({ changes: { from: this.from, to: this.to, insert } });
    });
    return input;
  }

  ignoreEvent(): boolean {
    // Handled entirely by the click listener above; nothing here needs to
    // reach CodeMirror's own event handlers (e.g. cursor placement).
    return true;
  }
}

/** Finds GFM task-list markers in `[from, to)` and returns decoration
 *  pieces that replace each `TaskMarker` with a `TaskCheckboxWidget`. No-op
 *  unless the markdown extension used to parse `state` includes GFM (or at
 *  least `Task`) - see marks.ts. */
export function taskCheckboxDecorations(state: EditorState, from: number, to: number): DecoPiece[] {
  const pieces: DecoPiece[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (nodeRef) => {
      if (nodeRef.name !== "TaskMarker") return;
      const text = state.doc.sliceString(nodeRef.from, nodeRef.to);
      const checked = /\[x\]/i.test(text);
      pieces.push({
        from: nodeRef.from,
        to: nodeRef.to,
        decoration: Decoration.replace({
          widget: new TaskCheckboxWidget(checked, nodeRef.from, nodeRef.to),
        }),
      });
    },
  });
  return pieces;
}
