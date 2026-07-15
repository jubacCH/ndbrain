/** Formatting commands + shortcuts for the markdown editor's live-preview
 *  toolbar (Plan 7 Task 7). Every command is a pure function of an
 *  `EditorView`: it reads the current selection, dispatches a single
 *  `view.dispatch({ changes, selection })` transaction against the markdown
 *  SOURCE text, and never touches decorations (Task 4-6) directly - those
 *  react to the resulting doc change on their own.
 *
 *  Only `@codemirror/state` + `@codemirror/view` are used here (verified live
 *  against the installed versions - `@codemirror/state@6.7.1`,
 *  `@codemirror/view@6.43.6`, pinned in `apps/web/package.json`).
 *  `@codemirror/commands` is NOT a direct dependency of `apps/web` (only a
 *  transitive one, pulled in by `codemirror`'s own `basicSetup` bundle) - so
 *  it's deliberately not imported here; `EditorSelection`/`KeyBinding` cover
 *  everything these commands need. */

import { EditorSelection, type ChangeSpec } from "@codemirror/state";
import { EditorView, type KeyBinding } from "@codemirror/view";

/** Wraps (or, if already wrapped, unwraps) every selection range with
 *  `marker` on both sides - `**` for bold, `*` for italic, `~~` for
 *  strikethrough, `` ` `` for inline code. "Already wrapped" is decided by
 *  looking only at the characters immediately before/after the selection
 *  (per the Task 7 brief), not by parsing the syntax tree, so it works the
 *  same in raw and live-preview mode alike. An empty (cursor-only) selection
 *  inserts an empty `markermarker` pair and places the cursor exactly between
 *  the two markers, ready to type the formatted text. */
function toggleWrap(view: EditorView, marker: string): void {
  const { state } = view;
  const markerLen = marker.length;

  const tr = state.changeByRange((range) => {
    const { from, to } = range;

    if (from === to) {
      return {
        changes: { from, to, insert: marker + marker },
        range: EditorSelection.cursor(from + markerLen),
      };
    }

    const before = state.doc.sliceString(Math.max(0, from - markerLen), from);
    const after = state.doc.sliceString(to, Math.min(state.doc.length, to + markerLen));
    const alreadyWrapped = before === marker && after === marker;

    if (alreadyWrapped) {
      const changes: ChangeSpec[] = [
        { from: from - markerLen, to: from, insert: "" },
        { from: to, to: to + markerLen, insert: "" },
      ];
      return {
        changes,
        range: EditorSelection.range(from - markerLen, to - markerLen),
      };
    }

    const changes: ChangeSpec[] = [
      { from, to: from, insert: marker },
      { from: to, to, insert: marker },
    ];
    return {
      changes,
      range: EditorSelection.range(from + markerLen, to + markerLen),
    };
  });

  view.dispatch(tr);
}

export function toggleBold(view: EditorView): void {
  toggleWrap(view, "**");
}

export function toggleItalic(view: EditorView): void {
  toggleWrap(view, "*");
}

export function toggleStrike(view: EditorView): void {
  toggleWrap(view, "~~");
}

export function toggleInlineCode(view: EditorView): void {
  toggleWrap(view, "`");
}

/** Prefixes the line the (primary) selection is on with `level` `#`s + a
 *  space, first stripping any existing heading marker. Setting the SAME
 *  level again removes the marker entirely (toggle off); setting a different
 *  level replaces it. */
export function setHeading(view: EditorView, level: 1 | 2 | 3 | 4 | 5 | 6): void {
  const { state } = view;
  const existingMarker = /^(#{1,6})[ \t]*/;

  const tr = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.head);
    const match = existingMarker.exec(line.text);
    const currentLevel = match ? match[1].length : 0;
    const existingLength = match ? match[0].length : 0;

    const insert = currentLevel === level ? "" : "#".repeat(level) + " ";
    const delta = insert.length - existingLength;

    return {
      changes: { from: line.from, to: line.from + existingLength, insert },
      range: EditorSelection.range(
        Math.max(line.from, range.anchor + delta),
        Math.max(line.from, range.head + delta),
      ),
    };
  });

  view.dispatch(tr);
}

/** Toggles a `- ` bullet-list prefix on every line spanned by the selection.
 *  If ALL of those lines already start with `- `, it's removed from all of
 *  them; otherwise it's added to all of them. Uses `state.changes(...)` +
 *  `ChangeSet.mapPos` (rather than hand-rolled offset arithmetic) to map the
 *  original selection through a variable number of per-line edits, since a
 *  multi-line selection can span lines that each shift the mapped position
 *  by a different amount. */
