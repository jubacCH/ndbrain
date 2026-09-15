// @vitest-environment node
/**
 * Clusters from the vault's structure.
 *
 * Three promises, and each has a way of being quietly broken:
 *
 *  - **Deterministic.** Label propagation is random by design; this one must
 *    not be. The server's listing order is the easiest thing to depend on by
 *    accident, so every check here also runs on a shuffled reply.
 *  - **Stable.** Capturing one note and linking it must not reassign the notes
 *    that were already there. A cluster that renames itself is harmless; one
 *    that swaps members moves them across the brain.
 *  - **Sensible.** Links count most, a map of content does not swallow what it
 *    lists, and a note linked to nothing still lands with its folder.
 */

import { describe, expect, it } from 'vitest';

import type { GraphData } from '../src/api';
import type { BrainGraph } from '../src/brain/model';
import { buildGraph, nodeKey } from '../src/brain/model';
import { paraVault, shuffled } from './fixtures/para-vault';

/** Which keys share a cluster, as a canonical set of sorted groups. */
function partition(g: BrainGraph, keep: (key: string) => boolean = () => true): string[] {
  return g.clusters.clusters
    .map((c) => c.members.map((i) => g.nodes[i]!.key).filter(keep).sort().join('|'))
    .filter((s) => s !== '')
    .sort();
}

const clusterOf = (g: BrainGraph, path: string): string =>
  g.clusters.clusters[g.clusters.of[g.index.get(nodeKey('jb', path))!]!]!.id;

function star(folder: string, hub: string, leaves: string[]): GraphData {
  const nodes = [hub, ...leaves].map((name) => ({
    owner: 'jb',
    path: `${folder}/${name}.md`,
    title: name,
    folder,
    links: 0,
  }));
  return {
    nodes,
    edges: leaves.flatMap((leaf) => [
      { owner: 'jb', from: `${folder}/${hub}.md`, to: `${folder}/${leaf}.md` },
      { owner: 'jb', from: `${folder}/${leaf}.md`, to: `${folder}/${hub}.md` },
    ]),
  };
}

/** The vault plus one new note in an inbox, linked to `target`. */
function captured(data: GraphData, target: string): GraphData {
  return {
    nodes: [...data.nodes, { owner: 'jb', path: '00_Inbox/captured.md', title: 'captured', folder: '00_Inbox', links: 1 }],
    edges: [...data.edges, { owner: 'jb', from: '00_Inbox/captured.md', to: target }],
  };
}

/**
 * How many of the notes in `before` ended up in a different cluster.
 *
 * Cluster identities may legitimately change, so each new cluster is matched
 * to the old cluster most of its members came from; a note counts as moved
 * when its new cluster is matched to a cluster it was not in.
 */
function reassigned(before: BrainGraph, after: BrainGraph): number {
  const keys = before.nodes.map((n) => n.key);
  const was = (k: string): number => before.clusters.of[before.index.get(k)!]!;
  const now = (k: string): number => after.clusters.of[after.index.get(k)!]!;
  const origins = new Map<number, Map<number, number>>();
  for (const k of keys) {
    const tally = origins.get(now(k)) ?? new Map<number, number>();
    tally.set(was(k), (tally.get(was(k)) ?? 0) + 1);
    origins.set(now(k), tally);
  }
  const matched = new Map<number, number>();
  for (const [cluster, tally] of origins) {
    matched.set(cluster, [...tally].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0]);
  }
  return keys.filter((k) => matched.get(now(k)) !== was(k)).length;
}

function merge(...parts: GraphData[]): GraphData {
  return { nodes: parts.flatMap((p) => p.nodes), edges: parts.flatMap((p) => p.edges) };
}

