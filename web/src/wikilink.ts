/**
 * Autocompletion for `[[wikilinks]]`.
 *
 * This is the feature that makes links exist at all. Without it people write
 * `[[Proxmox Cluster]]` from memory, get the spelling slightly wrong, and end up
 * with a vault full of links into the void — which the tidy view then dutifully
 * reports as a problem the tool itself caused.
 *
 * Suggestions come from the same endpoint the quick switcher uses, so a note is
 * found here exactly as it is found there.
 */

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';

import { api } from './api';

/**
 * Matches an unterminated `[[` before the cursor.
 *
 * Stops at `]`, at a newline and at a second `[`, so a completed link earlier on
 * the same line does not keep the menu open for the rest of it.
 */
const OPEN_LINK = /\[\[([^\]\n[]*)$/;

async function complete(context: CompletionContext): Promise<CompletionResult | null> {
  const before = context.matchBefore(OPEN_LINK);
  if (before === null) return null;

  // `[[` with nothing typed yet still opens the menu — that is the moment the
  // person most needs to be shown what exists.
  const typed = before.text.slice(2);
  if (typed === '' && !context.explicit && before.text !== '[[') return null;

  let notes;
  try {
    ({ notes } = await api.quickFind(typed));
  } catch {
    return null;
  }

  const options: Completion[] = notes.map((note) => ({
    label: note.title,
    detail: note.path.split('/').slice(0, -1).join('/') || '/',
    type: 'text',
    // Closes the brackets, so the person types `[[pro`, picks, and is done.
    apply: `${note.title}]]`,
  }));

  return {
    from: before.from + 2,
    options,
    // Keep querying as they type rather than filtering a stale list on the
    // client: the server's ranking is better than a substring filter here.
    validFor: /^[^\]\n[]*$/,
  };
}

export function wikilinkCompletion(): Extension {
  return autocompletion({
    override: [complete],
    closeOnBlur: true,
    icons: false,
    // The note body is prose; an aggressive menu would fight ordinary typing.
    activateOnTyping: true,
    maxRenderedOptions: 12,
  });
}