export function toggleBulletList(view: EditorView): void {
  const { state } = view;
  const BULLET = "- ";

  const tr = state.changeByRange((range) => {
    const startLine = state.doc.lineAt(range.from);
    const endLine = state.doc.lineAt(range.to);

    const lines = [];
    for (let n = startLine.number; n <= endLine.number; n++) lines.push(state.doc.line(n));

    const allBulleted = lines.every((line) => line.text.startsWith(BULLET));

    const changes: ChangeSpec[] = lines.map((line) =>
      allBulleted ? { from: line.from, to: line.from + BULLET.length, insert: "" } : { from: line.from, to: line.from, insert: BULLET },
    );
    const changeSet = state.changes(changes);

    return {
      changes: changeSet,
      range: EditorSelection.range(changeSet.mapPos(range.anchor), changeSet.mapPos(range.head)),
    };
  });

  view.dispatch(tr);
}

/** Inserts a markdown link. An empty selection inserts `[text](url)` with
 *  "text" selected (ready to type the link label); a non-empty selection is
 *  wrapped as `[selection](url)` with "url" selected (ready to paste a URL). */
export function insertLink(view: EditorView): void {
  const { state } = view;

  const tr = state.changeByRange((range) => {
    const { from, to } = range;
    const selected = state.doc.sliceString(from, to);
    const label = selected || "text";
    const insert = `[${label}](url)`;

    const labelStart = from + 1;
    const labelEnd = labelStart + label.length;
    const urlStart = labelEnd + 2; // past "](""
    const urlEnd = urlStart + "url".length;

    return {
      changes: { from, to, insert },
      range: selected ? EditorSelection.range(urlStart, urlEnd) : EditorSelection.range(labelStart, labelEnd),
    };
  });

  view.dispatch(tr);
}

/** Inserts a minimal, valid Mermaid fence skeleton at the (primary)
 *  selection, replacing it. Leaves the cursor on the last diagram line
 *  (right before the closing fence) so the user can start editing the
 *  diagram immediately. Rendering of the fence into an actual diagram is
 *  Task 5/6's job (the mermaid widget) - this only inserts the markdown
 *  source.
 *
 *  A fenced code block only parses if both its opening and closing ```
 *  lines stand alone - so this pads the insert with newlines whenever the
 *  insertion point isn't already at a line boundary: a leading blank line
 *  is added when there's text before the insertion point on its line (a
 *  cursor mid-line, or at the end of a non-empty line), and a trailing
 *  newline is added when there's text after the insertion point on its
 *  line (a cursor at the start of - or inside - a non-empty line). Without
 *  this, inserting into "hello|world" would glue "hello" onto the opening
 *  fence and "world" onto the closing fence - and inserting at the start of
 *  a non-empty line would produce an invalid closing-fence line like
 *  "```rest", leaving the fence unterminated and swallowing the rest of the
 *  document as code. An empty document / empty line needs no padding at
 *  all, matching the previous (unpadded) behavior. */
export function insertMermaid(view: EditorView): void {
  const { state } = view;
  const body = "graph TD\n  A --> B\n";
  const fence = "```mermaid\n" + body + "```";

  const tr = state.changeByRange((range) => {
    const { from, to } = range;

    const startLine = state.doc.lineAt(from);
    const textBefore = state.doc.sliceString(startLine.from, from);
    const endLine = state.doc.lineAt(to);
    const textAfter = state.doc.sliceString(to, endLine.to);

    const leadingPad = textBefore === "" ? "" : "\n\n";
    const trailingPad = textAfter === "" ? "" : "\n";
    const insert = leadingPad + fence + trailingPad;

    const cursor = from + leadingPad.length + "```mermaid\n".length + body.length;
    return {
      changes: { from, to, insert },
      range: EditorSelection.cursor(cursor),
    };
  });

  view.dispatch(tr);
}

/** Keyboard shortcuts for the most-used commands above. Not wired into any
 *  editor yet (that's a later integration task) - exported standalone so it
 *  can be added to an `EditorState`'s extensions with `keymap.of(formatKeymap)`. */
export const formatKeymap: KeyBinding[] = [
  {
    key: "Mod-b",
    run: (view) => {
      toggleBold(view);
      return true;
    },
  },
  {
    key: "Mod-i",
    run: (view) => {
      toggleItalic(view);
      return true;
    },
  },
  {
    key: "Mod-e",
    run: (view) => {
      toggleInlineCode(view);
      return true;
    },
  },
];
