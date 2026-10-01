/**
 * The YAML block at the top of a note, and how much of the page it takes.
 *
 * Every note here starts with one, and most of them carry a blockquote header
 * right underneath saying roughly the same thing again. Measured on a real note
 * in the vault: the two together fill the first fifth of the editor before the
 * first sentence of content. That is administration, shown at the size of
 * writing.
 *
 * The rule is the one live preview already follows everywhere else: a line shows
 * its markup when the cursor is on it, and shows its effect when it is not. The
 * frontmatter was the one block that never got the second half — it was tinted
 * and otherwise left as raw YAML.
 *
 * `buildDecorations` was written to be exercised without a browser, and said so
 * in its docstring, and had no test at all before this file. These cover the
 * block this change touches, not the whole rule set.
 */

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import { contentStart, frontmatter, frontmatterEnd, frontmatterSummary } from '../src/editor/frontmatterView';
import { buildDecorations } from '../src/editor/livePreview';

const NOTE = [
  '---',
  'created: 2026-06-06',
  'updated: 2026-09-28',
  'tags: [proxmox, homelab]',
  '---',
  '',
  '# Proxmox Cluster',
  '',
  'Two nodes and a Qdevice.',
].join('\n');

/** A state with the cursor at `at`, over the whole document. */
function stateAt(text: string, at = 0): EditorState {
  return EditorState.create({ doc: text, selection: { anchor: at } });
}

/** Every decoration the builder produced, as `[from, to, spec]`. */
function decorationsOf(state: EditorState) {
  const built = buildDecorations(state, [{ from: 0, to: state.doc.length }]);
  const out: Array<{ from: number; to: number; spec: Record<string, unknown> }> = [];
  built.decorations.between(0, state.doc.length, (from, to, value) => {
    out.push({ from, to, spec: value.spec as Record<string, unknown> });
  });
  return out;
}

describe('the frontmatter block', () => {
  it('is recognised as its own region, not as content', () => {
    // With the cursor inside: that is when the block is shown as itself, tinted
    // line by line. Folded away it is a single widget instead, which the tests
    // below cover.
    const marks = decorationsOf(stateAt(NOTE, NOTE.indexOf('created:') + 2));
    const tinted = marks.filter(
      (m) => typeof m.spec['class'] === 'string' && (m.spec['class'] as string).includes('frontmatter'),
    );
    // Five lines: the two fences and the three fields between them.
    expect(tinted).toHaveLength(5);
  });

  it('does not claim a note that opens with something else', () => {
    const marks = decorationsOf(stateAt('# Just a heading\n\nAnd a line.\n', 3));
    expect(
      marks.filter((m) => typeof m.spec['class'] === 'string' && (m.spec['class'] as string).includes('frontmatter')),
    ).toHaveLength(0);
  });

  it('does not claim a horizontal rule halfway down a note', () => {
    // `---` on line one opens a block; the same three characters later in the
    // document are a rule and must stay one.
    const text = '# Heading\n\nSome text.\n\n---\n\nMore text.\n';
    const marks = decorationsOf(stateAt(text, 2));
    expect(
      marks.filter((m) => typeof m.spec['class'] === 'string' && (m.spec['class'] as string).includes('frontmatter')),
    ).toHaveLength(0);
  });

  it('leaves an unclosed block alone rather than swallowing the note', () => {
    // No second fence: treating the rest of the file as frontmatter would hide
    // everything somebody wrote.
    const text = '---\ncreated: 2026-01-01\n\n# Heading\n\nText.\n';
    const marks = decorationsOf(stateAt(text, text.length - 1));
    expect(
      marks.filter((m) => typeof m.spec['class'] === 'string' && (m.spec['class'] as string).includes('frontmatter')),
    ).toHaveLength(0);
  });
});

/** Whether the fold field put a widget over the top of the document. */
function foldedWith(selection: { anchor: number; head?: number }): boolean {
  const state = EditorState.create({ doc: NOTE, selection, extensions: [frontmatter()] });
  const view = new EditorView({ state });
  try {
    let folded = false;
    view.state.facet(EditorView.decorations).forEach((source) => {
      const set = typeof source === 'function' ? source(view) : source;
      set.between(0, 1, () => {
        folded = true;
      });
    });
    return folded;
  } finally {
    view.destroy();
  }
}

