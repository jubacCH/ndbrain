/**
 * Clusters: which notes belong together, read from the vault's own structure.
 *
 * The brain is drawn as regions, and a region needs members. They come from
 * what the owner has already said about the notes, not from a model guessing
 * at their text (target architecture, deviation C): links above all, then the
 * folder a note was filed in and the tags it carries. Briefing point 46 asks
 * for exactly that — explicit structure counts, and no single signal decides.
 * It also makes a cluster explainable: "these link to each other, share two
 * neighbours and sit in the same folder" is an answer somebody can check.
 *
 * **Why not label propagation.** The plan named it, and it was built first. It
 * is deterministic once the visiting order and the tie-break come from the path
 * hash, but it is not *stable*: every note's label is the outcome of a chain of
 * earlier decisions, so one new link early in the chain can flip a borderline
 * note and everything that later took its cue from it. On a copy of the real
 * vault's link structure, only about four in five of the possible "capture a
 * note and link it to one other" changes left every existing note in its
 * cluster; the rest reassigned up to twenty-two notes. Running it several times
 * and voting did not fix that, nor did visiting hubs first.
 *
 * **What is used instead: every note joins its strongest tie.** Each note
 * picks the one neighbour it is most closely bound to, and the clusters are
 * what those choices connect. One decision per note, taken once, from that
 * note's own neighbourhood — so a new link can only change the choice of the
 * notes it touches and of the notes whose choice between near-equal ties it
 * tips, never a whole chain of propagated decisions.
 *
 * Because the tie is symmetric, the choices cannot run in a circle longer than
 * two: somewhere two notes choose each other, and that pair is the core of the
 * cluster everyone else's choices lead to.
 *
 * Measured on a copy of the real vault's link structure (109 notes, 270 linked
 * pairs), for every possible "capture a note, link it to one existing note":
 * 102 of 109 leave every existing note in its cluster, and the worst moves
 * four. Label propagation on the same data: 82 of 109, worst twenty-two.
 *
 * Deterministic throughout: ties go to the note first in path-hash order, and
 * nothing depends on the order the server listed notes or links in.
 */

import type { BrainGraph } from './model';
import { hash32 } from './seed';

export interface Cluster {
  /**
   * A stable identity: the key of the member that comes first in hash order.
   *
   * Not an index: an index shifts when a cluster is added before it. The first
   * member in hash order only changes when that member leaves the cluster.
   */
  id: string;
  /** Node indices, in hash order. */
  members: number[];
  /** The folder most members were filed in, as the server spells it. */
  folder: string;
  /**
   * A name for the region, for labels in a later phase.
   *
   * The dominant folder's last segment, or the tags most members share when no
   * folder holds a majority. Where two clusters would carry the same name, the
   * title of each one's most connected note is added to tell them apart. Folder
   * prefixes like `11_` are left in: hiding them is a display preference
   * (`prefs.ts`), and this is data.
   */
  name: string;
}

export interface Clustering {
  /** Cluster index per node index. */
  of: Int32Array;
  /** Ordered by the hash rank of their `id`, so the order is stable too. */
  clusters: Cluster[];
}

/** Tags per node key. Optional: the graph endpoint does not carry them yet. */
export type TagsByKey = ReadonlyMap<string, readonly string[]>;

/**
 * How much a shared folder and each shared tag strengthen a link.
 *
 * Multipliers on a link, not ties of their own: two notes in the same folder
 * that do not link are not thereby bound, or a flat folder of forty service
 * notes would be one cluster whatever they link to. Between two links of
 * otherwise equal weight, the one that also shares a folder or a tag wins.
 */
const SAME_FOLDER = 0.5;
const PER_SHARED_TAG = 0.25;

/**
 * A tag carried by more than this share of the vault says nothing about which
 * notes belong together — `homelab` on a homelab vault is everywhere.
 */
const TAG_TOO_COMMON = 0.25;

/**
 * Clusters this small are fragments, not regions.
 *
 * Two plans of one project that link each other more strongly than either
 * links the project would otherwise be a region of their own beside it. A
 * fragment joins the cluster it is most strongly tied to — if it has any tie
 * outside itself; a pair nothing else links to stays a pair.
 */
const FRAGMENT = 2;

/** Equal within this counts as a tie: sums in another order must not decide. */
const EPSILON = 1e-9;

