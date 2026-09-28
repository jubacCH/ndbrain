import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { applyTextChange, threeWay } from '../src/collab/merge.js';

function textOf(initial: string): { doc: Y.Doc; text: Y.Text } {
  const doc = new Y.Doc();
  const text = doc.getText('content');
  text.insert(0, initial);
  return { doc, text };
}

describe('applyTextChange', () => {
  it.each([
    ['', 'hello'],
    ['hello', ''],
    ['Hallo Welt', 'Hallo liebe Welt'],
    ['a\r\nb\r\nc', 'a\r\nB\r\nc\r\nd'],
    ['emoji 🧠 here', 'emoji 🧠🧠 there'],
    ['👩‍👩‍👧 family', '👩‍👩‍👦 family'],
    ['nul\u0000byte', 'nul\u0000\u0000byte'],
  ])('turns %j into %j exactly', (from, to) => {
    const { doc, text } = textOf(from);
    doc.transact(() => applyTextChange(text, from, to));
    expect(text.toString()).toBe(to);
  });

  it('returns null when nothing changed', () => {
    const { doc, text } = textOf('same');
    let at: number | null = 0;
    doc.transact(() => {
      at = applyTextChange(text, 'same', 'same');
    });
    expect(at).toBeNull();
  });

  it('reports where the last change ended', () => {
    const { doc, text } = textOf('abc');
    let at: number | null = null;
    doc.transact(() => {
      at = applyTextChange(text, 'abc', 'abXc');
    });
    expect(at).toBe(3);
  });

  it('keeps a concurrent insert elsewhere in the text', () => {
    const a = textOf('one\ntwo\nthree\n');
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a.doc));
    const bText = b.getText('content');

    a.doc.transact(() => applyTextChange(a.text, 'one\ntwo\nthree\n', 'ONE\ntwo\nthree\n'));
    b.transact(() => bText.insert(bText.length, 'four\n'));

    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a.doc));
    expect(a.text.toString()).toBe('ONE\ntwo\nthree\nfour\n');
    expect(bText.toString()).toBe(a.text.toString());
  });

  it('is exact for random pairs, astral characters and CRLF included', () => {
    const alphabet = ['a', 'b', ' ', '\n', '\r\n', '🧠', 'é', '\u0000', '[[', ']]'];
    const random = (n: number): string =>
      Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
    for (let i = 0; i < 300; i++) {
      const from = random(Math.floor(Math.random() * 40));
      const to = random(Math.floor(Math.random() * 40));
      const { doc, text } = textOf(from);
      doc.transact(() => applyTextChange(text, from, to));
      expect(text.toString()).toBe(to);
    }
  });
});

describe('threeWay', () => {
  it('merges changes on different lines', () => {
    const base = 'a\nb\nc\n';
    expect(threeWay(base, 'A\nb\nc\n', 'a\nb\nC\n')).toEqual({ text: 'A\nb\nC\n', clean: true });
  });

  it('treats the same change on both sides as one', () => {
    const base = 'a\nb\n';
    expect(threeWay(base, 'a\nB\n', 'a\nB\n')).toEqual({ text: 'a\nB\n', clean: true });
  });

  it('keeps the live side of a conflict and says so', () => {
    const base = 'a\nb\n';
    expect(threeWay(base, 'a\nX\n', 'a\nY\n')).toEqual({ text: 'a\nY\n', clean: false });
  });

  it('handles a text without a trailing newline', () => {
    expect(threeWay('a\nb', 'a\nb\nc', 'z\na\nb')).toEqual({ text: 'z\na\nb\nc', clean: true });
  });

  it('leaves live untouched when incoming equals base', () => {
    expect(threeWay('a\n', 'a\n', 'a\nlive\n')).toEqual({ text: 'a\nlive\n', clean: true });
  });
});
