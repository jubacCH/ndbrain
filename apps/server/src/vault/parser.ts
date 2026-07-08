import matter from "gray-matter";

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
  title: string | null;
  links: string[];
}

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const HEADING = /^#{1,6}\s+(.+)$/m;

/** Parse a raw Markdown note into frontmatter, body, title and wikilink targets. */
export function parseNote(raw: string): ParsedNote {
  const { data, content } = matter(raw);
  const title = HEADING.exec(content)?.[1].trim() ?? null;
  const links = [...new Set([...content.matchAll(WIKILINK)].map((m) => m[1].trim()))];
  return { frontmatter: data as Record<string, unknown>, body: content.replace(/^\n/, ""), title, links };
}