export function detectClusters(graph: Pick<BrainGraph, 'nodes' | 'edges'>, tags?: TagsByKey): Clustering {
  const { nodes, edges } = graph;
  const n = nodes.length;

  // Path hash, then the key itself for the one-in-four-billion collision.
  // Never the array index.
  const hashes = nodes.map((node) => hash32(node.key));
  const order = nodes.map((_, i) => i);
  order.sort((a, b) => hashes[a]! - hashes[b]! || (nodes[a]!.key < nodes[b]!.key ? -1 : 1));
  const rank = new Int32Array(n);
  order.forEach((node, r) => (rank[node] = r));

  // Links as an undirected neighbour map. A pair linked both ways counts twice:
  // a reference returned is a stronger tie than one made in passing.
  const links: Array<Map<number, number>> = nodes.map(() => new Map());
  for (const e of edges) {
    links[e.a]!.set(e.b, (links[e.a]!.get(e.b) ?? 0) + 1);
    links[e.b]!.set(e.a, (links[e.b]!.get(e.a) ?? 0) + 1);
  }

  // Only the tags that can tell notes apart.
  const tagsOf: Array<Set<string>> = nodes.map((node) => new Set(tags?.get(node.key) ?? []));
  const tagCount = new Map<string, number>();
  for (const set of tagsOf) for (const tag of set) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
  const tooCommon = Math.max(2, n * TAG_TOO_COMMON);

  /**
   * How closely two linked notes are bound. Symmetric, which is what keeps the
   * choices from running in circles.
   *
   * Shared neighbours count most: two notes that link each other *and* the
   * same three others are part of one thing, while a link between two
   * otherwise unrelated notes is a reference across. Divided by the geometric
   * mean of both degrees, so a map of content that links forty notes is
   * nobody's strongest tie — linking everything is precisely what says nothing
   * about any one.
   */
  const tie = (i: number, j: number): number => {
    const [small, large] = links[i]!.size < links[j]!.size ? [links[i]!, links[j]!] : [links[j]!, links[i]!];
    let shared = 0;
    for (const k of small.keys()) if (large.has(k)) shared += 1;
    let sharedTags = 0;
    for (const tag of tagsOf[i]!) if (tagsOf[j]!.has(tag) && tagCount.get(tag)! <= tooCommon) sharedTags += 1;
    const sameFolder = nodes[i]!.owner === nodes[j]!.owner && nodes[i]!.folder === nodes[j]!.folder;
    const bonus = 1 + (sameFolder ? SAME_FOLDER : 0) + PER_SHARED_TAG * sharedTags;
    return (links[i]!.get(j)! * (1 + shared) * bonus) / Math.sqrt(links[i]!.size * links[j]!.size);
  };

  /** Whether `t` to a note of hash rank `r` beats the best so far. */
  const beats = (t: number, r: number, best: number, bestRank: number): boolean =>
    bestRank === -1 || t > best + EPSILON || (t >= best - EPSILON && r < bestRank);

  // Every linked note's strongest tie.
  const choice = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i += 1) {
    let best = 0;
    for (const j of links[i]!.keys()) {
      const t = tie(i, j);
      if (beats(t, rank[j]!, best, choice[i] === -1 ? -1 : rank[choice[i]!]!)) {
        choice[i] = j;
        best = t;
      }
    }
  }

  // A note that far more notes lean on than lean on its own choice stays where
  // it is. Otherwise a map of content whose forty entries all choose it would
  // carry all forty along into whatever cluster its own strongest tie happens
  // to be in — which is how a folder of service notes ends up inside a
  // three-note project. "Far more" is three times as many plus one, not simply
  // more: a capture adds a follower, and a rule that flips on a difference of
  // one would move a hub and everything behind it for a single new note.
  const followers = new Int32Array(n);
  for (const c of choice) if (c !== -1) followers[c] = followers[c]! + 1;
  for (let i = 0; i < n; i += 1) {
    if (choice[i] !== -1 && followers[i]! >= 3 * (followers[choice[i]!]! + 1)) choice[i] = -1;
  }

  // Follow the choices to the end of each chain: a note that stayed, or a pair
  // that chose each other. That pair's member first in hash order names the
  // cluster.
  const label = new Int32Array(n).fill(-1);
  for (const start of order) {
    const path: number[] = [];
    const onPath = new Set<number>();
    let at = start;
    while (label[at] === -1 && choice[at] !== -1 && !onPath.has(at)) {
      onPath.add(at);
      path.push(at);
      at = choice[at]!;
    }
    let found = label[at]!;
    if (found === -1) {
      // A note with no links, or the chain closed on itself at `at`.
      found = at;
      if (onPath.has(at)) {
        for (let k = choice[at]!; k !== at; k = choice[k]!) if (rank[k]! < rank[found]!) found = k;
      }
    }
    for (const k of path) label[k] = found;
    label[at] = found;
  }

  const size = new Map<number, number>();
  for (let i = 0; i < n; i += 1) size.set(label[i]!, (size.get(label[i]!) ?? 0) + 1);

  // Fragments join their strongest tie outside themselves. Judged against the
  // clusters as they stood before any fragment moved, so that two fragments
  // cannot chain into each other and the order of the moves cannot matter.
  const joins = new Map<number, { to: number; tie: number }>();
  for (let i = 0; i < n; i += 1) {
    const own = label[i]!;
    if (size.get(own)! > FRAGMENT) continue;
    for (const j of links[i]!.keys()) {
      const other = label[j]!;
      if (other === own || size.get(other)! <= FRAGMENT) continue;
      const t = tie(i, j);
      const best = joins.get(own);
      if (beats(t, rank[other]!, best?.tie ?? 0, best === undefined ? -1 : rank[best.to]!)) {
        joins.set(own, { to: other, tie: t });
      }
    }
  }
  for (let i = 0; i < n; i += 1) {
    const join = joins.get(label[i]!);
    if (join !== undefined) label[i] = join.to;
  }

  // A note nothing links to has no tie at all. It still belongs somewhere, and
  // the nearest thing it has in common with other notes is its folder — or,
  // if nothing in that folder is linked either, the folder above.
  for (const i of order) {
    if (links[i]!.size > 0) continue;
    const node = nodes[i]!;
    let folder = node.folder;
    for (;;) {
      const counts = new Map<number, number>();
      for (let j = 0; j < n; j += 1) {
        if (links[j]!.size === 0 || nodes[j]!.owner !== node.owner) continue;
        const f = nodes[j]!.folder;
        if (f === folder || (folder !== '' && f.startsWith(`${folder}/`))) {
          counts.set(label[j]!, (counts.get(label[j]!) ?? 0) + 1);
        }
      }
      let pick = -1;
      for (const [l, c] of counts) {
        if (pick === -1 || c > counts.get(pick)! || (c === counts.get(pick)! && rank[l]! < rank[pick]!)) pick = l;
      }
      if (pick !== -1) {
        label[i] = pick;
        break;
      }
      // Not up to the vault root: a note there shares nothing with the rest
      // but being in the vault, and a region of its own is the honest answer.
      if (!folder.includes('/')) break;
      folder = folder.slice(0, folder.lastIndexOf('/'));
    }
  }

  return assemble(nodes, label, rank, order, tags);
}

