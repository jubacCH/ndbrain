/**
 * Live preview: Markdown that shows its effect instead of its notation, until
 * you put the cursor on the line.
 *
 * This is emphatically *not* the rich-text editor v1 tried and rejected. That
 * experiment failed because the document model itself became rich text, so
 * every save round-tripped through a converter and came back with escaped
 * wikilinks and reordered frontmatter. Here the document is never touched: it
 * stays the exact bytes that are on disk, and only the *view* decorates them.
 * A converter that does not exist cannot corrupt anything.
 *
 * Reveal is per line, not per element. Obsidian reveals per element, which is
 * marginally more elegant and considerably harder to predict — with a line rule
 * the writer learns it once ("my line shows its markup") and is never surprised
 * by markers three words away blinking on.
 */

import { syntaxTree } from '@codemirror/language';
import { Facet } from '@codemirror/state';
import type { EditorState, Extension, Range } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';

import { BulletWidget, CheckboxWidget, ImageWidget, RuleWidget } from './widgets';

/** Syntactic markers that simply vanish while the line is at rest. */
const PLAIN_MARKS = new Set(['EmphasisMark', 'StrikethroughMark', 'LinkMark', 'CodeMark']);

const CODE_NODES = new Set(['InlineCode', 'FencedCode', 'CodeBlock']);

const HIDDEN = Decoration.replace({});

const LINE_DECORATIONS = {
  code: Decoration.line({ class: 'cm-block-code' }),
  quote: Decoration.line({ class: 'cm-block-quote' }),
  table: Decoration.line({ class: 'cm-block-table' }),
  frontmatter: Decoration.line({ class: 'cm-block-frontmatter' }),
};

const MARK_DECORATIONS = {
  inlineCode: Decoration.mark({ class: 'cm-inline-code' }),
  wikilink: Decoration.mark({ class: 'cm-wikilink' }),
  tableDelimiter: Decoration.mark({ class: 'cm-table-delimiter' }),
  tableHeader: Decoration.mark({ class: 'cm-table-header' }),
};

/** `[[Target]]`, `[[Target|Label]]` and the `![[…]]` embed form. */
const WIKILINK = /(!?)\[\[([^\]\n]+)]]/g;

/** Extensions an embed will actually be shown for. */
const EMBEDDABLE = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Where the open note lives, so an embed can be turned into a URL.
 *
 * A facet rather than a closure argument because the plugin outlives any one
 * note: reconfiguring this is how the editor tells it that a different note is
 * open, without rebuilding the whole extension stack.
 */
export const embedContext = Facet.define<{ owner: string; dir: string }, { owner: string; dir: string }>({
  combine: (values: ReadonlyArray<{ owner: string; dir: string }>) =>
    values[0] ?? { owner: '', dir: '' },
});

/**
 * The URL an embedded attachment is served from.
 *
 * Resolved against the note's own folder. A bare `![[rack.png]]` therefore means
 * "the file beside this note", which is what the paste handler writes and what
 * somebody typing the name expects — and it needs no index lookup to resolve.
 */
function embedUrl(context: { owner: string; dir: string }, name: string): string {
  const path = context.dir === '' ? name : `${context.dir}/${name}`;
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `/api/v1/files/${encoded}?owner=${encodeURIComponent(context.owner)}`;
}

/** `![alt](url)` — parsed from the node's own text rather than its children. */
const IMAGE = /^!\[([^\]]*)]\(\s*(\S+?)\s*(?:"[^"]*")?\)$/;

/** A task item's `[ ]`, seen from just after the list marker. */
const TASK_AHEAD = /^\s*\[[ xX]]/;

/** Line numbers touched by any cursor or selection. */
function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) lines.add(n);
  }
  return lines;
}

/**
 * The YAML block at the top of a note, if there is one.
 *
 * Detected by shape rather than by the parser: the Markdown grammar in use has
 * no frontmatter rule, and adding one to the parser would change how the whole
 * document tokenises for the sake of two delimiter lines.
 */
function frontmatterEnd(state: EditorState): number | null {
  if (state.doc.lines < 2 || state.doc.line(1).text.trim() !== '---') return null;
  for (let n = 2; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (line.text.trim() === '---') return line.to;
  }
  return null;
}

function within(spans: ReadonlyArray<readonly [number, number]>, pos: number): boolean {
  return spans.some(([from, to]) => pos >= from && pos < to);
}

export interface Built {
  decorations: DecorationSet;
  /** Only the replaced ranges — what the cursor should step over, not into. */
  atomic: DecorationSet;
}

