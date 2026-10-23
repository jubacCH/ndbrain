/**
 * What came over from AFFiNE: the selection bar's commands, blocks that move
 * as a whole, callouts, folding and embeds.
 *
 * The promise all of it has to keep is the one the editor was rebuilt around —
 * the note stays Markdown that any other editor reads the same way. So most of
 * these tests are about text: what a move, a "turn into" or a highlight leaves
 * in the file. The rest check that drawing something never changes the file,
 * and that things which only look like notation (`$HOME`, a URL inside a
 * sentence) are left alone.
 */

import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree, foldedRanges } from '@codemirror/language';
import { EditorSelection, EditorState, type StateCommand, type TransactionSpec } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { GFM } from '@lezer/markdown';
import { describe, expect, it } from 'vitest';

import { noteExtensions } from '../src/Editor';
import {
  blockAt,
  deleteBlock,
  duplicateBlock,
  moveBlock,
  neighbour,
  turnBlockInto,
} from '../src/editor/blocks';
import {
  AttachmentWidget,
  LinkCardWidget,
  MathWidget,
  NoteEmbedWidget,
  excerpt,
  findBlocks,
  linkTarget,
} from '../src/editor/embeds';
import { initialFolds } from '../src/editor/folding';
import { lineKind, linkNote, setLineKind, toggleWrap } from '../src/editor/format';
import { buildDecorations, calloutFamily } from '../src/editor/livePreview';
import { tables } from '../src/editor/tableView';
import { CalloutLabelWidget, ImageWidget } from '../src/editor/widgets';

/** A state with the grammar and fields the rules read, fully parsed. */
function state(doc: string, cursor = doc.length): EditorState {
  const created = EditorState.create({
    doc,
    selection: EditorSelection.single(Math.min(cursor, doc.length)),
    extensions: [markdown({ extensions: [GFM] }), tables()],
  });
  ensureSyntaxTree(created, created.doc.length, 5_000);
  return created;
}

/** Runs a command and returns the text it leaves. */
function run(command: StateCommand, doc: string, from: number, to = from): string {
  let current = EditorState.create({ doc, selection: EditorSelection.single(from, to) });
  command({ state: current, dispatch: (tr) => (current = tr.state) });
  return current.doc.toString();
}

function apply(start: EditorState, spec: TransactionSpec | null): string {
  if (spec === null) return start.doc.toString();
  return start.update(spec).state.doc.toString();
}

/** Every widget live preview would draw, with the text it stands in for. */
function widgets(s: EditorState): Array<{ widget: WidgetType; text: string }> {
  const out: Array<{ widget: WidgetType; text: string }> = [];
  const { decorations } = buildDecorations(s, [{ from: 0, to: s.doc.length }]);
  decorations.between(0, s.doc.length, (from, to, value: Decoration) => {
    const widget = value.spec.widget as WidgetType | undefined;
    if (widget !== undefined) out.push({ widget, text: s.sliceDoc(from, to) });
  });
  return out;
}

function lineClasses(s: EditorState): string[] {
  const out: string[] = [];
  const { decorations } = buildDecorations(s, [{ from: 0, to: s.doc.length }]);
  decorations.between(0, s.doc.length, (from, _to, value: Decoration) => {
    const cls = (value.spec as { class?: string }).class;
    if (cls !== undefined && value.spec.widget === undefined && from === s.doc.lineAt(from).from) {
      out.push(`${s.doc.lineAt(from).number}:${cls}`);
    }
  });
  return out;
}