function assemble(
  nodes: BrainGraph['nodes'],
  label: Int32Array,
  rank: Int32Array,
  order: number[],
  tags: TagsByKey | undefined,
): Clustering {
  const byLabel = new Map<number, number[]>();
  for (const i of order) {
    const list = byLabel.get(label[i]!);
    if (list === undefined) byLabel.set(label[i]!, [i]);
    else list.push(i);
  }
  // Members are in hash order already, so the first one is the identity.
  const groups = [...byLabel.values()].sort((a, b) => rank[a[0]!]! - rank[b[0]!]!);

  const of = new Int32Array(nodes.length);
  const clusters: Cluster[] = groups.map((members, c) => {
    for (const i of members) of[i] = c;
    const folder = dominant(members.map((i) => nodes[i]!.folder));
    return { id: nodes[members[0]!]!.key, members, folder: folder.value, name: baseName(members, folder, nodes, tags) };
  });

  // Two clusters from the same folder would otherwise share a name — the flat
  // project folder holds several unrelated projects. The most connected note
  // is what somebody would call the cluster anyway.
  const seen = new Map<string, number>();
  for (const c of clusters) seen.set(c.name, (seen.get(c.name) ?? 0) + 1);
  for (const c of clusters) {
    if (seen.get(c.name)! < 2) continue;
    c.name = `${c.name} · ${nodes[hubOf(c.members, nodes)]!.title}`;
  }

  return { of, clusters };
}

/** The most connected member; the first in hash order among equals. */
function hubOf(members: number[], nodes: BrainGraph['nodes']): number {
  let hub = members[0]!;
  for (const i of members) if (nodes[i]!.degree > nodes[hub]!.degree) hub = i;
  return hub;
}

function dominant(values: string[]): { value: string; share: number } {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let value = '';
  let best = -1;
  for (const [v, c] of counts) {
    // Ties by spelling, so the answer does not depend on which member came first.
    if (c > best || (c === best && v < value)) {
      value = v;
      best = c;
    }
  }
  return { value, share: values.length === 0 ? 0 : best / values.length };
}

function baseName(
  members: number[],
  folder: { value: string; share: number },
  nodes: BrainGraph['nodes'],
  tags: TagsByKey | undefined,
): string {
  const segment = folder.value.slice(folder.value.lastIndexOf('/') + 1);
  if (folder.share >= 0.5 && segment !== '') return segment;

  // No folder holds most of it: the tags most members share, if any do.
  const counts = new Map<string, number>();
  for (const i of members) {
    for (const tag of new Set(tags?.get(nodes[i]!.key) ?? [])) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const shared = [...counts]
    .filter(([, c]) => c / members.length >= 0.5)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 2)
    .map(([tag]) => tag);
  if (shared.length > 0) return shared.join(' · ');
  if (segment !== '') return segment;
  return nodes[hubOf(members, nodes)]!.title;
}
