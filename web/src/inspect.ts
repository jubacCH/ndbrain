/**
 * What the inspector says about a note, as pure functions.
 *
 * Everything here is read off data the view already holds or fetched through
 * an endpoint the caller may use: the graph reply (which the server has already
 * cut down to what the caller may see) and the text of one note. Nothing is
 * guessed and nothing is generated: a reason why two notes are connected is a
 * link, a folder, a tag or a neighbour they share, or it is not shown.
 */

import type { GraphData } from './api';
import type { NoteKind } from './brain/kind';
import { noteKind } from './brain/kind';
import { refKey } from './refkey';

type GraphNode = GraphData['nodes'][number];

/** One note next to the selected one. */
export interface Neighbour {
  key: string;
  owner: string;
  path: string;
  title: string;
  folder: string;
}

/** The direct neighbours of a note, split by the direction of the link. */
export interface Neighbourhood {
  /** Notes this one links to. */
  outgoing: Neighbour[];
  /** Notes that link to this one. */
  incoming: Neighbour[];
}

/**
 * The graph as lookups, built once per reply.
 *
 * The inspector asks the same three questions for every row it draws — who is
 * this, what does it link to, what links to it — and a scan over every edge for
 * each would make a hub with eighty neighbours quadratic for nothing.
 */
export interface GraphIndex {
  nodes: Map<string, GraphNode>;
  out: Map<string, Set<string>>;
  in: Map<string, Set<string>>;
}

export function indexGraph(data: GraphData): GraphIndex {
  const nodes = new Map<string, GraphNode>();
  for (const node of data.nodes) nodes.set(refKey(node.owner, node.path), node);
  const out = new Map<string, Set<string>>();
  const inc = new Map<string, Set<string>>();
  for (const edge of data.edges) {
    const from = refKey(edge.owner, edge.from);
    const to = refKey(edge.owner, edge.to);
    // Same filters as the brain's model: an edge to a note the reply does not
    // carry has nowhere to go, and a note is not its own neighbour.
    if (from === to || !nodes.has(from) || !nodes.has(to)) continue;
    let o = out.get(from);
    if (o === undefined) out.set(from, (o = new Set()));
    o.add(to);
    let i = inc.get(to);
    if (i === undefined) inc.set(to, (i = new Set()));
    i.add(from);
  }
  return { nodes, out, in: inc };
}

const byTitle = (a: Neighbour, b: Neighbour): number =>
  a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.path.localeCompare(b.path);

function toNeighbours(index: GraphIndex, keys: Iterable<string>): Neighbour[] {
  const out: Neighbour[] = [];
  for (const key of keys) {
    const node = index.nodes.get(key);
    if (node === undefined) continue;
    out.push({ key, owner: node.owner, path: node.path, title: node.title, folder: node.folder });
  }
  return out.sort(byTitle);
}

export function neighbourhood(index: GraphIndex, key: string): Neighbourhood {
  return {
    outgoing: toNeighbours(index, index.out.get(key) ?? []),
    incoming: toNeighbours(index, index.in.get(key) ?? []),
  };
}

/** Every note linked to `key` in either direction. */
function around(index: GraphIndex, key: string): Set<string> {
  return new Set([...(index.out.get(key) ?? []), ...(index.in.get(key) ?? [])]);
}

/** The structural reasons two notes belong together. */
export interface Reasons {
  /** How they are linked directly, or null when they are not. */
  link: 'outgoing' | 'incoming' | 'both' | null;
  /**
   * The deepest folder both notes live in, as its last segment, or null when
   * they share none. `same` says whether it is the folder of both, not only an
   * ancestor of one.
   */
  folder: { name: string; same: boolean } | null;
  /** Tags both carry, compared without case, in the spelling of the first note. */
  tags: string[];
  /** How many notes link to or from both. */
  shared: number;
}

/**
 * Why `from` and `to` are connected, from the structure alone.
 *
 * `link` is seen from `from`: `outgoing` means `from` links to `to`.
 */
