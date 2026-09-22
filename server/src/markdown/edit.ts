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
