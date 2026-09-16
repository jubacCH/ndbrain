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
  /**
   * The note the cluster's choices lead to: of the two notes that chose each
   * other, the one first in hash order, or the note that stayed put. The most
   * settled part of a cluster — a new note joining changes its members and
   * often its `id`, rarely its core — which is why the layout places a region
   * by it.
   */
  core: string;
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
  /**
   * The tags this clustering was built from, carried along.
   *
   * Regions are named from tags too (`groupRegions`), and they are formed in the
   * layout, which never sees the server's reply. Passing them on here rather
   * than through a second parameter on the layout keeps the one place that knows
   * about tags the one place that asked for them.
   */
  tags?: TagsByKey | undefined;
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
  //
  // Counted once up front, per folder and every folder above it, rather than
  // by scanning the vault for each such note: with many unlinked notes that
  // scan was quadratic. The labels counted are those of linked notes, which
  // this pass does not change.
  const byFolder = new Map<string, Map<number, number>>();
  const tally = (key: string, l: number): void => {
    let counts = byFolder.get(key);
    if (counts === undefined) byFolder.set(key, (counts = new Map()));
    counts.set(l, (counts.get(l) ?? 0) + 1);
  };
  for (let j = 0; j < n; j += 1) {
    if (links[j]!.size === 0) continue;
    const { owner, folder } = nodes[j]!;
    tally(`${owner}\u0000${folder}`, label[j]!);
    for (let cut = folder.lastIndexOf('/'); cut > 0; cut = folder.lastIndexOf('/', cut - 1)) {
      tally(`${owner}\u0000${folder.slice(0, cut)}`, label[j]!);
    }
  }
  for (const i of order) {
    if (links[i]!.size > 0) continue;
    const node = nodes[i]!;
    let folder = node.folder;
    for (;;) {
      const counts = byFolder.get(`${node.owner}\u0000${folder}`);
      let pick = -1;
      for (const [l, c] of counts ?? []) {
        if (pick === -1 || c > counts!.get(pick)! || (c === counts!.get(pick)! && rank[l]! < rank[pick]!)) pick = l;
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
  const groups = [...byLabel.entries()].sort((a, b) => rank[a[1][0]!]! - rank[b[1][0]!]!);

  const of = new Int32Array(nodes.length);
  const clusters: Cluster[] = groups.map(([root, members], c) => {
    for (const i of members) of[i] = c;
    const folder = dominant(members.map((i) => nodes[i]!.folder));
    return {
      id: nodes[members[0]!]!.key,
      core: nodes[root]!.key,
      members,
      folder: folder.value,
      name: baseName(members, folder, nodes, tags),
    };
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

  return { of, clusters, tags };
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

// ---------------------------------------------------------------------------
// Regions: the clusters gathered into seven to nine cells of the silhouette.
// ---------------------------------------------------------------------------

/**
 * A region: the clusters that share one cell of the outline.
 *
 * Strongest-tie clustering answers "which notes belong together" well and gives
 * twenty groups for a hundred notes. That is the right answer to that question
 * and the wrong number of cells: twenty cells over two hemispheres are small,
 * thin and mostly empty, and twenty labels round the rim are unreadable. The
 * optics prototype showed that the picture wants **seven to nine regions of a
 * similar size**, one per part of the vault somebody would actually name.
 *
 * So the clusters are gathered by the folder group most of their members sit in
 * (`10_Projects/11_Active`, `20_Areas/21_Homelab`, …), groups too small to be a
 * region of their own join the group they link to most, and a group well over
 * twenty notes is cut in two.
 *
 * **The cut runs between clusters, never through one.** The prototype bisected a
 * group's notes and split at the median, and a single captured note then tipped
 * a note on the boundary into the other half — which in this engine means a note
 * changing region, and with it the cell it is clamped to. Clusters are the
 * stable unit: a capture changes at most the cluster it joins, and a cluster
 * moves as a whole or not at all.
 */
export interface RegionGroup {
  /**
   * A stable identity: the folder group, and the id of the cluster of it that
   * comes first in hash order. Not an index — a region added before it would
   * shift that.
   */
  id: string;
  /** Display name, already user-facing. */
  name: string;
  /**
   * The folder group this came from, and which half of it, or -1 when the group
   * was not cut in two.
   *
   * The layout deals hemispheres by this rather than by the region: a folder
   * group is a stable thing — a capture changes its note count by one and its
   * identity never — while a region gains and loses clusters. The two halves of
   * a cut group go to opposite hemispheres, which balances the halves without
   * anything having to be counted.
   */
  group: string;
  half: number;
  /** Cluster indices into `Clustering.clusters`. */
  clusters: number[];
  /** Node indices, in hash order. */
  members: number[];
}

export interface RegionGrouping {
  /** Region index per node index. */
  of: Int32Array;
  /** Ordered by the hash rank of their `id`, so the order is stable too. */
  regions: RegionGroup[];
}

/**
 * A region with fewer notes than this is a fragment beside regions of twenty,
 * and joins the group it links to most; a cut that would leave a half this
 * small is not made.
 *
 * Eight rather than the five it started at. A region of five is a cell of the
 * silhouette with one small knot in it, and next to its neighbours it reads as
 * empty — "Tech Knowledge" with five notes did, in the first integrated build.
 */
const MERGE_BELOW = 8;
/** A group well over this is cut in two. The prototype's number. */
const SPLIT_ABOVE = 20;
/** Where a cut group's first half ends, as a share of its notes. */
const CUT_AT = 0.375;
/** Never more cells than this: past nine the labels stop fitting round the rim. */
const MAX_REGIONS = 9;
/**
 * A region that holds this much of a top-level folder is named after that
 * folder rather than after the subfolder most of it sits in.
 *
 * `10_Projects/11_Active` is where a PARA vault files its projects, but nobody
 * calls that part of their vault "Active" — they call it "Projects". A region
 * that holds nearly all of `10_Projects` is that folder; one that holds half of
 * `20_Areas` is not "Areas", it is "Homelab".
 */
const TOP_FOLDER_SHARE = 0.8;
/** A tag names half of a split group only with this many carriers and this much of a lead. */
const NAME_TAG_CARRIERS = 3;
const NAME_TAG_LEAD = 0.2;

/** The owner and the first two folder segments: the unit regions are grouped by. */
function folderGroup(node: BrainGraph['nodes'][number]): { top: string; group: string } {
  const parts = node.folder === '' ? [] : node.folder.split('/');
  const top = `${node.owner}\u0000${parts[0] ?? ''}`;
  return { top, group: `${top}\u0000${parts[1] ?? ''}` };
}

/** `22_Selfhosted-Services` → `Selfhosted Services`. The ordering prefix is not a name. */
function prettyFolder(segment: string): string {
  return segment
    .replace(/^\d+[_-]/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

/** `ai` → `AI`, `homelab` → `Homelab`. Short tags are acronyms far more often than words. */
function prettyTag(tag: string): string {
  return tag.length <= 3 ? tag.toUpperCase() : tag[0]!.toUpperCase() + tag.slice(1);
}

interface Draft {
  key: string;
  /** Which half of a cut group, or -1 for a group that was not cut. */
  half: number;
  clusters: number[];
  notes: number;
  name: string;
  /**
   * Whether the name is a top-level folder's ("Projects") rather than a
   * subfolder's ("Homelab"). A top-level name is a kind of note, a subfolder's a
   * topic, and the half of a cut group is named differently for each.
   */
  kind: 'kind' | 'topic';
}

export function groupRegions(
  graph: Pick<BrainGraph, 'nodes' | 'edges'>,
  clustering: Clustering,
  tags: TagsByKey | undefined = clustering.tags,
): RegionGrouping {
  const { nodes, edges } = graph;
  const { clusters, of } = clustering;
  const regionOf = new Int32Array(nodes.length);
  if (clusters.length === 0) return { of: regionOf, regions: [] };

  // Stable order over the clusters: the hash of the identity, never the index.
  const rank = new Int32Array(clusters.length);
  [...clusters.keys()]
    .sort((a, b) => hash32(clusters[a]!.id) - hash32(clusters[b]!.id) || (clusters[a]!.id < clusters[b]!.id ? -1 : 1))
    .forEach((c, r) => (rank[c] = r));

  const pairKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const between = new Map<string, number>();
  for (const e of edges) {
    const ca = of[e.a]!;
    const cb = of[e.b]!;
    if (ca === cb) continue;
    const key = pairKey(ca, cb);
    between.set(key, (between.get(key) ?? 0) + 1);
  }
  const linksBetween = (a: readonly number[], b: readonly number[]): number => {
    let sum = 0;
    for (const p of a) for (const q of b) sum += between.get(pairKey(p, q)) ?? 0;
    return sum;
  };

  const place = nodes.map(folderGroup);
  const topTotals = new Map<string, number>();
  for (const p of place) topTotals.set(p.top, (topTotals.get(p.top) ?? 0) + 1);

  // One draft region per folder group, in key order so nothing depends on the
  // order the clusters came in.
  const byGroup = new Map<string, number[]>();
  clusters.forEach((cluster, c) => {
    const key = dominant(cluster.members.map((i) => place[i]!.group)).value;
    const list = byGroup.get(key);
    if (list === undefined) byGroup.set(key, [c]);
    else list.push(c);
  });
  let drafts: Draft[] = [...byGroup.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, list]) => ({
      key,
      half: -1,
      clusters: list,
      notes: list.reduce((sum, c) => sum + clusters[c]!.members.length, 0),
      name: '',
      kind: 'topic' as const,
    }));

  // Fragments join the group they link to most; a sibling under the same
  // top-level folder wins a tie, because that is the group whose name will
  // still be honest once the fragment is inside it.
  const topOf = (key: string): string => key.slice(0, key.lastIndexOf('\u0000'));
  for (;;) {
    if (drafts.length < 2) break;
    let small = -1;
    drafts.forEach((d, i) => {
      if (d.notes >= MERGE_BELOW) return;
      const best = small === -1 ? null : drafts[small]!;
      if (best === null || d.notes < best.notes || (d.notes === best.notes && d.key < best.key)) small = i;
    });
    if (small === -1) break;
    const source = drafts[small]!;
    let target: Draft | null = null;
    let bestLinks = -1;
    let bestSibling = false;
    for (const d of drafts) {
      if (d === source) continue;
      const links = linksBetween(source.clusters, d.clusters);
      const sibling = topOf(d.key) === topOf(source.key);
      const better =
        target === null ||
        links > bestLinks ||
        (links === bestLinks && (sibling !== bestSibling ? sibling : d.key < target.key));
      if (better) {
        target = d;
        bestLinks = links;
        bestSibling = sibling;
      }
    }
    target!.clusters.push(...source.clusters);
    target!.notes += source.notes;
    drafts.splice(small, 1);
  }

  // Named before the cut: the group's name is what a half falls back to, and
  // what a half's own name must not collide with.
  for (const draft of drafts) Object.assign(draft, groupName(draft, clusters, nodes, place, topTotals));
  const taken = new Set(drafts.map((draft) => draft.name.toLowerCase()));

  // One cut per group, never a cut of a cut. Splitting a half again would let a
  // group of forty end up as one region of twenty-three and four of four, and
  // it would compound the names: "Services: Homelab: Homelab".
  const memberKeys = (list: readonly number[]): string[] =>
    list.flatMap((c) => clusters[c]!.members).map((i) => nodes[i]!.key);
  const room = (): number => MAX_REGIONS - drafts.length;
  const oversized = drafts
    .map((draft, i) => ({ draft, i }))
    .filter(({ draft }) => draft.notes > SPLIT_ABOVE && draft.clusters.length > 1)
    .sort((a, b) => b.draft.notes - a.draft.notes || (a.draft.key < b.draft.key ? -1 : 1));
  const cut = new Map<Draft, Draft[]>();
  for (const { draft } of oversized) {
    if (room() - cut.size < 1) break;
    const [first, second] = splitAlongClusters(draft.clusters, clusters, between, pairKey);
    const notesIn = (list: number[]): number => list.reduce((sum, c) => sum + clusters[c]!.members.length, 0);
    if (first.length === 0 || second.length === 0) continue;
    if (Math.min(notesIn(first), notesIn(second)) < MERGE_BELOW) continue;
    const halves: Draft[] = [first, second].map((list, k) => ({
      key: draft.key,
      half: k,
      clusters: list,
      notes: notesIn(list),
      name: draft.name,
      kind: draft.kind,
    }));
    halves.forEach((half, k) => {
      const tag = distinguishingTag(memberKeys(half.clusters), memberKeys(halves[1 - k]!.clusters), tags);
      if (tag !== null) half.name = halfName(draft, prettyTag(tag), taken);
    });
    cut.set(draft, halves);
  }
  drafts = drafts.flatMap((draft) => cut.get(draft) ?? [draft]);

  const hashOf = new Map<number, number>();
  for (let i = 0; i < nodes.length; i += 1) hashOf.set(i, hash32(nodes[i]!.key));
  const regions: RegionGroup[] = drafts.map((draft) => {
    // The identity is the group plus the *core* of its largest cluster.
    //
    // Both halves of that matter. The largest cluster rather than the first in
    // hash order, because a captured note that opens a new cluster has a one in
    // eight chance of coming first and would rename the region. And the core
    // rather than the cluster's `id`, because the id is the first member in hash
    // order and a note joining a cluster of four has a one in five chance of
    // displacing it, while the core — the pair of notes the cluster's choices
    // lead to — rarely moves at all. The layout seeds both the region's place on
    // the ring of its hemisphere and the sample its places come from with this,
    // so a region that changed identity re-draws every place in itself.
    let first = draft.clusters[0]!;
    for (const c of draft.clusters) {
      const bigger = clusters[c]!.members.length > clusters[first]!.members.length;
      const same = clusters[c]!.members.length === clusters[first]!.members.length;
      if (bigger || (same && clusters[c]!.core < clusters[first]!.core)) first = c;
    }
    const members = draft.clusters
      .flatMap((c) => clusters[c]!.members)
      .sort((a, b) => hashOf.get(a)! - hashOf.get(b)! || (nodes[a]!.key < nodes[b]!.key ? -1 : 1));
    return {
      id: `${draft.key}\u0000${clusters[first]!.core}`,
      name: draft.name,
      group: draft.key,
      half: draft.half,
      clusters: draft.clusters,
      members,
    };
  });
  regions.sort((a, b) => hash32(a.id) - hash32(b.id) || (a.id < b.id ? -1 : 1));
  regions.forEach((region, r) => {
    for (const i of region.members) regionOf[i] = r;
  });
  return { of: regionOf, regions };
}

/**
 * A name for the group, from the folders its notes are filed in.
 *
 * The top-level folder when the group holds nearly all of it, the subfolder most
 * of it sits in otherwise, and the title of its busiest note when the vault has
 * no folders at all.
 */
function groupName(
  draft: Draft,
  clusters: Cluster[],
  nodes: BrainGraph['nodes'],
  place: Array<{ top: string; group: string }>,
  topTotals: Map<string, number>,
): { name: string; kind: 'kind' | 'topic' } {
  const members = draft.clusters.flatMap((c) => clusters[c]!.members);
  const top = dominant(members.map((i) => place[i]!.top)).value;
  const held = members.filter((i) => place[i]!.top === top).length;
  const topName = prettyFolder(top.slice(top.indexOf('\u0000') + 1));
  if (topName !== '' && held / (topTotals.get(top) ?? held) >= TOP_FOLDER_SHARE) return { name: topName, kind: 'kind' };
  const sub = dominant(members.filter((i) => place[i]!.top === top).map((i) => place[i]!.group)).value;
  const subName = prettyFolder(sub.slice(sub.lastIndexOf('\u0000') + 1));
  if (subName !== '') return { name: subName, kind: 'topic' };
  if (topName !== '') return { name: topName, kind: 'kind' };
  return { name: nodes[hubOf(members, nodes)]!.title, kind: 'topic' };
}

/**
 * What to call the half of a cut group that a tag tells apart: a name that
 * stands on its own, without the "Group: tag" pattern of a file system.
 *
 *  - The half of a *topic* is named after its tag alone. The halves of
 *    "Homelab" are "Proxmox" and "Networking"; nobody needs to be told those are
 *    homelab things.
 *  - The half of a *kind* of note names the tag and the kind: "AI Projects",
 *    "Homelab Projects". "AI" alone does not say what is in the cell.
 *  - So does a short acronym, for the same reason: "AI Services", not "AI".
 *  - A tag that is already the name of another region cannot stand alone —
 *    "Homelab" next to "Homelab" says two different things with one word — so it
 *    names the kind of note too, with the group's last word: "Homelab Services".
 */
function halfName(group: Draft, tag: string, taken: ReadonlySet<string>): string {
  const words = group.name.split(/\s+/);
  const noun = words[words.length - 1]!;
  // An acronym of two or three letters is a qualifier, not a name: "AI" alone
  // does not say what is in the cell, "AI Services" does.
  if (group.kind === 'kind' || tag.length <= 3 || taken.has(tag.toLowerCase())) return `${tag} ${noun}`;
  return tag;
}

/**
 * Cuts a group's clusters in two.
 *
 * Two seeds first — the largest cluster, and the largest one it does not link
 * to — then the clusters are laid out on a line by how much more they link to
 * the first seed than to the second, and the line is cut where the two halves
 * come out most evenly.
 *
 * **This is a median split, at cluster granularity on purpose.** The optics
 * prototype split a group's *notes* at the median of a spectral vector, and a
 * single captured note tipped a note on the boundary into the other half.
 * Clusters do not have boundary notes: a capture changes the size of one
 * cluster by one and can move the cut past at most that one cluster, so the
 * notes that change region are the members of a single cluster rather than
 * whoever happened to sit near the middle.
 */
function splitAlongClusters(
  list: number[],
  clusters: Cluster[],
  between: Map<string, number>,
  pairKey: (a: number, b: number) => string,
): [number[], number[]] {
  const size = (c: number): number => clusters[c]!.members.length;
  // Ordered by the clusters' cores, not by their hash ranks. A rank is a
  // position among all the vault's clusters, so a capture that changed one
  // cluster's identity anywhere shifted the ranks here and flipped a tie — and
  // the two halves of this group then changed hemispheres for a note that had
  // nothing to do with either. A core is the cluster's own and stays put.
  const byRank = [...list].sort((a, b) => (clusters[a]!.core < clusters[b]!.core ? -1 : 1));
  let seedA = byRank[0]!;
  for (const c of byRank) if (size(c) > size(seedA)) seedA = c;
  let seedB = -1;
  for (const c of byRank) {
    if (c === seedA) continue;
    if (seedB === -1) {
      seedB = c;
      continue;
    }
    const links = between.get(pairKey(seedA, c)) ?? 0;
    const best = between.get(pairKey(seedA, seedB)) ?? 0;
    if (links < best || (links === best && size(c) > size(seedB))) seedB = c;
  }
  if (seedB === -1) return [list, []];

  const affinity = (c: number): number =>
    (between.get(pairKey(c, seedA)) ?? 0) - (between.get(pairKey(c, seedB)) ?? 0);
  // Ties by hash rank and by nothing else. Ordering equally-linked clusters by
  // size instead would reshuffle the line whenever a capture made one cluster
  // one note bigger than its neighbour, and the cut would then fall somewhere
  // quite different; the rank of a cluster changes only when its identity does.
  const order = byRank
    .filter((c) => c !== seedA && c !== seedB)
    .sort((a, b) => affinity(b) - affinity(a) || (clusters[a]!.core < clusters[b]!.core ? -1 : 1));
  order.unshift(seedA);
  order.push(seedB);

  // The cut goes after the first cluster that brings the first half to three
  // eighths of the notes — not at the most even point. The most even point is
  // exactly where one more note tips the balance: a capture anywhere in the
  // group moved it past a two-note cluster for one in six captures on the real
  // vault. A threshold only moves when the running count crosses it, and it
  // still leaves both halves between three and five eighths.
  const total = order.reduce((sum, c) => sum + size(c), 0);
  let running = 0;
  let cut = order.length - 1;
  for (let k = 1; k < order.length; k += 1) {
    running += size(order[k - 1]!);
    if (running >= total * CUT_AT) {
      cut = k;
      break;
    }
  }
  return [order.slice(0, cut), order.slice(cut)];
}

/**
 * The tag that tells one half of a split group from the other, or null.
 *
 * The prototype's rule: at least three carriers, and a share at least 0.2 higher
 * than in the other half. The most common such tag wins, not the rarest — a name
 * is what somebody would say about the half, and nobody names a region after the
 * one tag three notes happen to share.
 */
function distinguishingTag(part: string[], other: string[], tags: TagsByKey | undefined): string | null {
  if (tags === undefined || part.length === 0 || other.length === 0) return null;
  const count = (keys: string[]): Map<string, number> => {
    const out = new Map<string, number>();
    for (const key of keys) for (const tag of new Set(tags.get(key) ?? [])) out.set(tag, (out.get(tag) ?? 0) + 1);
    return out;
  };
  const mine = count(part);
  const theirs = count(other);
  let best: string | null = null;
  let bestCarriers = 0;
  let bestLead = 0;
  for (const [tag, carriers] of mine) {
    const lead = carriers / part.length - (theirs.get(tag) ?? 0) / other.length;
    if (carriers < NAME_TAG_CARRIERS || lead < NAME_TAG_LEAD) continue;
    const better =
      best === null ||
      carriers > bestCarriers ||
      (carriers === bestCarriers && (lead > bestLead || (lead === bestLead && tag < best)));
    if (better) {
      best = tag;
      bestCarriers = carriers;
      bestLead = lead;
    }
  }
  return best;
}
