/**
 * The editor's one completion configuration.
 *
 * CodeMirror takes a single autocompletion setup per editor, so the two sources
 * have to be registered together rather than each installing its own. They
 * never compete: one only answers after `[[`, the other only after a slash at
 * the start of a line.
 */

import { autocompletion } from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';

import { wikilinkSource } from '../wikilink';
import { slashSource } from './commands';

export function completion(): Extension {
  return autocompletion({
    override: [wikilinkSource, slashSource],
    closeOnBlur: true,
    icons: false,
    // The note body is prose; an aggressive menu would fight ordinary typing.
    // Both sources are anchored to a trigger character, so this stays quiet.
    activateOnTyping: true,
    maxRenderedOptions: 12,
  });
}
