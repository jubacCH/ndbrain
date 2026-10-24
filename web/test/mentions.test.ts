/**
 * `@` mentions: what the menu offers, what it writes, and how a mention is drawn.
 *
 * The file is the measure here as everywhere: a mention is written as an
 * ordinary Markdown link that reads as `@Name` outside ndBrain, and the account
 * id it points at is what keeps it pointing at the same person after a rename.
 */

import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import { noteExtensions } from '../src/Editor';
import { MENTION, mentionLink, mentionName, mentionSource, unescapeLinkText, type Person } from '../src/editor/mentions';

const PEOPLE: Person[] = [
  { id: 'acc_carlo', name: 'Carlo Muster' },
  { id: 'acc_julian', name: 'Julian Bach', self: true },
];

function state(doc: string, people: readonly Person[] = PEOPLE): EditorState {
  return EditorState.create({
    doc,
    extensions: noteExtensions({ owner: 'julian', path: 'x.md', people: () => people }),
  });
}

/** Asks the `@` source at a position, the way the menu does on typing. */
function ask(doc: string, pos = doc.length, people: readonly Person[] = PEOPLE): CompletionResult | null {
  return mentionSource(new CompletionContext(state(doc, people), pos, false));
}

describe('what @ offers', () => {
  it('opens at the start of a line and after a space, replacing from the @', () => {
    expect(ask('@')?.from).toBe(0);
    const result = ask('Bitte @Ca');
    expect(result?.from).toBe(6);
    expect(result?.options.map((option) => option.label)).toEqual(['@Carlo Muster', '@Julian Bach']);
  });

  it('marks the writer and puts them after everybody else', () => {
    const self = ask('@')?.options.find((option) => option.label === '@Julian Bach');
    expect(self?.detail).toBe('you');
    expect(self?.boost).toBeLessThan(0);
  });

  it('stays shut inside a word, so an e-mail address is left alone', () => {
    expect(ask('julian@exam')).toBeNull();
  });

  it('stays shut in code, where an @ is a character', () => {
    expect(ask('Ein `@')).toBeNull();
    expect(ask('```\n@')).toBeNull();
  });

  it('stays shut when there is nobody to mention', () => {
    expect(ask('@', 1, [])).toBeNull();
  });

  it('writes a link to the account, named as the person is called', () => {
    const option = ask('@')?.options[0];
    expect(option?.apply).toBe('[@Carlo Muster](ndbrain:user/acc_carlo) ');
  });
});

describe('the mention in the file', () => {
  it('escapes brackets in a name, and reads back to the same name', () => {
    const link = mentionLink({ id: 'acc_x', name: 'Team [Ops]' });
    expect(link).toBe('[@Team \\[Ops\\]](ndbrain:user/acc_x)');

    const match = MENTION.exec(link);
    expect(match?.[2]).toBe('acc_x');
    expect(unescapeLinkText(match?.[1] ?? '')).toBe('Team [Ops]');
  });

  it('is not mistaken for an ordinary link, or the other way round', () => {
    expect(MENTION.test('[@Carlo](https://example.com)')).toBe(false);
    expect(MENTION.test('[Carlo](ndbrain:user/acc_carlo)')).toBe(false);
  });

  it('shows the name a person goes by now, and the written one for a stranger', () => {
    expect(mentionName(PEOPLE, 'acc_carlo', 'Carlo')).toBe('Carlo Muster');
    expect(mentionName(PEOPLE, 'acc_gone', 'Alte \\[Name\\]')).toBe('Alte [Name]');
  });
});

describe('a mention in the editor', () => {
  const NOTE = 'Bitte [@Carlo](ndbrain:user/acc_carlo) und [@Jemand](ndbrain:user/acc_gone) fragen.\n\nZweite Zeile';

  function open(doc: string, cursor: number): EditorView {
    return new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(cursor),
        extensions: noteExtensions({ owner: 'julian', path: 'x.md', people: () => PEOPLE }),
      }),
      parent: document.body,
    });
  }

  it('is a chip with the current name while the cursor is elsewhere', () => {
    const view = open(NOTE, NOTE.length);
    const chips = [...view.dom.querySelectorAll('.cm-mention')];

    expect(chips.map((chip) => chip.textContent)).toEqual(['@Carlo Muster', '@Jemand']);
    expect(chips[1]?.classList.contains('is-unknown')).toBe(true);
    // Drawn, not changed: the file still says what was written.
    expect(view.state.doc.toString()).toBe(NOTE);
    view.destroy();
  });

  it('shows the link itself on the line being written', () => {
    const view = open(NOTE, 2);
    expect(view.dom.querySelectorAll('.cm-mention')).toHaveLength(0);
    expect(view.contentDOM.textContent).toContain('ndbrain:user/acc_carlo');
    view.destroy();
  });

  it('leaves an ordinary link an ordinary link', () => {
    const doc = 'Siehe [@Doku](https://example.com).\n\nZweite';
    const view = open(doc, doc.length);
    expect(view.dom.querySelectorAll('.cm-mention')).toHaveLength(0);
    view.destroy();
  });
});