describe('the selection bar’s commands', () => {
  it('highlights and strikes through as toggles', () => {
    expect(run(toggleWrap('=='), 'ein Wort hier', 4, 8)).toBe('ein ==Wort== hier');
    expect(run(toggleWrap('=='), 'ein ==Wort== hier', 6, 10)).toBe('ein Wort hier');
    expect(run(toggleWrap('~~'), 'alt', 0, 3)).toBe('~~alt~~');
  });

  it('links the selected words to a note, and unlinks them again', () => {
    expect(run(linkNote, 'siehe Proxmox Cluster', 6, 21)).toBe('siehe [[Proxmox Cluster]]');
    expect(run(linkNote, 'siehe [[Proxmox Cluster]]', 8, 23)).toBe('siehe Proxmox Cluster');
  });

  it('refuses to link across a line break', () => {
    expect(run(linkNote, 'eins\nzwei', 0, 9)).toBe('eins\nzwei');
  });

  it('turns lines into another kind, keeping indentation and words', () => {
    expect(run(setLineKind('task'), '  - Backup prüfen', 4)).toBe('  - [ ] Backup prüfen');
    expect(run(setLineKind('h2'), '- [x] erledigt', 3)).toBe('## erledigt');
    expect(run(setLineKind('quote'), 'eins\nzwei', 0, 9)).toBe('> eins\n> zwei');
    expect(run(setLineKind('callout'), 'Achtung', 0)).toBe('> [!note] Achtung');
  });

  it('turns a line back into text when it already is that kind', () => {
    expect(run(setLineKind('h1'), '# Titel', 3)).toBe('Titel');
    // …but not when asked not to toggle, which is what the block menu does.
    expect(run(setLineKind('h1', undefined, false), '# Titel', 3)).toBe('# Titel');
  });

  it('reads the kind a line already is', () => {
    expect(lineKind('### drei')).toBe('h3');
    expect(lineKind('- [ ] offen')).toBe('task');
    expect(lineKind('* Punkt')).toBe('bullet');
    expect(lineKind('12. zwölf')).toBe('numbered');
    expect(lineKind('> [!tip]- Hinweis')).toBe('callout');
    expect(lineKind('> zitiert')).toBe('quote');
    expect(lineKind('einfach')).toBe('paragraph');
  });
});

describe('blocks', () => {
  const doc = [
    'Erster Absatz,',
    'über zwei Zeilen.',
    '',
    '- eins',
    '  - eins.a',
    '- zwei',
    '',
    '## Abschnitt',
    '',
    'Letzter Absatz.',
  ].join('\n');

  it('takes a whole paragraph, not one line of it', () => {
    const s = state(doc);
    const block = blockAt(s, s.doc.line(2).from)!;
    expect(s.sliceDoc(block.from, block.to)).toBe('Erster Absatz,\nüber zwei Zeilen.');
    expect(block.item).toBe(false);
  });

  it('takes a list item together with its children', () => {
    const s = state(doc);
    const block = blockAt(s, s.doc.line(4).from)!;
    expect(s.sliceDoc(block.from, block.to)).toBe('- eins\n  - eins.a');
    expect(block.item).toBe(true);
  });

  it('lets a child item go on its own', () => {
    const s = state(doc);
    const block = blockAt(s, s.doc.line(5).from)!;
    expect(s.sliceDoc(block.from, block.to)).toBe('  - eins.a');
  });

  it('has no block on a blank line or in the frontmatter', () => {
    const s = state('---\ntype: x\n---\n\nText');
    expect(blockAt(s, s.doc.line(2).from)).toBeNull();
    expect(blockAt(s, s.doc.line(4).from)).toBeNull();
    expect(blockAt(s, s.doc.line(5).from)).not.toBeNull();
  });

  it('moves a paragraph to the end and keeps paragraphs apart', () => {
    const s = state(doc);
    const first = blockAt(s, 0)!;
    const last = blockAt(s, s.doc.line(10).from)!;
    expect(apply(s, moveBlock(s, first, last, 'after'))).toBe(
      ['- eins', '  - eins.a', '- zwei', '', '## Abschnitt', '', 'Letzter Absatz.', '', 'Erster Absatz,', 'über zwei Zeilen.'].join('\n'),
    );
  });

  it('moves a list item within its list without blank lines', () => {
    const s = state(doc);
    const zwei = blockAt(s, s.doc.line(6).from)!;
    const eins = blockAt(s, s.doc.line(4).from)!;
    const moved = apply(s, moveBlock(s, zwei, eins, 'before'));
    expect(moved).toContain('- zwei\n- eins\n  - eins.a\n\n## Abschnitt');
  });

  it('does nothing when a block is dropped where it already is', () => {
    const s = state(doc);
    const eins = blockAt(s, s.doc.line(4).from)!;
    const zwei = blockAt(s, s.doc.line(6).from)!;
    expect(moveBlock(s, eins, eins, 'after')).toBeNull();
    expect(moveBlock(s, eins, zwei, 'before')).toBeNull();
  });

  it('finds the sibling above a list item, not the child of the one before', () => {
    const s = state(doc);
    const zwei = blockAt(s, s.doc.line(6).from)!;
    const above = neighbour(s, zwei, -1)!;
    expect(s.sliceDoc(above.from, above.to)).toBe('- eins\n  - eins.a');
  });

  it('duplicates and deletes without leaving a stack of blank lines', () => {
    const s = state(doc);
    const heading = blockAt(s, s.doc.line(8).from)!;
    expect(apply(s, duplicateBlock(s, heading))).toContain('## Abschnitt\n\n## Abschnitt\n\nLetzter');
    expect(apply(s, deleteBlock(s, heading))).toBe(
      ['Erster Absatz,', 'über zwei Zeilen.', '', '- eins', '  - eins.a', '- zwei', '', 'Letzter Absatz.'].join('\n'),
    );
  });

  it('deletes the last block together with the gap in front of it', () => {
    const s = state(doc);
    const last = blockAt(s, s.doc.line(10).from)!;
    expect(apply(s, deleteBlock(s, last)).endsWith('## Abschnitt')).toBe(true);
  });

  it('turns a whole paragraph into a quote and back', () => {
    const s = state(doc);
    const first = blockAt(s, 0)!;
    const quoted = apply(s, turnBlockInto(s, first, 'quote'));
    expect(quoted.startsWith('> Erster Absatz,\n> über zwei Zeilen.\n')).toBe(true);

    const q = state(quoted);
    const back = apply(q, turnBlockInto(q, blockAt(q, 0)!, 'paragraph'));
    expect(back).toBe(doc);
  });

  it('turns a paragraph into a callout with every line quoted', () => {
    const s = state(doc);
    const out = apply(s, turnBlockInto(s, blockAt(s, 0)!, 'callout'));
    expect(out.startsWith('> [!note] Erster Absatz,\n> über zwei Zeilen.')).toBe(true);
  });
});

