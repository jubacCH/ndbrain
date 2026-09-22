/**
 * The tags the vault allows, read from the note that lists them.
 *
 * The point of this is prevention rather than tidying: a tag that never gets
 * typed never has to be found and merged later. So the menu offers the registry
 * and nothing else — not the tags already in use, which is where a typo lives
 * once it has been made.
 *
 * The registry is a note like any other, and it is read exactly as it is
 * written: values in backticks under a `## prefix/` heading. Two things are
 * deliberately not taken. Anything outside such a section, and anything not in
 * backticks — the registry carries a box of candidates that are in circulation
 * but not approved, and they are spelled without backticks precisely so that a
 * reader, human or otherwise, can tell them apart.
 */

/** Where the registry lives. A vault without this note simply has no registry. */
export const REGISTRY_PATH = '40_MOCs/_Tag-Registry — erlaubte Tags.md';

/** `## type/  (Form der Notiz)`, with or without backticks around the prefix. */
const SECTION = /^#{2,3}\s+`?([a-z][a-z0-9-]*)\/`?/i;

const VALUE = /`([^`\n]+)`/g;

/** A tag is a word, possibly with `/`, `-` or `_` in it. Nothing else. */
const TAG = /^[a-z0-9][a-z0-9/_-]*$/i;

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

export function parseTagRegistry(source: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  let prefix: string | null = null;
  let fence: string | null = null;

  for (const line of source.split('\n')) {
    const marker = FENCE.exec(line);
    if (fence !== null) {
      if (marker !== null && (marker[1] ?? '').startsWith(fence)) fence = null;
      continue;
    }
    if (marker !== null) {
      fence = marker[1] ?? '```';
      continue;
    }

    const section = SECTION.exec(line);
    if (section !== null) {
      prefix = `${section[1]}/`;
      continue;
    }
    // A heading that names no prefix ends the section rather than continuing
    // it: the "still to be agreed" box is a heading like any other, and what
    // it lists has not been approved.
    if (/^#{1,6}\s/.test(line)) {
      prefix = null;
      continue;
    }
    if (prefix === null) continue;

    VALUE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = VALUE.exec(line)) !== null) {
      const value = (match[1] ?? '').trim();
      if (!value.startsWith(prefix) || !TAG.test(value) || seen.has(value)) continue;
      seen.add(value);
      found.push(value);
    }
  }

  return found;
}
