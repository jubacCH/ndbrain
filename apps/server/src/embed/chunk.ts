import matter from "gray-matter";

export interface NoteChunk {
  ix: number;
  text: string;
}

/** Soft cap on chunk size, in characters, used as a cheap proxy for a token budget. */
const CHUNK_CHAR_CAP = 1500;

/**
 * Splits a note's markdown into ordered, contiguous chunks suitable for embedding.
 *
 * Strategy (v1, deterministic):
 * 1. Strip a leading YAML frontmatter block (`--- ... ---`) via gray-matter — it's
 *    structured metadata (tags, dates, ...), not prose, so it would add noise rather
 *    than semantic signal to an embedding. Malformed frontmatter (e.g. a hand-edited
 *    file with broken YAML) falls back to using the raw markdown as-is rather than
 *    throwing, since a background indexer must never crash a note write over a
 *    formatting quirk.
 * 2. Split the remaining body into paragraphs on heading boundaries (`#` … `######`)
 *    and blank lines, so a heading always starts a new paragraph even without a blank
 *    line before it.
 * 3. Greedily pack paragraphs into chunks up to a soft `CHUNK_CHAR_CAP` (~1500 chars),
 *    so each chunk stays a coherent, reasonably-sized span. A single paragraph that
 *    alone exceeds the cap is still emitted whole — never dropped or truncated — v1
 *    accepts an oversized outlier chunk rather than adding mid-paragraph splitting.
 *
 * Empty/whitespace-only paragraphs are never emitted. A note with no prose content
 * (empty body, or a frontmatter-only note) yields zero chunks.
 */
export function chunkNote(markdown: string): NoteChunk[] {
  const body = stripFrontmatter(markdown);
  const paragraphs = splitIntoParagraphs(body);

  const chunkTexts: string[] = [];
  let buffer: string[] = [];
  let bufferLen = 0;

  const flushBuffer = (): void => {
    if (buffer.length === 0) return;
    chunkTexts.push(buffer.join("\n\n"));
    buffer = [];
    bufferLen = 0;
  };

  for (const paragraph of paragraphs) {
    if (bufferLen > 0) {
      const lenWithParagraph = bufferLen + 2 + paragraph.length;
      if (lenWithParagraph > CHUNK_CHAR_CAP) {
        flushBuffer();
        buffer.push(paragraph);
        bufferLen = paragraph.length;
        continue;
      }
      buffer.push(paragraph);
      bufferLen = lenWithParagraph;
    } else {
      buffer.push(paragraph);
      bufferLen = paragraph.length;
    }
  }
  flushBuffer();

  return chunkTexts.map((text, ix) => ({ ix, text }));
}

function stripFrontmatter(markdown: string): string {
  try {
    return matter(markdown).content;
  } catch {
    return markdown;
  }
}

function splitIntoParagraphs(body: string): string[] {
  // Split before every heading line so a heading always starts a new block, even
  // when the author didn't leave a blank line before it.
  const headingBlocks = body.split(/(?=^#{1,6}\s)/m);
  const paragraphs: string[] = [];
  for (const block of headingBlocks) {
    for (const paragraph of block.split(/\n{2,}/)) {
      const trimmed = paragraph.trim();
      if (trimmed.length > 0) paragraphs.push(trimmed);
    }
  }
  return paragraphs;
}