describe('callouts', () => {
  it('draws a callout with its label while the cursor is elsewhere', () => {
    const s = state('> [!warning] Strom aus\n> erst USV prüfen\n\nText', 999);
    const drawn = widgets(s);
    const label = drawn.find((d) => d.widget instanceof CalloutLabelWidget);
    expect(label?.text).toBe('[!warning] ');
    expect((label?.widget as CalloutLabelWidget).kind).toBe('warning');
    expect(lineClasses(s)).toEqual(expect.arrayContaining(['1:cm-callout', '1:cm-callout-head', '2:cm-callout']));
  });

  it('shows the notation on the line the cursor is on', () => {
    const s = state('> [!tip] Hinweis\n> Text', 3);
    expect(widgets(s).some((d) => d.widget instanceof CalloutLabelWidget)).toBe(false);
  });

  it('knows Obsidian’s aliases and treats unknown types as notes', () => {
    expect(calloutFamily('caution')).toBe('warning');
    expect(calloutFamily('BUG')).toBe('danger');
    expect(calloutFamily('rezept')).toBe('note');
  });

  it('opens folded when the author wrote a minus', () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: 'Oben\n\n> [!note]- Details\n> eins\n> zwei\n\n> [!note]+ Offen\n> drei',
        extensions: noteExtensions({ owner: 'julian', path: 'Notiz.md' }),
      }),
      parent: document.body,
    });
    const effects = initialFolds(view.state);
    expect(effects).toHaveLength(1);
    view.dispatch({ effects });

    const folded: Array<[number, number]> = [];
    foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
      folded.push([from, to]);
    });
    expect(folded).toHaveLength(1);
    expect(view.state.sliceDoc(folded[0]![0], folded[0]![1])).toBe('\n> eins\n> zwei');
    // Folding is the view's business: the file did not change.
    expect(view.state.doc.toString()).toContain('[!note]- Details');
    view.destroy();
  });
});

