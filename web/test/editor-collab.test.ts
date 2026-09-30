/**
 * The writing surface over a live room.
 *
 * Two promises are pinned here. Undo is this tab's own: ⌘Z must never take
 * back what somebody else typed, which is why `history()` is replaced rather
 * than joined by a Yjs undo manager. And the bytes are still the file's: a
 * note with CRLF line endings and astral characters has to come back out of
 * the shared text exactly as it went in, because the room persists what the
 * shared text holds.
 */

import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { noteExtensions } from '../src/Editor';

/** Two docs that keep each other up to date, as the socket would. */
function pair(text: string): { a: Y.Doc; b: Y.Doc } {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') Y.applyUpdate(b, u, 'remote');
  });
  b.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') Y.applyUpdate(a, u, 'remote');
  });
  a.getText('content').insert(0, text);
  return { a, b };
}

function viewOn(doc: Y.Doc, at = 0): { view: EditorView; undo: Y.UndoManager } {
  const text = doc.getText('content');
  const undo = new Y.UndoManager(text);
  const collab = { text, awareness: new Awareness(doc), undo };
  const state = EditorState.create({
    doc: text.toString(),
    selection: EditorSelection.single(at),
    extensions: noteExtensions({ owner: 'julian', path: 'N.md', collab }),
  });
  const view = new EditorView({ state, parent: document.body });
  view.focus();
  return { view, undo };
}

/**
 * ⌘Z as the browser delivers it, so the editor's own keymap decides.
 *
 * Deliberately not `yUndoManagerKeymap`'s `run` called by hand: that undoes
 * through the Yjs manager whatever the editor is configured with, so the test
 * passes even when the editor installs CodeMirror's history keymap instead —
 * which is the one thing this file exists to catch.
 */
function pressUndo(view: EditorView): void {
  const event = new KeyboardEvent('keydown', {
    key: 'z',
    code: 'KeyZ',
    keyCode: 90,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  view.contentDOM.dispatchEvent(event);
  expect(event.defaultPrevented, 'something in the editor claimed Ctrl-Z').toBe(true);
}

describe('the editor with collab', () => {
  it('takes its document from the shared text, not from initialContent', () => {
    const { a } = pair('hello');
    const { view } = viewOn(a);
    expect(view.state.doc.toString()).toBe('hello');
    view.destroy();
  });

  it('shows remote changes', () => {
    const { a, b } = pair('hello');
    const { view } = viewOn(a);
    b.getText('content').insert(5, ' world');
    expect(view.state.doc.toString()).toBe('hello world');
    view.destroy();
  });

  it('sends local typing into the shared text', () => {
    const { a, b } = pair('hello');
    const { view } = viewOn(a);
    view.dispatch({ changes: { from: 5, insert: '!' } });
    expect(b.getText('content').toString()).toBe('hello!');
    view.destroy();
  });

  it('undo only reverts local changes', () => {
    const { a, b } = pair('hello');
    const { view } = viewOn(a);

    view.dispatch({ changes: { from: 5, insert: ' mine' } });
    b.getText('content').insert(0, 'theirs ');
    expect(view.state.doc.toString()).toBe('theirs hello mine');

    pressUndo(view);

    // Mine is gone, theirs is untouched — not 'hello mine', which is what a
    // shared history would have produced.
    expect(view.state.doc.toString()).toBe('theirs hello');
    expect(a.getText('content').toString()).toBe('theirs hello');
    view.destroy();
  });

  it('undo does not reach back past what this tab did, even repeated', () => {
    const { a, b } = pair('hello');
    const { view } = viewOn(a);
    b.getText('content').insert(0, 'theirs ');
    view.dispatch({ changes: { from: view.state.doc.length, insert: '!' } });

    pressUndo(view);
    pressUndo(view);
    pressUndo(view);

    expect(view.state.doc.toString()).toBe('theirs hello');
    view.destroy();
  });

  it('keeps the bytes of a note with CRLF, emoji and a NUL', () => {
    const original = '# 🧠 Notes\r\n- [ ] a\u0000b\r\n👩‍👩‍👧\r\n';
    const { a } = pair(original);
    const { view } = viewOn(a);

    // The view and the shared text must agree character for character, or
    // every offset y-codemirror.next maps between them is off by one per line
    // and an edit lands in the wrong place.
    expect(view.state.doc.toString()).toBe(original);
    expect(view.state.doc.length).toBe(original.length);

    // And an edit made through the view leaves the rest of the bytes alone.
    view.dispatch({ changes: { from: original.length, insert: 'tail\r\n' } });
    expect(a.getText('content').toString()).toBe(`${original}tail\r\n`);
    view.destroy();
  });

  it('a remote edit after a CRLF line lands where it was meant to', () => {
    const original = 'one\r\ntwo\r\nthree\r\n';
    const { a, b } = pair(original);
    const { view } = viewOn(a);

    // Offset 10 is the 't' of "three" counted in the file's own characters.
    b.getText('content').insert(10, 'X');
    expect(a.getText('content').toString()).toBe('one\r\ntwo\r\nXthree\r\n');
    expect(view.state.doc.toString()).toBe('one\r\ntwo\r\nXthree\r\n');
    view.destroy();
  });

  it('leaves today"s editor alone when there is no room', () => {
    const state = EditorState.create({
      doc: 'plain',
      extensions: noteExtensions({ owner: 'julian', path: 'N.md' }),
    });
    const view = new EditorView({ state, parent: document.body });
    view.dispatch({ changes: { from: 5, insert: '!' } });
    expect(view.state.doc.toString()).toBe('plain!');
    view.destroy();
  });
});