export function whyConnected(index: GraphIndex, from: string, to: string): Reasons {
  const a = index.nodes.get(from);
  const b = index.nodes.get(to);
  const fwd = index.out.get(from)?.has(to) ?? false;
  const back = index.in.get(from)?.has(to) ?? false;
  const link = fwd && back ? 'both' : fwd ? 'outgoing' : back ? 'incoming' : null;

  let folder: Reasons['folder'] = null;
  if (a !== undefined && b !== undefined && a.owner === b.owner) {
    const pa = a.folder.split('/').filter((s) => s !== '');
    const pb = b.folder.split('/').filter((s) => s !== '');
    let common = 0;
    while (common < pa.length && common < pb.length && pa[common] === pb[common]) common += 1;
    if (common > 0) {
      folder = { name: pa[common - 1]!, same: common === pa.length && common === pb.length };
    }
  }

  const tags: string[] = [];
  if (a !== undefined && b !== undefined) {
    const theirs = new Set(b.tags.map((t) => t.toLowerCase()));
    const seen = new Set<string>();
    for (const tag of a.tags) {
      const low = tag.toLowerCase();
      if (theirs.has(low) && !seen.has(low)) {
        seen.add(low);
        tags.push(tag);
      }
    }
  }

  const mine = around(index, from);
  let shared = 0;
  for (const other of around(index, to)) {
    if (other !== from && other !== to && mine.has(other)) shared += 1;
  }

  return { link, folder, tags, shared };
}

/* ===================== a whole region ===================== */

/** One note of a region, with the degree the server counted for it. */
export interface RegionMember {
  key: string;
  owner: string;
  path: string;
  title: string;
  folder: string;
  /** Resolved links in both directions, as the graph reply gives them. */
  links: number;
}

/** How many notes of one kind a region holds. */
export interface KindCount {
  kind: NoteKind;
  /** For `folder`: the name the vault itself uses. Empty for every other kind. */
  label: string;
  count: number;
}

/**
 * What can be said about a knowledge area without asking anything of anybody.
 *
 * The briefing's region panel is "Orbit8 · 124 Notes · 18 Resources · 8 MOCs ·
 * 6 Projects · Last active: Today", and then four tabs of which three want an
 * AI. What is left is what the graph reply already carries, counted: how many
 * notes and of which kind, which tags they share, when one of them was last
 * written, and which of them are the most connected.
 *
 * Nothing is estimated. A region whose notes carry no tags gets an empty list,
 * not a guess — the rule `Home.tsx` states for the whole app.
 */
export interface RegionFacts {
  /** Notes of the region the reply actually carries. */
  notes: number;
  /** Notes per kind, most first; only the kinds the region has. */
  kinds: KindCount[];
  /** Tags its notes carry, most first, compared without case. */
  tags: Array<{ tag: string; count: number }>;
  /** The most recent edit among them, or null where the region holds no note. */
  lastActive: number | null;
  /**
   * The most connected notes, most first — the briefing's "strong connections"
   * (point 29) for this area, which is `degree` and nothing else.
   *
   * A note linked to nothing is left out rather than listed with a zero: it is
   * the opposite of a strong connection, and the tidy view already names it.
   */
  strongest: RegionMember[];
}

/** Counts a region's notes, tags, kinds and degrees. `keys` are its members. */
export function regionFacts(index: GraphIndex, keys: Iterable<string>): RegionFacts {
  const kinds = new Map<string, KindCount>();
  const tags = new Map<string, { tag: string; count: number }>();
  const members: RegionMember[] = [];
  let notes = 0;
  let lastActive: number | null = null;

  for (const key of keys) {
    const node = index.nodes.get(key);
    // A member the reply does not carry: the layout knows it, the panel cannot
    // show it, and counting it would make the total disagree with the list.
    if (node === undefined) continue;
    notes += 1;
    if (lastActive === null || node.updatedAt > lastActive) lastActive = node.updatedAt;

    const kind = noteKind(node.folder, node.title);
    const id = kind.kind === 'folder' ? `folder\u0000${kind.label}` : kind.kind;
    const held = kinds.get(id);
    if (held === undefined) kinds.set(id, { kind: kind.kind, label: kind.label, count: 1 });
    else held.count += 1;

    // Case-folded, like the shared tags in `whyConnected`, and kept in the
    // spelling the first note that carries it uses.
    const seen = new Set<string>();
    for (const tag of node.tags) {
      const low = tag.toLowerCase();
      if (seen.has(low)) continue;
      seen.add(low);
      const count = tags.get(low);
      if (count === undefined) tags.set(low, { tag, count: 1 });
      else count.count += 1;
    }

    if (node.links > 0) {
      members.push({
        key,
        owner: node.owner,
        path: node.path,
        title: node.title,
        folder: node.folder,
        links: node.links,
      });
    }
  }

  // Ties are broken by name everywhere below, so the same region always reads
  // the same way however the reply happened to be ordered.
  return {
    notes,
    kinds: [...kinds.values()].sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label)),
    tags: [...tags.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    lastActive,
    strongest: members.sort((a, b) => b.links - a.links || a.title.localeCompare(b.title) || a.path.localeCompare(b.path)),
  };
}