describe('inline notation', () => {
  it('hides the markers of a highlight but keeps the words', () => {
    const s = state('ein ==wichtiger== Satz\n', 999);
    const { decorations } = buildDecorations(s, [{ from: 0, to: s.doc.length }]);
    const marks: string[] = [];
    decorations.between(0, s.doc.length, (from, to, value) => {
      if ((value.spec as { class?: string }).class === 'cm-highlight') marks.push(s.sliceDoc(from, to));
    });
    expect(marks).toEqual(['wichtiger']);
  });

  it('typesets a formula', () => {
    const s = state('Fläche $a^2 + b^2$ hier\n', 999);
    const math = widgets(s).filter((d) => d.widget instanceof MathWidget);
    expect(math.map((d) => d.text)).toEqual(['$a^2 + b^2$']);
  });

  it('leaves shell variables and prices alone', () => {
    for (const text of ['echo $HOME and $PATH', 'zwischen $5 und $10', 'Kosten: 5$ bis 10$', '`$x$` im Code']) {
      const s = state(`${text}\n`, 999);
      expect(widgets(s).filter((d) => d.widget instanceof MathWidget), text).toEqual([]);
    }
  });

  it('tells pictures, notes and attachments apart in an embed', () => {
    const s = state('![[rack.png]]\n\n![[Proxmox Cluster]]\n\n![[Handbuch.pdf]]\n\n![[Alt.md#Teil]]\n', 999);
    const kinds = widgets(s).map((d) => d.widget.constructor.name);
    expect(kinds).toEqual([ImageWidget.name, NoteEmbedWidget.name, AttachmentWidget.name, NoteEmbedWidget.name]);
  });

  it('makes a card of a URL alone in its paragraph only', () => {
    const alone = state('Text\n\nhttps://example.org/seite\n\nmehr', 0);
    expect(widgets(alone).filter((d) => d.widget instanceof LinkCardWidget)).toHaveLength(1);

    const inList = state('- https://example.org\n- https://example.com', 999);
    expect(widgets(inList).filter((d) => d.widget instanceof LinkCardWidget)).toHaveLength(0);

    const inSentence = state('siehe https://example.org dort', 999);
    expect(widgets(inSentence).filter((d) => d.widget instanceof LinkCardWidget)).toHaveLength(0);
  });
});

describe('block embeds', () => {
  it('finds mermaid fences and display math, and nothing inside other fences', () => {
    const doc = [
      '```mermaid',
      'graph LR; A-->B',
      '```',
      '',
      '$$',
      'E = mc^2',
      '$$',
      '',
      '```bash',
      'echo "$$"',
      '$$',
      '```',
      '',
      '$$ \\int_0^1 x\\,dx $$',
    ].join('\n');
    const blocks = findBlocks(state(doc, 0));
    expect(blocks.map((b) => b.widget.constructor.name)).toEqual(['DiagramWidget', 'MathWidget', 'MathWidget']);
    expect((blocks[1]!.widget as MathWidget).tex).toBe('E = mc^2');
  });

  it('leaves an unclosed mermaid fence as text', () => {
    expect(findBlocks(state('```mermaid\ngraph LR; A-->B\n', 0))).toEqual([]);
  });
});

describe('excerpts and link targets', () => {
  it('drops the frontmatter and cuts to the section asked for', () => {
    const content = '---\ntype: x\n---\n\n# Titel\n\nIntro\n\n## Backup\n\nvzdump täglich\n\n## Netz\n\nVLAN 30';
    expect(excerpt(content, null)[0]).toBe('# Titel');
    expect(excerpt(content, 'backup')).toEqual(['vzdump täglich']);
    // The card already shows the title; the note's own H1 is not repeated.
    expect(excerpt(content, null, 14, 'Titel')[0]).toBe('Intro');
  });

  it('splits a target from its heading and label', () => {
    expect(linkTarget('Proxmox#Backup|hier')).toEqual({ note: 'Proxmox', heading: 'Backup' });
    expect(linkTarget('Proxmox')).toEqual({ note: 'Proxmox', heading: null });
  });
});

describe('the whole stack', () => {
  it('opens a note with every new kind of block without changing a byte', () => {
    const doc = [
      '---',
      'type: reference',
      '---',
      '# Titel',
      '',
      '> [!warning]- Achtung',
      '> Strom',
      '',
      'ein ==Satz== mit $x^2$ und [[Link]]',
      '',
      '![[Andere Notiz]]',
      '',
      'https://example.org',
      '',
      '```mermaid',
      'graph LR; A-->B',
      '```',
      '',
      '$$',
      'a = b',
      '$$',
      '',
    ].join('\n');
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: noteExtensions({ owner: 'julian', path: 'Notiz.md' }) }),
      parent: document.body,
    });
    view.dispatch({ effects: initialFolds(view.state) });
    expect(view.state.doc.toString()).toBe(doc);
    view.destroy();
  });
});
