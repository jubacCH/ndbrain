/**
 * Reading the excerpt a full-text hit comes back with.
 *
 * The server marks the matched words with square brackets (`snippet(…, '[',
 * ']', …)` in `server/src/index/queries.ts`). Brackets are also ordinary text in
 * a note — a wikilink, a checkbox, a footnote — so a bracketed stretch counts as
 * a match only when it holds one of the words that were searched for. Anything
 * else stays exactly as written.
 *
 * Everything here returns strings, never markup: an excerpt is a piece of a note,
 * and a note may contain anything, `<img onerror>` included.
 */

export interface SnippetPart {
  text: string;
  /** A stretch the search matched. */
  hit: boolean;
}

/** The words of a query as the server tokenises them, lower-cased. */
export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((term) => term.length > 1);
}

/** Folds case and accents, as the search index does (`remove_diacritics 2`). */
function fold(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

/** Whether a bracketed stretch is one of the searched words (or starts with one, as a prefix search does). */
function isMatch(inner: string, terms: readonly string[]): boolean {
  const folded = fold(inner);
  return terms.some((term) => folded.includes(fold(term)));
}

/** The excerpt split into plain text and the matched words. */
export function snippetParts(snippet: string, query: string): SnippetPart[] {
  const terms = queryTerms(query);
  const parts: SnippetPart[] = [];
  const push = (text: string, hit: boolean): void => {
    if (text === '') return;
    const last = parts[parts.length - 1];
    if (last !== undefined && last.hit === hit && !hit) last.text += text;
    else parts.push({ text, hit });
  };

  let rest = 0;
  for (const match of snippet.matchAll(/\[([^[\]\n]+)\]/g)) {
    const inner = match[1]!;
    const at = match.index;
    if (!isMatch(inner, terms)) continue;
    push(snippet.slice(rest, at), false);
    push(inner, true);
    rest = at + match[0].length;
  }
  push(snippet.slice(rest), false);
  return parts;
}

/** Collapses runs of whitespace, so an excerpt and the file it came from compare. */
function squash(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** How many characters two strings share, counted from their ends. */
function commonTail(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1;
  return n;
}

/** How many characters two strings share, counted from their starts. */
function commonHead(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

/**
 * The 1-based line of a note the excerpt was taken from.
 *
 * The matched word can occur many times in a note; the occurrence whose
 * surroundings read most like the excerpt's is the one the excerpt shows.
 * Undefined when the word is not in the text at all — a match only in the title,
 * or a note that changed since it was indexed — so the note simply opens at its
 * top rather than somewhere arbitrary.
 */
export function lineOfHit(content: string, snippet: string, query: string): number | undefined {
  const parts = snippetParts(snippet, query);
  const index = parts.findIndex((part) => part.hit);

  let needle: string;
  let before = '';
  let after = '';
  if (index === -1) {
    const term = queryTerms(query)[0];
    if (term === undefined) return undefined;
    needle = term;
  } else {
    needle = parts[index]!.text;
    const clean = (text: string): string => squash(text.replace(/…/g, ''));
    before = clean(parts.slice(0, index).map((part) => part.text).join('')).slice(-40).toLowerCase();
    after = clean(parts.slice(index + 1).map((part) => part.text).join('')).slice(0, 40).toLowerCase();
  }

  const hay = content.toLowerCase();
  const word = needle.toLowerCase();
  let best = -1;
  let bestScore = -1;
  for (let at = hay.indexOf(word); at !== -1; at = hay.indexOf(word, at + 1)) {
    const score =
      commonTail(squash(hay.slice(Math.max(0, at - 120), at)), before) +
      commonHead(squash(hay.slice(at + word.length, at + word.length + 120)), after);
    if (score > bestScore) {
      best = at;
      bestScore = score;
    }
  }
  if (best === -1) return undefined;

  let line = 1;
  for (let i = 0; i < best; i += 1) if (hay.charCodeAt(i) === 10) line += 1;
  return line;
}