describe('the frontmatter at rest', () => {
  it('is folded away when the cursor is elsewhere', () => {
    // The cursor sits in the body. Nothing of the YAML needs to be on screen:
    // what it says is shown by the summary that takes its place.
    expect(foldedWith({ anchor: NOTE.indexOf('Two nodes') })).toBe(true);
  });

  it('shows itself the moment the cursor is inside it', () => {
    // Same rule as every other line in live preview: on the line, see the
    // markup. Without this the block could not be edited at all.
    expect(foldedWith({ anchor: NOTE.indexOf('created:') + 2 })).toBe(false);
  });

  it('shows itself when the selection merely touches it', () => {
    // Select-all must not leave a widget sitting over text that is selected.
    expect(foldedWith({ anchor: 0, head: NOTE.length })).toBe(false);
  });
});

describe('what the folded bar says', () => {
  it('names the tags and the date somebody looks for', () => {
    const state = stateAt(NOTE);
    const end = frontmatterEnd(state)!;
    const summary = frontmatterSummary(state, end);

    expect(summary.tags).toEqual(['proxmox', 'homelab']);
    expect(summary.updated).toBe('2026-09-28');
    // Three fields: created, updated, tags. The count is what the bar falls back
    // to when there is nothing else to show.
    expect(summary.fields).toBe(3);
  });

  it('reads a bare list as well as a bracketed one', () => {
    const text = '---\ntags: homelab, docker\n---\n\nText.\n';
    const state = stateAt(text);
    expect(frontmatterSummary(state, frontmatterEnd(state)!).tags).toEqual(['homelab', 'docker']);
  });

  it('counts fields it cannot summarise rather than showing an empty bar', () => {
    // No tags and no date: a bar with nothing in it would read as a rendering
    // fault instead of as a note filed under nothing.
    const text = '---\ntype: reference\nsrc: manual\n---\n\nText.\n';
    const state = stateAt(text);
    const summary = frontmatterSummary(state, frontmatterEnd(state)!);
    expect(summary.tags).toEqual([]);
    expect(summary.updated).toBe('');
    expect(summary.fields).toBe(2);
  });
});

/**
 * Where the caret lands when a note opens.
 *
 * This is what makes the fold above mean anything: without it the caret is at
 * position 0, inside the block, and the frontmatter unfolds itself on every
 * open — the fold would have worked everywhere except in the one case anybody
 * would ever see. Found by opening a note and looking, not by a test.
 */
describe('opening a note', () => {
  it('puts the caret in the writing, not in the bookkeeping', () => {
    const at = contentStart(NOTE);
    expect(at).toBeGreaterThan(NOTE.indexOf('tags:'));
    expect(NOTE.slice(at)).toMatch(/^# Proxmox/);
  });

  it('steps over the blockquote header these notes carry', () => {
    // The caret on a line makes that line show its markup, which would greet
    // every note with raw asterisks where the header is.
    const withHeader = [
      '---',
      'tags: [homelab]',
      '---',
      '> **type:** reference · **updated:** 2026-09-28',
      '',
      'The first real sentence.',
    ].join('\n');

    expect(withHeader.slice(contentStart(withHeader))).toMatch(/^The first real sentence/);
  });

  it('stops at the first line that is actually writing', () => {
    // Nothing to step over: the caret must not run past content just because it
    // could.
    const plain = '---\ntags: [x]\n---\n\n# Heading\n\nText.\n';
    expect(plain.slice(contentStart(plain))).toMatch(/^# Heading/);
  });

  it('leaves a note without frontmatter at the very top', () => {
    expect(contentStart('# Heading\n\nText.\n')).toBe(0);
  });

  it('leaves an unclosed block at the top rather than skipping the note', () => {
    expect(contentStart('---\ncreated: 2026-01-01\n\n# Heading\n')).toBe(0);
  });

  it('does not run past the end of a note that is only frontmatter', () => {
    const only = '---\ntags: [x]\n---\n';
    expect(contentStart(only)).toBeLessThanOrEqual(only.length);
  });
});
