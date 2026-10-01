/**
 * The frontmatter block, folded into one line while nobody is editing it.
 *
 * Every note in this vault opens with four or five lines of YAML, and most carry
 * a blockquote header underneath repeating part of it. Measured on a real note:
 * the two together filled the first fifth of the editor before the first
 * sentence of content — administration, set at the size of writing.
 *
 * The rule is the one live preview follows everywhere else: markup on the line
 * you are on, effect everywhere else. The frontmatter was the one block that
 * only ever got the first half. It was dimmed (see `styles.css`) and otherwise
 * left as raw YAML.
 *
 * In a field of its own rather than beside the rest of live preview, for the same
 * reason `tableView` is: a decoration that replaces line breaks cannot come from
 * a view plugin, because it changes what a block is, and CodeMirror requires it
 * to be part of the state. The difference from tables is the second trigger —
 * this one also has to recompute when the selection moves, since that is what
 * decides whether the block is folded at all.
 *
 * The document is never modified. The bytes on disk stay exactly what they were;
 * only the view covers them, which is the same promise live preview makes and
 * the reason v1's rich-text experiment is not being repeated.
 */

import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

import { FrontmatterWidget } from './widgets';

/**
 * Where the YAML block at the top of a note ends, if there is one.
 *
 * Detected by shape rather than by the parser: the Markdown grammar in use has
 * no frontmatter rule, and adding one would change how the whole document
 * tokenises for the sake of two delimiter lines.
 *
 * Three cases it must not claim, each with a test: a note opening with anything
 * other than `---`, a `---` further down the page (which is a horizontal rule),
 * and an opening fence that is never closed — treating the rest of the file as
 * frontmatter would hide everything somebody wrote.
 */
export function frontmatterEnd(state: EditorState): number | null {
  if (state.doc.lines < 2 || state.doc.line(1).text.trim() !== '---') return null;
  for (let n = 2; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (line.text.trim() === '---') return line.to;
  }
  return null;
}

/**
 * What the folded bar shows: the tags, and when the note was last touched.
 *
 * Read by shape, not by a YAML parser. A parser here would be a second opinion
 * about a format the server already reads, and being wrong costs a summary that
 * says less than it could — never a note that breaks, since the document is only
 * covered, never changed.
 */
export function frontmatterSummary(
  state: EditorState,
  end: number,
): { tags: string[]; updated: string; fields: number } {
  const tags: string[] = [];
  let updated = '';
  let fields = 0;
  const last = state.doc.lineAt(end).number;
  for (let n = 2; n < last; n++) {
    const text = state.doc.line(n).text;
    const at = text.indexOf(':');
    if (at <= 0) continue;
    fields += 1;
    const key = text.slice(0, at).trim().toLowerCase();
    const value = text.slice(at + 1).trim();
    if (key === 'tags') {
      // `[a, b]` and `a, b` alike. A block list spread over several lines falls
      // through to the count, which is honest about there being more than shown.
      for (const one of value.replace(/^\[|]$/g, '').split(',')) {
        const tag = one.trim().replace(/^["']|["']$/g, '');
        if (tag !== '') tags.push(tag);
      }
    } else if (key === 'updated') {
      updated = value;
    }
  }
  return { tags, updated, fields };
}

/** Whether any cursor or selection touches the block ending at `end`. */
export function touchesFrontmatter(state: EditorState, end: number): boolean {
  return state.selection.ranges.some((range) => range.from <= end && range.to >= 0);
}

function build(state: EditorState): DecorationSet {
  const end = frontmatterEnd(state);
  if (end === null || touchesFrontmatter(state, end)) return Decoration.none;

  const { tags, updated, fields } = frontmatterSummary(state, end);
  const ranges: Range<Decoration>[] = [
    Decoration.replace({ widget: new FrontmatterWidget(tags, updated, fields), block: true }).range(0, end),
  ];
  return Decoration.set(ranges, true);
}

const folded = StateField.define<DecorationSet>({
  create: build,
  // Both triggers, and the selection is the one tables do not need: moving the
  // cursor into the block is what opens it, and moving out is what closes it
  // again.
  update: (value, transaction) =>
    transaction.docChanged || transaction.selection !== undefined ? build(transaction.state) : value,
  provide: (field) => EditorView.decorations.from(field),
});

export function frontmatter(): Extension {
  return [folded];
}

/**
 * Where a note's content starts, for placing the cursor when one is opened.
 *
 * Without this the caret lands on position 0 — inside the frontmatter — and the
 * block unfolds itself on every single open, which makes the fold above useless
 * in the one case that matters most. It is also just wrong on its own terms:
 * somebody opening a note wants to be in the writing, not in the bookkeeping.
 *
 * Works on the text rather than on a state, because it is wanted while the state
 * is being built.
 */
export function contentStart(doc: string): number {
  const lines = doc.split('\n');
  if (lines.length < 2 || lines[0]?.trim() !== '---') return 0;

  let at = (lines[0]?.length ?? 0) + 1;
  for (let n = 1; n < lines.length; n++) {
    const line = lines[n] ?? '';
    at += line.length + 1;
    if (line.trim() === '---') {
      // Past the closing fence, then past anything that is still not writing:
      // a blank line, and the blockquote header these notes carry. A line with
      // the caret on it shows its markup — that is the live-preview rule — so
      // parking the caret on that header would greet every note with raw
      // asterisks. Shape, not convention: any leading quote is skipped, and a
      // note without one is unaffected.
      let k = n + 1;
      while (k < lines.length) {
        const after = lines[k] ?? '';
        if (after.trim() === '' || after.trimStart().startsWith('>')) {
          at += after.length + 1;
          k += 1;
          continue;
        }
        break;
      }
      return Math.min(at, doc.length);
    }
  }
  // Never closed: the whole file would otherwise count as frontmatter.
  return 0;
}
