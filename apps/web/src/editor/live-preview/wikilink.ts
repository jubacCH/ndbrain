/** Live-preview decoration support for `[[Target]]` / `[[Target|Alias]]`
 *  wikilinks. `@lezer/markdown` has no native concept of wikilinks at all
 *  (verified live - see marks.ts's doc comment), so they are found here by
 *  regex over the raw text instead of the syntax tree. The source text is
 *  never touched - only the `[[`, `]]` delimiters and (for an aliased link)
 *  the `Target|` prefix are hidden via `Decoration.replace({})`, and the
 *  visible remainder is wrapped in a `cm-lp-wikilink`-styled mark carrying
 *  the resolved target as a `data-target` attribute. */

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { MARK_CLASS } from "./marks";

interface DecoPiece {
  from: number;
  to: number;
  decoration: Decoration;
}

const hideMarker = Decoration.replace({});

/** Node names whose full range must never be scanned for wikilinks - their
 *  content is code, not prose, so a literal `[[...]]` inside them must stay
 *  untouched (verified live: fenced/indented code blocks and inline code
 *  spans all keep raw text as-is - see marks.ts). */
const CODE_NODE_NAMES = new Set(["InlineCode", "FencedCode", "CodeBlock"]);

/** Collects the `[from, to)` ranges covered by code nodes within
 *  `[from, to)`, so wikilink-regex matches starting inside them can be
 *  skipped. */
function codeRanges(state: EditorState, from: number, to: number): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (nodeRef) => {
      if (!CODE_NODE_NAMES.has(nodeRef.name)) return undefined;
      ranges.push({ from: nodeRef.from, to: nodeRef.to });
      return false; // no wikilinks nested inside a code node's own children
    },
  });
  return ranges;
}

function isInsideAny(pos: number, ranges: readonly { from: number; to: number }[]): boolean {
  return ranges.some((range) => pos >= range.from && pos < range.to);
}

/** Matches `[[Target]]` or `[[Target|Alias]]`. Target/alias exclude `[`,
 *  `]` and `|` so adjacent wikilinks on the same line don't merge into one
 *  match. */
const WIKILINK_RE = /\[\[([^[\]|]+?)(?:\|([^[\]]+?))?\]\]/g;

/** Finds wikilinks in `[from, to)` and returns the decoration pieces that
 *  hide their `[[`/`]]` delimiters (and, for an aliased link, the
 *  `Target|` prefix) while marking the visible remainder with
 *  `MARK_CLASS.wikilink` and a `data-target` attribute. Matches starting
 *  inside a code node (`InlineCode`/`FencedCode`/`CodeBlock`) are skipped. */
export function wikilinkDecorations(state: EditorState, from: number, to: number): DecoPiece[] {
  const pieces: DecoPiece[] = [];
  const text = state.doc.sliceString(from, to);
  const excluded = codeRanges(state, from, to);

  for (const match of text.matchAll(WIKILINK_RE)) {
    const matchStart = from + match.index;
    if (isInsideAny(matchStart, excluded)) continue;

    const [full, target, alias] = match;
    const openFrom = matchStart;
    const openTo = openFrom + 2;
    const closeTo = matchStart + full.length;
    const closeFrom = closeTo - 2;

    pieces.push({ from: openFrom, to: openTo, decoration: hideMarker });

    const visibleFrom = alias === undefined ? openTo : closeFrom - alias.length;
    if (alias !== undefined) {
      pieces.push({ from: openTo, to: visibleFrom, decoration: hideMarker });
    }
    pieces.push({
      from: visibleFrom,
      to: closeFrom,
      decoration: Decoration.mark({ class: MARK_CLASS.wikilink, attributes: { "data-target": target } }),
    });

    pieces.push({ from: closeFrom, to: closeTo, decoration: hideMarker });
  }

  return pieces;
}
