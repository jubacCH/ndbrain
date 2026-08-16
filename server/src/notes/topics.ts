/**
 * Turning the metadata line an import left in the prose into real tags.
 *
 * A Joplin import wrote each note's metadata as a blockquote at the top of the
 * body rather than as frontmatter:
 *
 *     > **type:** reference · **topic:** proxmox, homelab · **updated:** 2026-06-06
 *
 * Which means the information is there and the tool cannot see it. On the vault
 * this was written for, 53 of 60 notes carry that line and *zero* notes carry a
 * tag — so the tag filter, the tag cloud and the untagged finding are all
 * switched off for want of a translation nobody can do by hand sixty times.
 *
 * Three rules, and the first two are about not being clever:
 *
 *  - **Only this exact shape.** A blockquote line with a bolded `topic:` label.
 *    Guessing tags from ordinary prose would put words into somebody's notes
 *    that they never wrote, in a file format whose whole promise is that it is
 *    theirs.
 *  - **Additive only.** Tags are added to the frontmatter; the line in the body
 *    is left exactly where it is. Removing it would be editing prose to tidy up
 *    after a migration, and if the result is wrong the evidence is gone.
 *  - **Proposed, never applied.** This module computes what *would* change.
 *    Nothing here writes; the caller decides, per note.
 */

import { parseNote } from '../markdown/parse.js';

/**
 * The metadata line, matched tightly.
 *
 * Anchored to a blockquote at the start of a line, and the label must be bolded
 * exactly as the importer wrote it. A looser pattern would match a sentence
 * containing the word "topic" and propose its next few words as tags.
 */
const TOPIC_LINE = /^>.*?\*\*topics?:\*\*\s*([^·|\n]+)/im;

/** Splits `proxmox, homelab` into tags, dropping what cannot be one. */
function toTags(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(',')) {
    const tag = piece
      .trim()
      .replace(/^#/, '')
      // A tag with a space in it is not addressable as `#tag`; hyphenate rather
      // than drop, since "smart home" is a topic somebody meant.
      .replace(/\s+/g, '-')
      .replace(/[[\]|#]/g, '')
      .toLowerCase();
    if (tag !== '' && tag.length <= 64 && !out.includes(tag)) out.push(tag);
  }
  return out;
}

export interface TopicProposal {
  path: string;
  title: string;
  /** Tags the note already declares — never proposed again. */
  existing: string[];
  /** What would be added. Empty means nothing to do for this note. */
  proposed: string[];
  /** The line the proposal was read from, so a person can check it. */
  source: string;
}

/**
 * What one note's metadata line would contribute.
 *
 * Returns null where there is nothing to propose — no line, or every topic in it
 * is already a tag. The caller lists only what would actually change, because a
 * preview full of no-op rows is a preview nobody reads to the end.
 */
export function proposeFor(path: string, title: string, content: string): TopicProposal | null {
  const match = TOPIC_LINE.exec(content);
  if (match === null) return null;

  const parsed = parseNote(content);
  const existing = parsed.tags.map((tag) => tag.toLowerCase());
  const proposed = toTags(match[1] ?? '').filter((tag) => !existing.includes(tag));

  if (proposed.length === 0) return null;

  return {
    path,
    title,
    existing: parsed.tags,
    proposed,
    source: (match[0] ?? '').trim().slice(0, 200),
  };
}
