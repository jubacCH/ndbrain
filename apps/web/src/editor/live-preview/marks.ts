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
 *  `Strikethrough` (or the full `GFM` array) for that node to appear at all. */

import styles from "./live-preview.module.css";

export const MARK_CLASS = {
  bold: styles.bold,
  italic: styles.italic,
  strike: styles.strike,
  inlineCode: styles.inlineCode,
} as const;

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
