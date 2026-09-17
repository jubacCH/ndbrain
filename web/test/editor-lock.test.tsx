/**
 * The editor's lock: input refused while a note is being deleted, without the
 * editor being rebuilt. A rebuild starts again from the note as it was loaded,
 * so text typed but not yet saved would vanish, and a cancelled delete would
 * have cost somebody their last sentence.
 */

import { render } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';

import { Editor } from '../src/Editor';

function mount(locked: boolean) {
  const props = { owner: 'julian', path: 'Plan.md', initialContent: '# Plan\n', line: undefined, onChange: vi.fn() };
  const result = render(<Editor {...props} locked={locked} />);
  const view = (): EditorView => EditorView.findFromDOM(result.container.querySelector('.cm-editor') as HTMLElement)!;
  return { ...result, props, view };
}

describe('the editor lock', () => {
  it('refuses input while locked and keeps unsaved text across lock and unlock', () => {
    const { rerender, props, view } = mount(false);
    const first = view();
    first.dispatch({ changes: { from: first.state.doc.length, insert: 'typed, not saved' }, userEvent: 'input' });
    expect(props.onChange).toHaveBeenCalledWith('# Plan\ntyped, not saved');

    rerender(<Editor {...props} locked />);
    const locked = view();
    expect(locked).toBe(first);
    expect(locked.state.readOnly).toBe(true);
    expect(locked.contentDOM.getAttribute('contenteditable')).toBe('false');
    expect(locked.state.doc.toString()).toBe('# Plan\ntyped, not saved');

    rerender(<Editor {...props} locked={false} />);
    const open = view();
    expect(open).toBe(first);
    expect(open.state.readOnly).toBe(false);
    expect(open.contentDOM.getAttribute('contenteditable')).toBe('true');
    expect(open.state.doc.toString()).toBe('# Plan\ntyped, not saved');
  });
});
