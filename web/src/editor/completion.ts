/**
 * The editor's one completion configuration.
 *
 * CodeMirror takes a single autocompletion setup per editor, so the sources
 * have to be registered together rather than each installing its own. They
 * never compete: one only answers after `[[`, one only after a slash at the
 * start of a line, and one only after an `@` that does not sit inside a word.
 */

import { autocompletion } from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';

import { wikilinkSource } from '../wikilink';
import { slashSource } from './commands';
import { mentionSource } from './mentions';

export function completion(): Extension {
  return autocompletion({
    override: [wikilinkSource, slashSource, mentionSource],
    closeOnBlur: true,
    icons: false,
    // The note body is prose; an aggressive menu would fight ordinary typing.
    // Both sources are anchored to a trigger character, so this stays quiet.
    activateOnTyping: true,
    maxRenderedOptions: 12,
  });
}