/**
 * Takes a state and the ranges worth looking at, rather than a view, so that
 * the whole rule set can be exercised without a browser. Widgets are only
 * constructed here; they do not touch the DOM until they are drawn.
 *
 * Three passes, and the order between them is the whole trick:
 *
 *  1. find the code spans, because `[[` inside a fence is not a link;
 *  2. find the wikilinks textually, because the grammar has no rule for them;
 *  3. decorate everything else, deferring wherever a wikilink already claimed
 *     the text.
 *
 * Without step three the parser and this file fight over the same brackets —
 * `[[Target]]` contains something the CommonMark grammar reads as a link label,
 * so both would hide the closing bracket and only one of them would win.
 */
export function buildDecorations(
  state: EditorState,
  ranges: readonly { readonly from: number; readonly to: number }[],
): Built {
  const active = activeLines(state);
  const all: Range<Decoration>[] = [];
  const hidden: Range<Decoration>[] = [];
  const code: Array<[number, number]> = [];
  const wikilinks: Array<[number, number]> = [];

  const isActive = (pos: number): boolean => active.has(state.doc.lineAt(pos).number);

  const hide = (from: number, to: number): void => {
    if (to <= from) return;
    all.push(HIDDEN.range(from, to));
    hidden.push(HIDDEN.range(from, to));
  };

  /** Hides a marker together with the single space that follows it, if any. */
  const hideWithSpace = (from: number, to: number): void => {
    hide(from, state.doc.sliceString(to, to + 1) === ' ' ? to + 1 : to);
  };

  const replace = (from: number, to: number, decoration: Decoration): void => {
    if (to <= from) return;
    all.push(decoration.range(from, to));
    hidden.push(decoration.range(from, to));
  };

  const decorateLines = (from: number, to: number, decoration: Decoration): void => {
    let n = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(Math.min(to, state.doc.length)).number;
    for (; n <= last; n++) {
      all.push(decoration.range(state.doc.line(n).from));
    }
  };

  // --- pass 1: where code lives ------------------------------------------
  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (CODE_NODES.has(node.name)) code.push([node.from, node.to]);
      },
    });
  }

  // --- pass 2: wikilinks --------------------------------------------------
  for (const { from, to } of ranges) {
    const firstLine = state.doc.lineAt(from).number;
    const lastLine = state.doc.lineAt(to).number;

    for (let n = firstLine; n <= lastLine; n++) {
      const line = state.doc.line(n);
      if (!line.text.includes('[[')) continue;

      WIKILINK.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = WIKILINK.exec(line.text)) !== null) {
        const start = line.from + match.index;
        if (within(code, start)) continue;

        const bang = match[1] ?? '';
        const inner = match[2] ?? '';
        const openFrom = start + bang.length;
        const innerFrom = openFrom + 2;
        const innerTo = innerFrom + inner.length;

        // Claimed either way, so that pass three keeps its hands off.
        wikilinks.push([start, innerTo + 2]);

        // An embed of a picture becomes the picture. Anything else is left
        // exactly as typed: hiding half the punctuation of something that is not
        // going to be rendered makes it read as a typo.
        if (bang !== '') {
          const target = inner.split('|')[0]?.trim() ?? '';
          // Same rule the rest of the file uses: notation gives way only while
          // the cursor is elsewhere, so an embed you are editing stays text.
          if (!isActive(start) && EMBEDDABLE.test(target)) {
            const context = state.facet(embedContext);
            replace(
              start,
              innerTo + 2,
              Decoration.replace({ widget: new ImageWidget(embedUrl(context, target), target) }),
            );
          }
          continue;
        }

        // `[[Target|Label]]` shows the label; the target is addressing.
        const pipe = inner.indexOf('|');
        const labelFrom = pipe === -1 ? innerFrom : innerFrom + pipe + 1;

        // A mark decoration may not be empty, and `[[Target|]]` is something a
        // person types on the way to writing the label.
        if (labelFrom < innerTo) all.push(MARK_DECORATIONS.wikilink.range(labelFrom, innerTo));

        if (!active.has(n)) {
          hide(openFrom, innerFrom);
          if (pipe !== -1) hide(innerFrom, labelFrom);
          hide(innerTo, innerTo + 2);
        }
      }
    }
  }

  // --- pass 3: everything the grammar knows about -------------------------
  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const parent = node.node.parent?.name ?? '';
        const rest = !isActive(node.from);

        switch (name) {
          case 'InlineCode':
            all.push(MARK_DECORATIONS.inlineCode.range(node.from, node.to));
            return;

          case 'FencedCode':
          case 'CodeBlock':
            decorateLines(node.from, node.to, LINE_DECORATIONS.code);
            return;

          case 'Blockquote':
            decorateLines(node.from, node.to, LINE_DECORATIONS.quote);
            return;

          case 'Table':
            decorateLines(node.from, node.to, LINE_DECORATIONS.table);
            return;

          case 'TableDelimiter':
            all.push(MARK_DECORATIONS.tableDelimiter.range(node.from, node.to));
            return;

          case 'TableHeader':
            all.push(MARK_DECORATIONS.tableHeader.range(node.from, node.to));
            return;

          case 'HeaderMark':
            // Only ATX headings. A Setext underline is a line of its own, and
            // hiding it would leave a blank one behind.
            if (rest && parent.startsWith('ATXHeading')) hideWithSpace(node.from, node.to);
            return;

          case 'QuoteMark':
            // The space after `>` belongs to the marker, not to the sentence;
            // leaving it behind indents every quoted line by one column.
            if (rest) hideWithSpace(node.from, node.to);
            return;

          case 'ListMark': {
            if (!rest || parent !== 'ListItem') return;

            // A task line gets a checkbox a moment from now. A bullet beside it
            // is one marker too many, so the whole list marker goes.
            if (TASK_AHEAD.test(state.doc.sliceString(node.to, node.to + 5))) {
              hideWithSpace(node.from, node.to);
              return;
            }

            // Ordered lists keep their numbers: those are content.
            if (node.node.parent?.parent?.name === 'BulletList') {
              replace(node.from, node.to, Decoration.replace({ widget: new BulletWidget() }));
            }
            return;
          }

          case 'TaskMarker': {
            // Always a real checkbox, cursor or not: this is the one control
            // people reach for with the mouse, and it would be useless if it
            // turned back into text the moment it was clicked.
            const checked = /[xX]/.test(state.doc.sliceString(node.from, node.to));
            replace(
              node.from,
              node.to,
              Decoration.replace({ widget: new CheckboxWidget(checked, node.from, node.to) }),
            );
            return;
          }

          case 'HorizontalRule':
            if (rest) replace(node.from, node.to, Decoration.replace({ widget: new RuleWidget() }));
            return false;

          case 'Image': {
            const match = IMAGE.exec(state.doc.sliceString(node.from, node.to));
            const url = match?.[2] ?? '';
            if (rest && /^https?:\/\//.test(url)) {
              replace(
                node.from,
                node.to,
                Decoration.replace({ widget: new ImageWidget(url, match?.[1] ?? '') }),
              );
            }
            // Either way the children stay untouched: half-hidden image syntax
            // reads as a typo rather than as an image that cannot be shown.
            return false;
          }

          case 'URL':
          case 'LinkTitle':
            // Inside a link the address is plumbing; inside an autolink it is
            // the entire content.
            if (rest && parent === 'Link') hide(node.from, node.to);
            return;

          default:
            if (rest && PLAIN_MARKS.has(name)) {
              // The fences of a code block stay visible. The block already has
              // a background to mark its extent, and collapsing the fences
              // leaves two empty banded lines that look like a rendering fault.
              if (name === 'CodeMark' && parent === 'FencedCode') return;
              // A wikilink's brackets are already accounted for.
              if (within(wikilinks, node.from)) return;
              hide(node.from, node.to);
            }
            return;
        }
      },
    });
  }

  // --- frontmatter --------------------------------------------------------
  const fmEnd = frontmatterEnd(state);
  if (fmEnd !== null) decorateLines(0, fmEnd, LINE_DECORATIONS.frontmatter);

  return {
    decorations: Decoration.set(all, true),
    atomic: Decoration.set(hidden, true),
  };
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    atomic: DecorationSet;

    constructor(view: EditorView) {
      ({ decorations: this.decorations, atomic: this.atomic } = buildDecorations(
        view.state,
        view.visibleRanges,
      ));
    }

    update(update: ViewUpdate): void {
      // Selection counts: moving the cursor onto a line is what reveals it.
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        ({ decorations: this.decorations, atomic: this.atomic } = buildDecorations(
          update.view.state,
          update.view.visibleRanges,
        ));
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    // Arrow keys step over hidden markup instead of landing in the middle of a
    // `**` that is not on screen. Only the replaced ranges are listed here —
    // handing over every decoration would make whole headings unenterable.
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
  },
);

export function livePreview(): Extension {
  return livePreviewPlugin;
}
