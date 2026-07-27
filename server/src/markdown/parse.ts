/**
 * Reads structure out of a Markdown note for the index.
 *
 * This module never rewrites a note. The file on disk is the source of truth, so
 * parsing is strictly one-way: text in, facts out. (Link rewriting on rename does
 * modify files, but that lives in the note service and works on the raw text.)
 *
 * The one genuinely hard part is knowing what is *not* markup. A fenced code
 * block full of `[[double brackets]]` is a code sample, not a set of links, and a
 * `#!/bin/sh` shebang is not a tag. Both appear constantly in a homelab vault, so
 * code spans are masked out before anything else is matched.
 */

import { parse as parseYaml } from 'yaml';

export interface WikiLink {
  /** Link target as written, before resolution against the vault. */
  target: string;
  /** Heading fragment after `#`, if any. */
  heading: string | null;
  /** Display text after `|`, if any. */
  alias: string | null;
  /** Byte offset of the `[[` within the full source. */
  offset: number;
  /** The complete `[[…]]` as written, so a rewriter can replace it verbatim. */
  raw: string;
}

export interface ExternalLink {
  text: string;
  url: string;
  offset: number;
}

export interface Task {
  done: boolean;
  text: string;
  /** 1-based line number within the full source. */
  line: number;
}

export interface ParsedNote {
  /** Parsed YAML frontmatter, or null when absent or malformed. */
  frontmatter: Record<string, unknown> | null;
  /** Why the frontmatter failed to parse, if it did. The note stays readable regardless. */
  frontmatterError: string | null;
  /** Source with the frontmatter block removed. */
  body: string;
  /** Offset at which `body` starts within the source. */
  bodyOffset: number;
  /** Tags from frontmatter and from `#inline` tags, deduplicated, frontmatter first. */
  tags: string[];
  wikilinks: WikiLink[];
  links: ExternalLink[];
  tasks: Task[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/**
 * `#tag` must follow start-of-line or whitespace, and must begin with a letter.
 *
 * Requiring a letter is what keeps `#1`, `#!/bin/sh` and CSS colours out. Headings
 * are excluded for free: `# Heading` has a space after the hash, `#Heading` does
 * not — and only the latter is a tag.
 */
const TAG_RE = /(?<=^|\s)#(\p{L}[\p{L}\p{N}_/-]*)/gu;

const WIKILINK_RE = /\[\[([^\][|#\n]+?)(?:#([^\][|\n]+?))?(?:\|([^\][\n]*?))?\]\]/g;

const LINK_RE = /\[([^\][\n]*)\]\(\s*<?([^)<>\s]+)>?(?:\s+"[^"\n]*")?\s*\)/g;

const TASK_RE = /^[ \t]*[-*+][ \t]+\[([ xX])\][ \t]+(.*)$/;

const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Replaces fenced code blocks and inline code spans with spaces.
 *
 * Offsets are preserved, so a match found in the mask can be read straight out of
 * the original — outside the masked regions the two strings are identical.
 */
function maskCode(source: string): string {
  const out = source.split('');
  const lines = source.split('\n');

  let offset = 0;
  let fence: string | null = null;

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1; // +1 for the newline consumed by split

    const bare = line.replace(/\r$/, '');
    const match = FENCE_RE.exec(bare);

    if (fence === null) {
      // An opening fence may carry an info string (```ts); a closing one may not.
      if (match?.[1]) {
        fence = match[1];
        blank(out, lineStart, lineStart + line.length);
        continue;
      }
    } else {
      const marker = match?.[1];
      const isClosing =
        marker !== undefined &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        (match?.[2] ?? '').trim() === '';

      blank(out, lineStart, lineStart + line.length);
      if (isClosing) fence = null;
      continue;
    }

    maskInlineCode(out, bare, lineStart);
  }

  return out.join('');
}

/** Masks `` `code` `` spans on a single line, honouring runs of backticks. */
function maskInlineCode(out: string[], line: string, lineStart: number): void {
  let i = 0;

  while (i < line.length) {
    if (line[i] !== '`') {
      i += 1;
      continue;
    }

    let runLength = 0;
    while (line[i + runLength] === '`') runLength += 1;

    const openEnd = i + runLength;
    const closer = '`'.repeat(runLength);
    let search = openEnd;
    let close = -1;

    // Find a run of exactly the same length — a longer run is not a terminator.
    while (search < line.length) {
      const found = line.indexOf(closer, search);
      if (found === -1) break;
      if (line[found + runLength] !== '`') {
        close = found;
        break;
      }
      let skip = found;
      while (line[skip] === '`') skip += 1;
      search = skip;
    }

    if (close === -1) {
      // Unterminated: not a code span, so leave the rest of the line alone.
      i = openEnd;
      continue;
    }

    blank(out, lineStart + i, lineStart + close + runLength);
    i = close + runLength;
  }
}

function blank(out: string[], from: number, to: number): void {
  for (let i = from; i < to && i < out.length; i += 1) {
    if (out[i] !== '\n') out[i] = ' ';
  }
}

function tagsFromFrontmatter(frontmatter: Record<string, unknown> | null): string[] {
  if (!frontmatter) return [];

  const raw = frontmatter['tags'] ?? frontmatter['tag'];
  if (typeof raw === 'string') {
    return raw.split(/[,\s]+/).filter(Boolean).map(stripLeadingHash);
  }
  if (Array.isArray(raw)) {
    return raw.filter((t): t is string => typeof t === 'string').map(stripLeadingHash);
  }
  return [];
}

function stripLeadingHash(tag: string): string {
  return tag.startsWith('#') ? tag.slice(1) : tag;
}

export function parseNote(source: string): ParsedNote {
  let frontmatter: Record<string, unknown> | null = null;
  let frontmatterError: string | null = null;
  let body = source;
  let bodyOffset = 0;

  const fm = FRONTMATTER_RE.exec(source);
  if (fm) {
    bodyOffset = fm[0].length;
    body = source.slice(bodyOffset);

    try {
      const parsed: unknown = parseYaml(fm[1] ?? '');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        frontmatter = parsed as Record<string, unknown>;
      } else if (parsed !== null && parsed !== undefined) {
        frontmatterError = 'frontmatter is not a mapping';
      }
    } catch (error) {
      // A broken YAML block must not make the note unreadable — it is still a
      // perfectly good text file, and refusing to index it would hide it.
      frontmatterError = error instanceof Error ? error.message : 'invalid YAML';
    }
  }

  const masked = maskCode(body);

  const wikilinks: WikiLink[] = [];
  for (const m of masked.matchAll(WIKILINK_RE)) {
    const target = (m[1] ?? '').trim();
    if (target === '') continue;
    wikilinks.push({
      target,
      heading: m[2]?.trim() ?? null,
      alias: m[3]?.trim() ?? null,
      offset: bodyOffset + (m.index ?? 0),
      raw: m[0],
    });
  }

  const links: ExternalLink[] = [];
  for (const m of masked.matchAll(LINK_RE)) {
    // `[[x]](y)` would otherwise be read as a wikilink and a link at once.
    const before = masked.slice(Math.max(0, (m.index ?? 0) - 1), m.index ?? 0);
    if (before === '[') continue;
    links.push({
      text: m[1] ?? '',
      url: m[2] ?? '',
      offset: bodyOffset + (m.index ?? 0),
    });
  }

  const inlineTags: string[] = [];
  for (const m of masked.matchAll(TAG_RE)) {
    const tag = m[1];
    if (tag) inlineTags.push(tag);
  }

  const tasks: Task[] = [];
  const maskedLines = masked.split('\n');
  for (let i = 0; i < maskedLines.length; i += 1) {
    const line = maskedLines[i];
    if (line === undefined) continue;
    const m = TASK_RE.exec(line.replace(/\r$/, ''));
    if (!m) continue;
    tasks.push({
      done: (m[1] ?? ' ').toLowerCase() === 'x',
      text: (m[2] ?? '').trim(),
      line: i + 1,
    });
  }

  const tags = dedupe([...tagsFromFrontmatter(frontmatter), ...inlineTags]);

  return { frontmatter, frontmatterError, body, bodyOffset, tags, wikilinks, links, tasks };
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
