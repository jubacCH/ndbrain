/**
 * Targeted edits to a note's source text.
 *
 * Everything here works on the raw text rather than by parsing and
 * re-serialising. Round-tripping YAML through a library would reformat the
 * frontmatter somebody wrote — reordering keys, changing quote style, expanding
 * flow lists — and rewriting a person's file to suit our parser is exactly the
 * kind of thing this product exists not to do.
 *
 * The cost is that these functions handle the shapes people actually write and
 * refuse anything else, rather than handling every shape YAML permits.
 */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n(---|\.\.\.)([ \t]*\r?\n|$)/;

/** Flow style: `tags: [a, b]`. */
const FLOW_TAGS = /^([ \t]*tags[ \t]*:[ \t]*)\[([^\]\n]*)\][ \t]*$/m;

/** Block style: `tags:` followed by `  - a` lines. */
const BLOCK_TAGS = /^([ \t]*)tags[ \t]*:[ \t]*(\r?\n)((?:[ \t]*-[ \t]*[^\n]*(?:\r?\n|$))*)/m;

/** Inline scalar: `tags: a, b`. */
const SCALAR_TAGS = /^([ \t]*tags[ \t]*:[ \t]*)([^\n[][^\n]*)$/m;

/**
 * Reduces a tag as written to what it means.
 *
 * Frontmatter tags legitimately appear as `homelab`, `#homelab`, `"homelab"` and
 * `"#homelab"`, and all four are the same tag. Comparing them naively adds a
 * duplicate to a list that already had it.
 */
function tagKey(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^#/, '')
    .trim()
    .toLowerCase();
}

function hasTag(existing: string[], tag: string): boolean {
  const key = tagKey(tag);
  return existing.some((value) => tagKey(value) === key);
}

function newline(source: string): string {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Adds a tag to a note, leaving everything else byte-identical.
 *
 * Returns the source unchanged when the tag is already there, so a bulk tag over
 * a mixed selection does not rewrite — and re-date — files that needed nothing.
 */
export function addTag(source: string, rawTag: string): string {
  const tag = rawTag.trim().replace(/^#/, '');
  if (tag === '') return source;

  const eol = newline(source);
  const match = FRONTMATTER.exec(source);

  if (match === null) {
    // No frontmatter at all: create the smallest possible block.
    return `---${eol}tags: [${tag}]${eol}---${eol}${source}`;
  }

  const block = match[1] ?? '';
  // The block begins right after the opening fence and its line break. Searching
  // for it with `indexOf` works only while it has content: an empty block is the
  // empty string, `indexOf` answers 0, and the split then lands before the fence
  // — the tag is written above the document and the frontmatter is destroyed.
  const blockStart = source.startsWith('---\r\n') ? 5 : 4;
  const rest = source.slice(blockStart + block.length);
  const head = source.slice(0, blockStart);

  const flow = FLOW_TAGS.exec(block);
  if (flow !== null) {
    const inside = flow[2] ?? '';
    const existing = inside.split(',').map((value) => value.trim()).filter((value) => value !== '');
    if (hasTag(existing, tag)) return source;

    const joined = [...existing, tag].join(', ');
    // A function, not a replacement string. `String.replace` reads `$&`, `$\'`
    // and `$1` out of a replacement string and expands them, and a tag is
    // something a person types — in the bulk dialog, or in a file that arrives
    // from an import. A name carrying a dollar would paste a piece of the note
    // back into itself. The function form hands the text through untouched.
    // `mcp/tools.ts` avoids the same trap by splicing at an offset.
    return head + block.replace(FLOW_TAGS, (_whole, key: string) => `${key}[${joined}]`) + rest;
  }

  const blockList = BLOCK_TAGS.exec(block);
  if (blockList !== null) {
    const items = (blockList[3] ?? '')
      .split(/\r?\n/)
      .map((line) => line.replace(/^[ \t]*-[ \t]*/, '').trim())
      .filter((value) => value !== '');
    if (hasTag(items, tag)) return source;

    const indent = `${blockList[1] ?? ''}  `;
    const trailing = (blockList[3] ?? '').endsWith('\n') ? '' : eol;
    const replaced = block.replace(
      BLOCK_TAGS,
      (_whole, lead: string, br: string, items: string) =>
        `${lead}tags:${br}${items}${trailing}${indent}- ${tag}${eol}`,
    );
    return head + replaced.replace(/(\r?\n)+$/, eol === '\r\n' ? '' : '') + rest;
  }

  const scalar = SCALAR_TAGS.exec(block);
  if (scalar !== null) {
    const existing = (scalar[2] ?? '').split(/[,\s]+/).filter((value) => value !== '');
    if (hasTag(existing, tag)) return source;
    const joinedScalar = [...existing, tag].join(', ');
    return head + block.replace(SCALAR_TAGS, (_whole, key: string) => `${key}${joinedScalar}`) + rest;
  }

  // Frontmatter without a tags key: add one as the last line of the block.
  const separator = block.endsWith('\n') || block === '' ? '' : eol;
  return `${head}${block}${separator}${eol === '\r\n' ? '\r\n' : '\n'}tags: [${tag}]`.replace(
    /\n\n$/,
    '\n',
  ) + rest;
}

/** Removes a tag from the frontmatter. Leaves inline `#tags` in the body alone. */
export function removeTag(source: string, rawTag: string): string {
  const tag = tagKey(rawTag);
  if (tag === '') return source;

  const match = FRONTMATTER.exec(source);
  if (match === null) return source;

  const block = match[1] ?? '';
  // The block begins right after the opening fence and its line break. Searching
  // for it with `indexOf` works only while it has content: an empty block is the
  // empty string, `indexOf` answers 0, and the split then lands before the fence
  // — the tag is written above the document and the frontmatter is destroyed.
  const blockStart = source.startsWith('---\r\n') ? 5 : 4;
  const head = source.slice(0, blockStart);
  const rest = source.slice(blockStart + block.length);

  const flow = FLOW_TAGS.exec(block);
  if (flow !== null) {
    const kept = (flow[2] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value !== '' && tagKey(value) !== tag);
    const keptList = kept.join(', ');
    return head + block.replace(FLOW_TAGS, (_whole, key: string) => `${key}[${keptList}]`) + rest;
  }

  const blockList = BLOCK_TAGS.exec(block);
  if (blockList !== null) {
    const kept = (blockList[3] ?? '')
      .split(/\r?\n/)
      .filter((line) => {
        const value = line.replace(/^[ \t]*-[ \t]*/, '').trim();
        return value !== "" && tagKey(value) !== tag;
      });
    const eol = newline(source);
    const rendered = kept.length === 0 ? '' : kept.join(eol) + eol;
    return (
      head +
      block.replace(BLOCK_TAGS, (_whole, lead: string, br: string) => `${lead}tags:${br}${rendered}`) +
      rest
    );
  }

  return source;
}

/** An ATX heading line: the hashes, then the text, with `\r` and padding off. */
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*\r?$/;

/**
 * `source` with `addition` added — at the end of the note, or at the end of one
 * of its sections.
 *
 * The separator rule is the one thing every writer that adds to a note has to
 * agree on, which is why it lives here and not twice: the MCP tool and the
 * append endpoint both call this, and a second hand-written version of "one
 * blank line, unless there already is one" would drift within a release.
 *
 * `section` names a heading by its text. A thought thrown at a daily note
 * belongs under that note's "Notizen", not after its "Links", where a line of
 * prose reads as a link somebody forgot to finish — and where the start page's
 * own preview of the day, which reads exactly that section, would never show
 * it. The section ends at the next heading of the same or a higher level, so a
 * sub-heading inside it stays inside it.
 *
 * A section that is not there is not an error: the addition goes to the end of
 * the note instead. Whoever renamed the heading gets their text in a slightly
 * odd place; refusing the write would lose it, and that is the one outcome a
 * capture field may never have.
 */
export function appended(source: string, addition: string, section?: string): string {
  const eol = newline(source);
  const text = addition.replace(/[ \t\r\n]+$/, '');
  if (text === '') return source;

  if (section !== undefined) {
    const placed = intoSection(source, text, section, eol);
    if (placed !== null) return placed;
  }

  const gap =
    source === '' ? '' : source.endsWith(eol + eol) ? '' : source.endsWith(eol) ? eol : eol + eol;
  return source + gap + text;
}

/** `appended`'s section case; `null` when the note has no such heading. */
function intoSection(source: string, text: string, section: string, eol: string): string | null {
  const lines = source.split(eol);
  const wanted = section.trim().toLowerCase();

  let head = -1;
  let level = 0;
  for (let i = 0; i < lines.length && head === -1; i += 1) {
    const match = HEADING.exec(lines[i]!);
    if (match !== null && match[2]!.toLowerCase() === wanted) {
      head = i;
      level = match[1]!.length;
    }
  }
  if (head === -1) return null;

  // Where the section stops: the next heading that is not below it.
  let end = lines.length;
  for (let i = head + 1; i < end; i += 1) {
    const match = HEADING.exec(lines[i]!);
    if (match !== null && match[1]!.length <= level) end = i;
  }

  // After the section's last written line, so repeated captures stay in order
  // and the blank line before the next heading is kept.
  let at = head;
  for (let i = head + 1; i < end; i += 1) {
    if (lines[i]!.trim() !== '') at = i;
  }

  lines.splice(at + 1, 0, '', ...text.split(/\r?\n/));
  return lines.join(eol);
}
