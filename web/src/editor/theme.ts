/**
 * How Markdown looks while it is being written.
 *
 * A conventional syntax theme breaks this project's one visual rule on the very
 * first line: it paints headings blue and strings green for decoration. Once
 * everything carries colour, the four colours that mean something — orphaned,
 * stale, agent, fine — stop being audible. So structure here is carried by
 * size, weight and contrast, and the palette stays neutral.
 *
 * The markers themselves (`#`, `**`, backticks) recede to the faintest text
 * colour rather than disappearing from the theme, because live preview only
 * reveals them when the cursor is on the line. At that moment they are
 * scaffolding the writer is standing on, not content they are reading.
 */

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/**
 * Headings step down in size but never below body text, and never past the
 * point where two adjacent levels are indistinguishable. Six visibly different
 * sizes would make an h5 look like a mistake; the last two lean on weight.
 */
const markdownHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.5em', fontWeight: '650', lineHeight: '1.35' },
  { tag: t.heading2, fontSize: '1.3em', fontWeight: '650', lineHeight: '1.35' },
  { tag: t.heading3, fontSize: '1.15em', fontWeight: '650' },
  { tag: t.heading4, fontSize: '1.05em', fontWeight: '650' },
  { tag: t.heading5, fontSize: '1em', fontWeight: '650' },
  { tag: t.heading6, fontSize: '1em', fontWeight: '650', color: 'var(--text-2)' },

  { tag: t.strong, fontWeight: '680' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-3)' },

  // Code keeps the monospace face it earns; the chip behind it comes from CSS,
  // because a background on a highlight style does not survive line wrapping.
  { tag: t.monospace, fontFamily: 'var(--mono)', fontSize: '0.92em' },
  { tag: t.labelName, fontFamily: 'var(--mono)', fontSize: '0.92em', color: 'var(--text-3)' },

  { tag: t.link, textDecoration: 'underline', textUnderlineOffset: '2px' },
  { tag: t.url, color: 'var(--text-3)' },
  { tag: t.quote, color: 'var(--text-2)' },
  { tag: t.list, color: 'var(--text-2)' },

  // Every syntactic marker in one rule: hashes, asterisks, backticks, quote
  // arrows, list bullets, link brackets.
  { tag: t.processingInstruction, color: 'var(--text-3)', fontWeight: '400' },

  { tag: t.contentSeparator, color: 'var(--text-3)' },
  { tag: t.escape, color: 'var(--text-3)' },
  { tag: t.comment, color: 'var(--text-3)', fontStyle: 'italic' },
]);

/**
 * The completion menu, which has to be styled from here rather than from
 * `styles.css`.
 *
 * CodeMirror ships a base theme that it injects at runtime, after the app's
 * stylesheet has already been applied. At equal specificity the later rule
 * wins, so the menu kept the library's blue selection no matter what the
 * stylesheet said — visibly wrong in an interface where blue means something.
 * A theme, unlike a stylesheet, is guaranteed to outrank the base theme.
 */
const completionTheme = EditorView.theme({
  '.cm-tooltip.cm-tooltip-autocomplete': {
    border: '1px solid var(--line-2)',
    borderRadius: '6px',
    background: 'var(--surface)',
    boxShadow: '0 1px 2px rgb(0 0 0 / 12%), 0 12px 28px -12px rgb(0 0 0 / 40%)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font)',
    fontSize: '0.85rem',
    maxHeight: '16rem',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    padding: '0.3rem 0.6rem',
    color: 'var(--text-2)',
    display: 'flex',
    gap: '0.6rem',
    alignItems: 'baseline',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    background: 'var(--surface-3)',
    color: 'var(--text)',
  },
  '.cm-completionDetail': {
    marginLeft: 'auto',
    fontFamily: 'var(--mono)',
    fontSize: '0.72rem',
    color: 'var(--text-3)',
    fontStyle: 'normal',
  },
});

/**
 * Everything else that is plain CSS — the prose font, the measure, the blocks
 * and widgets — lives in `styles.css` alongside the rest of the interface, so
 * the design tokens keep one home.
 */
export function markdownTheme(): Extension {
  return [syntaxHighlighting(markdownHighlight), completionTheme];
}
