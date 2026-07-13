/** Splits a search snippet using the server's `**bold**` highlight markers into
 *  plain/bold segments, so `SearchPalette` can render `<strong>` runs instead of
 *  `dangerouslySetInnerHTML`-ing raw, server-supplied markup. */

export interface SnippetSegment {
  text: string;
  bold: boolean;
}

const BOLD_PATTERN = /\*\*(.+?)\*\*/g;

export function parseSnippet(snippet: string): SnippetSegment[] {
  if (!snippet) return [];

  const segments: SnippetSegment[] = [];
  let lastIndex = 0;
  BOLD_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = BOLD_PATTERN.exec(snippet)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: snippet.slice(lastIndex, match.index), bold: false });
    }
    segments.push({ text: match[1], bold: true });
    lastIndex = BOLD_PATTERN.lastIndex;
  }

  if (lastIndex < snippet.length) {
    segments.push({ text: snippet.slice(lastIndex), bold: false });
  }

  return segments;
}
