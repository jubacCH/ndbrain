/** CSS class constants + Lezer-markdown-node-name -> style mapping for the
 *  live-preview decoration layer (see decorations.ts).
 *
 *  Node names verified live against the installed `@lezer/markdown@1.7.1`
 *  parser (as produced by `@codemirror/lang-markdown`'s `markdown()`):
 *  `StrongEmphasis` / `Emphasis` / `Strikethrough` / `InlineCode` are the
 *  content nodes; `EmphasisMark` (shared by bold/italic), `StrikethroughMark`
 *  and `CodeMark` are their delimiter children. `Strikethrough` is a GFM
 *  extension of `@lezer/markdown`, not part of plain CommonMark - the
 *  `markdown()` extension used against a document must include
 *  `Strikethrough` (or the full `GFM` array) for that node to appear at all.
 *
 *  Block node names (plain CommonMark, no GFM needed - also verified live):
 *  `ATXHeading1`..`ATXHeading6` wrap a leading `HeaderMark` (`#`..`######`);
 *  `Blockquote` contains one `QuoteMark` (`>`) per quoted line (a multi-line
 *  blockquote has one `QuoteMark` child per line, not just the first);
 *  `HorizontalRule` covers the whole `---`/`***` line as a single node;
 *  `BulletList`/`OrderedList` contain `ListItem`s, each starting with a
 *  `ListMark` (`-`/`*`/`+` or `1.`).
 *
 *  Links + GFM task lists (verified live against `@lezer/markdown@1.7.1` with
 *  the `GFM` extension array from `@codemirror/lang-markdown`'s peer
 *  `@lezer/markdown`):
 *  `Link` wraps `[text](url)` with `LinkMark` (`[`, `]`, `(`, `)`) children
 *  and a `URL` child - this also fires as a "shortcut reference" for bare
 *  `[text]` (no `(url)`, e.g. the inner brackets of a `[[wikilink]]`), in
 *  which case it has no `URL` child and must be left alone.
 *  `Task` (only present when the markdown extension set includes `GFM` or
 *  `Task`) wraps a list item's `- [ ] text`/`- [x] text` body; its
 *  `TaskMarker` child is the literal `[ ]`/`[x]`. Wikilinks (`[[Target]]`)
 *  have no dedicated node at all - `@lezer/markdown` has no concept of them -
 *  so they are found by regex instead (see wikilink.ts). */

import styles from "./live-preview.module.css";

export const MARK_CLASS = {
  bold: styles.bold,
  italic: styles.italic,
  strike: styles.strike,
  inlineCode: styles.inlineCode,
  link: styles.link,
  wikilink: styles.wikilink,
} as const;

/** Line-level style classes for block decorations (applied via
 *  `Decoration.line`, not `Decoration.mark` - see decorations.ts). */
export const BLOCK_LINE_CLASS = {
  quote: styles.quote,
} as const;

/** CSS classes for widget-rendered block replacements (see decorations.ts'
 *  `ListMarkerWidget` / `HrWidget`). */
export const WIDGET_CLASS = {
  listMarker: styles.listMarker,
  hr: styles.hr,
  taskCheckbox: styles.taskCheckbox,
} as const;

const HEADING_LINE_CLASSES: readonly string[] = [
  styles.h1,
  styles.h2,
  styles.h3,
  styles.h4,
  styles.h5,
  styles.h6,
];

/** Maps a syntax node name to the CSS class used to style its formatted
 *  inline content, or null if the node isn't a styled inline mark. */
export function styleForNode(nodeName: string): string | null {
  switch (nodeName) {
    case "StrongEmphasis":
      return MARK_CLASS.bold;
    case "Emphasis":
      return MARK_CLASS.italic;
    case "Strikethrough":
      return MARK_CLASS.strike;
    case "InlineCode":
      return MARK_CLASS.inlineCode;
    default:
      return null;
  }
}

/** Parses the heading level (1-6) out of an `ATXHeadingN` node name, or null
 *  if the name isn't an ATX heading node. */
export function headingLevelOf(nodeName: string): number | null {
  const match = /^ATXHeading([1-6])$/.exec(nodeName);
  return match ? Number(match[1]) : null;
}

/** The `Decoration.line` CSS class for a given heading level (1-6). */
export function headingLineClass(level: number): string {
  const className = HEADING_LINE_CLASSES[level - 1];
  if (!className) throw new Error(`invalid heading level: ${level}`);
  return className;
}