describe('clusters', () => {
  it('finds the groups the links describe', () => {
    const g = buildGraph(merge(star('a', 'hub-a', ['a1', 'a2', 'a3']), star('b', 'hub-b', ['b1', 'b2', 'b3'])));
    expect(g.clusters.clusters).toHaveLength(2);
    expect(clusterOf(g, 'a/a1.md')).toBe(clusterOf(g, 'a/hub-a.md'));
    expect(clusterOf(g, 'a/a1.md')).not.toBe(clusterOf(g, 'b/b1.md'));
  });

  it('gives the same clusters, with the same identities, whatever order the server listed', () => {
    const { data, tags } = paraVault();
    for (const seed of [1, 2, 3]) {
      const a = buildGraph(data, { tags });
      const b = buildGraph(shuffled(data, seed), { tags });
      expect(partition(b)).toEqual(partition(a));
      expect(b.clusters.clusters.map((c) => [c.id, c.name])).toEqual(a.clusters.clusters.map((c) => [c.id, c.name]));
    }
  });

  it('does not let a map of content pull everything it lists into one cluster', () => {
    // Three maps of content — an index, its conflict copy and a home page — each
    // listing both stars. Counting their links at full weight makes them the
    // loudest voice in both stars, and the stars merge into one.
    const data = merge(star('a', 'hub-a', ['a1', 'a2', 'a3']), star('b', 'hub-b', ['b1', 'b2', 'b3']));
    for (const map of ['index', 'index copy', 'home']) {
      data.nodes.push({ owner: 'jb', path: `moc/${map}.md`, title: map, folder: 'moc', links: 0 });
      for (const target of ['a/hub-a', 'a/a1', 'a/a2', 'a/a3', 'b/hub-b', 'b/b1', 'b/b2', 'b/b3']) {
        data.edges.push({ owner: 'jb', from: `moc/${map}.md`, to: `${target}.md` });
      }
    }
    const g = buildGraph(data);
    expect(clusterOf(g, 'a/a1.md')).toBe(clusterOf(g, 'a/hub-a.md'));
    expect(clusterOf(g, 'b/b1.md')).toBe(clusterOf(g, 'b/hub-b.md'));
    expect(clusterOf(g, 'a/a1.md')).not.toBe(clusterOf(g, 'b/b1.md'));
  });

  it('prefers a particular tie to one with a note that links everything', () => {
    // `x` shares a neighbour with the index, which on raw counts makes the index
    // its strongest tie. But the index links thirty notes; `y` links only `x`.
    const data: GraphData = { nodes: [], edges: [] };
    const add = (path: string): void => {
      data.nodes.push({ owner: 'jb', path, title: path, folder: path.split('/')[0]!, links: 0 });
    };
    const both = (a: string, b: string): void => {
      data.edges.push({ owner: 'jb', from: a, to: b }, { owner: 'jb', from: b, to: a });
    };
    for (const path of ['p/x.md', 'p/y.md', 'q/z.md', 'moc/index.md']) add(path);
    both('p/x.md', 'p/y.md');
    both('p/x.md', 'moc/index.md');
    data.edges.push({ owner: 'jb', from: 'q/z.md', to: 'p/x.md' });
    both('q/z.md', 'moc/index.md');
    for (let i = 0; i < 28; i += 1) {
      add(`s/n${i}.md`);
      data.edges.push({ owner: 'jb', from: 'moc/index.md', to: `s/n${i}.md` });
    }
    const g = buildGraph(data);
    expect(clusterOf(g, 'p/x.md')).toBe(clusterOf(g, 'p/y.md'));
    expect(clusterOf(g, 'p/x.md')).not.toBe(clusterOf(g, 's/n0.md'));
  });

  it('puts a note linked to nothing with its folder, and failing that with the folder above', () => {
    const data = merge(star('p/active', 'hub', ['one', 'two']), star('q', 'other', ['x', 'y']));
    data.nodes.push({ owner: 'jb', path: 'p/active/lonely.md', title: 'lonely', folder: 'p/active', links: 0 });
    data.nodes.push({ owner: 'jb', path: 'p/archive/forgotten.md', title: 'forgotten', folder: 'p/archive', links: 0 });
    const g = buildGraph(data);
    expect(clusterOf(g, 'p/active/lonely.md')).toBe(clusterOf(g, 'p/active/hub.md'));
    expect(clusterOf(g, 'p/archive/forgotten.md')).toBe(clusterOf(g, 'p/active/hub.md'));
  });

  it('lets a shared tag decide between two otherwise equal links', () => {
    const data = merge(star('a', 'hub-a', ['a1', 'a2']), star('b', 'hub-b', ['b1', 'b2']));
    data.nodes.push({ owner: 'jb', path: 'c/bridge.md', title: 'bridge', folder: 'c', links: 0 });
    data.edges.push({ owner: 'jb', from: 'c/bridge.md', to: 'a/a1.md' });
    data.edges.push({ owner: 'jb', from: 'c/bridge.md', to: 'b/b1.md' });
    const key = (path: string): string => nodeKey('jb', path);
    for (const side of ['a', 'b']) {
      const tags = new Map([
        [key('c/bridge.md'), ['kiosk']],
        [key(`${side}/${side}1.md`), ['kiosk']],
      ]);
      const g = buildGraph(data, { tags });
      expect(clusterOf(g, 'c/bridge.md')).toBe(clusterOf(g, `${side}/hub-${side}.md`));
    }
  });

  it('keeps every existing assignment when one note is captured and linked', () => {
    // Briefing 47. The note is linked into the busiest part of the vault, where
    // a wobble would be likeliest to spread.
    const { data, tags } = paraVault();
    const before = buildGraph(data, { tags });
    const after = buildGraph(captured(data, '10_Projects/11_Active/Project A.md'), { tags });

    const old = new Set(data.nodes.map((n) => nodeKey(n.owner, n.path)));
    expect(partition(after, (k) => old.has(k))).toEqual(partition(before));
    const ids = (g: BrainGraph): string[] => g.clusters.clusters.map((c) => c.id).filter((id) => old.has(id)).sort();
    expect(ids(after)).toEqual(ids(before));
    expect(clusterOf(after, '00_Inbox/captured.md')).toBe(clusterOf(after, '10_Projects/11_Active/Project A.md'));
  });

  it('reassigns at most a handful of notes, whichever note the new one links to', () => {
    // One well-chosen case proves little, so every possible target is tried.
    // A new link can legitimately tip a note that was torn between two ties, so
    // the bar is not "never": it is that nine in ten captures leave every note
    // where it was, and that no capture moves more than five of the 109 — a
    // local rearrangement somebody can follow, where the label propagation this
    // replaced moved up to twenty-two.
    const { data, tags } = paraVault();
    const before = buildGraph(data, { tags });
    let untouched = 0;
    let worst = 0;
    for (const target of data.nodes) {
      const after = buildGraph(captured(data, target.path), { tags });
      const moved = reassigned(before, after);
      if (moved === 0) untouched += 1;
      worst = Math.max(worst, moved);
    }
    expect(untouched / data.nodes.length).toBeGreaterThanOrEqual(0.9);
    expect(worst).toBeLessThanOrEqual(5);
  });

  it('names a cluster after its folder, and tells same-folder clusters apart by their hub', () => {
    const data = merge(star('10_Projects/11_Active', 'Alpha', ['a1', 'a2']), star('10_Projects/11_Active', 'Beta', ['b1', 'b2']));
    data.nodes.forEach((n) => (n.links = n.title.length === 2 ? 1 : 2));
    data.nodes.push(...star('20_Areas/21_Homelab', 'Lab', ['l1']).nodes);
    data.edges.push(...star('20_Areas/21_Homelab', 'Lab', ['l1']).edges);
    const g = buildGraph(data);
    const names = g.clusters.clusters.map((c) => c.name).sort();
    expect(names).toEqual(['11_Active · Alpha', '11_Active · Beta', '21_Homelab']);
  });

  it('falls back to the tags most members share when no folder holds a majority', () => {
    const data: GraphData = {
      nodes: ['a/one', 'b/two', 'c/three'].map((p) => ({ owner: 'jb', path: `${p}.md`, title: p, folder: p.split('/')[0]!, links: 2 })),
      edges: [
        { owner: 'jb', from: 'a/one.md', to: 'b/two.md' },
        { owner: 'jb', from: 'b/two.md', to: 'c/three.md' },
        { owner: 'jb', from: 'c/three.md', to: 'a/one.md' },
      ],
    };
    const tags = new Map(['a/one', 'b/two', 'c/three'].map((p) => [nodeKey('jb', `${p}.md`), ['monitoring']]));
    expect(buildGraph(data, { tags }).clusters.clusters.map((c) => c.name)).toEqual(['monitoring']);
  });

  it('copes with an empty vault and a single note', () => {
    expect(buildGraph({ nodes: [], edges: [] }).clusters.clusters).toEqual([]);
    const one = buildGraph({ nodes: [{ owner: 'jb', path: 'x.md', title: 'x', folder: '', links: 0 }], edges: [] });
    expect(one.clusters.clusters).toHaveLength(1);
    expect(one.clusters.clusters[0]!.name).toBe('x');
  });
});