/** How long a summary may run before it is cut, in characters. */
export const SUMMARY_MAX = 240;

/** Strips the inline markdown a summary line would otherwise show as punctuation. */
function plain(text: string): string {
  return (
    text
      // Images first, or the link rule below would leave their `!`.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/!\[\[[^\]]*\]\]/g, '')
      .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?\|([^\]]*)\]\]/g, '$2')
      .replace(/\[\[([^\]|#]*)(?:#([^\]|]*))?\]\]/g, (_m, target: string, heading?: string) =>
        target !== '' ? target.split('/').pop()!.replace(/\.md$/i, '') : (heading ?? ''),
      )
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, '')
      .replace(/(\*\*|__|~~|==)(.+?)\1/g, '$2')
      .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, '$1$2')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * The first paragraph of a note that says something, as plain text.
 *
 * Skipped: the frontmatter, headings, a blockquote header (the callout many
 * notes open with), fenced code, comments, rules and tables — the things a
 * note carries *about* itself or *beside* its prose. A list counts as content:
 * plenty of notes are nothing but one, and its items are joined into a line.
 *
 * The result is text, never markup; the caller renders it as a text node.
 * Cut at a word boundary to `max` characters, with an ellipsis.
 */
export function summarize(markdown: string, max = SUMMARY_MAX): string {
  let lines = markdown.replace(/\r\n?/g, '\n').split('\n');

  // Frontmatter only at the very start, closed by a line of its own.
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, i) => i > 0 && (line.trim() === '---' || line.trim() === '...'));
    if (end > 0) lines = lines.slice(end + 1);
  }

  // A line or a paragraph is only ever read as far as the summary could reach.
  // The markup rules in `plain` backtrack, and on a 40 KB line of `[` they
  // took seconds on the main thread — a note may hold anything.
  const reach = max * 2;
  const clip = (text: string): string => (text.length > reach ? text.slice(0, reach) : text);
  const block: string[] = [];
  let length = 0;
  let fence: string | null = null;
  let comment = false;
  let list = false;

  for (const raw of lines) {
    const line = raw.trim();

    if (fence !== null) {
      if (line.startsWith(fence)) fence = null;
      continue;
    }
    if (comment) {
      if (line.includes('-->')) comment = false;
      continue;
    }

    const opens = /^(```+|~~~+)/.exec(line);
    const skip =
      opens !== null ||
      line.startsWith('<!--') ||
      /^#{1,6}(\s|$)/.test(line) ||
      line.startsWith('>') ||
      /^([-*_])(\s*\1){2,}$/.test(line) ||
      line.startsWith('|') ||
      /^%%/.test(line);

    if (line === '' || skip) {
      if (block.length > 0) break;
      if (opens !== null) fence = opens[1]!;
      if (line.startsWith('<!--') && !line.includes('-->')) comment = true;
      continue;
    }

    const item = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (item !== null) {
      // A list after a paragraph is a new block; a paragraph after a list, too.
      if (block.length > 0 && !list) break;
      list = true;
      const text = plain(clip(item[1]!));
      if (text !== '') block.push(text);
      length += text.length;
      if (length > reach) break;
      continue;
    }
    if (list) break;
    const text = plain(clip(line));
    if (text !== '') block.push(text);
    length += text.length;
    if (length > reach) break;
  }

  const joined = block.join(list ? ' · ' : ' ');
  if (joined.length <= max) return joined;
  const cut = joined.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s·,;:.-]+$/, '')}…`;
}
