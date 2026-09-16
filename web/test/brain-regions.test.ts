// @vitest-environment node
/**
 * Regions: the clusters gathered into the cells of the silhouette.
 *
 * Phase 4 put a layer between the clusters and the picture. Strongest-tie
 * clustering answers "which notes belong together" and gives about twenty groups
 * for a hundred notes; the picture wants seven to nine cells of a similar size,
 * one per part of the vault somebody would name. These measure that the layer
 * does that, that the names are ones a person would say, and — the point of
 * building it this way at all — that a captured note moves at most one cluster
 * of notes into another region, because the cut between two regions runs
 * between clusters rather than through one.
 */

import { describe, expect, it } from 'vitest';

import { groupRegions } from '../src/brain/clusters';
import { buildGraph } from '../src/brain/model';
import { paraVault } from './fixtures/para-vault';

describe('regions', () => {
  const { data, tags } = paraVault();
  const graph = buildGraph(data, { tags });
  const grouping = groupRegions(graph, graph.clusters);

  it('gathers many clusters into seven to nine regions of a similar size', () => {
    // The number the optics prototype settled on. Twenty clusters give twenty
    // cells, which over two hemispheres are thin, mostly empty, and carry
    // twenty labels nobody can read.
    expect(graph.clusters.clusters.length).toBeGreaterThan(12);
    expect(grouping.regions.length).toBeGreaterThanOrEqual(7);
    expect(grouping.regions.length).toBeLessThanOrEqual(9);

    const sizes = grouping.regions.map((r) => r.members.length).sort((a, b) => a - b);
    // Every note in exactly one region.
    expect(sizes.reduce((sum, n) => sum + n, 0)).toBe(graph.nodes.length);
    // None a fragment, and the largest no more than four times the smallest.
    // Measured on this vault: 6 to 23.
    expect(sizes[0]!).toBeGreaterThanOrEqual(5);
    expect(sizes[sizes.length - 1]! / sizes[0]!).toBeLessThanOrEqual(4);
  });

  it('names a region after the folder its notes are filed in', () => {
    const names = grouping.regions.map((r) => r.name);
    // The folder part of the name, without any tag a cut group's half added.
    const base = names.map((n) => n.split(':')[0]!.trim());
    // "Projects" for the region that holds nearly all of `10_Projects`, the
    // subfolder's name where a region holds only part of a top-level folder.
    // Never the ordering prefix; and never "Active", because nobody calls the
    // part of their vault where the projects live "Active".
    expect(base).toContain('Projects');
    expect(base).toContain('Homelab');
    for (const name of base) {
      expect(name).not.toBe('');
      expect(/^\d/.test(name)).toBe(false);
      expect(name).not.toBe('Active');
      expect(name).not.toBe('Areas');
    }
  });

  it('gives both halves of a cut group the group name, adding a tag only where one tells them apart', () => {
    const halves = grouping.regions.filter((r) => r.half >= 0);
    expect(halves.length).toBeGreaterThanOrEqual(4);
    for (const half of halves) {
      const sibling = halves.find((other) => other !== half && other.group === half.group);
      expect(sibling, half.name).toBeDefined();
      const base = half.name.split(':')[0]!.trim();
      expect(sibling!.name.split(':')[0]!.trim()).toBe(base);
      // Either the group's name twice — the prototype's answer where no tag
      // sets the halves apart — or the group's name and one tag.
      if (half.name !== base) expect(half.name.startsWith(`${base}: `)).toBe(true);
    }
  });

  it('works without tags at all, which is the path the app runs today', () => {
    // The graph endpoint does not send tags yet. Without them a cut group's two
    // halves may carry the same name twice; nothing may fall apart.
    const bare = buildGraph(data);
    const without = groupRegions(bare, bare.clusters);
    expect(without.regions.length).toBe(grouping.regions.length);
    for (const region of without.regions) expect(region.name).not.toBe('');
  });

  it('copes with an empty vault and with a vault of one note', () => {
    const empty = buildGraph({ nodes: [], edges: [] });
    expect(groupRegions(empty, empty.clusters).regions).toEqual([]);
    const one = buildGraph({ nodes: [{ owner: 'jb', path: 'x.md', title: 'x', folder: '', links: 0 }], edges: [] });
    expect(groupRegions(one, one.clusters).regions).toHaveLength(1);
  });

  it('moves at most one cluster of notes to another region when a note is captured', { timeout: 60_000 }, () => {
    // Over every one of the possible captures. Regions are matched by the
    // members they share, so renumbering does not count as movement.
    const was = new Map<string, number>();
    grouping.regions.forEach((region, k) => {
      for (const i of region.members) was.set(graph.nodes[i]!.key, k);
    });
    const clusterWas = new Map<string, string>();
    for (const cluster of graph.clusters.clusters) {
      for (const i of cluster.members) clusterWas.set(graph.nodes[i]!.key, cluster.id);
    }

    let churned = 0;
    let groupingAlone = 0;
    let worst = 0;
    for (const target of data.nodes) {
      const path = `${target.folder}/zz captured.md`;
      const grown = buildGraph(
        {
          nodes: [...data.nodes, { owner: 'jb', path, title: 'captured', folder: target.folder, links: 1 }],
          edges: [...data.edges, { owner: 'jb', from: path, to: target.path }],
        },
        { tags },
      );
      const after = groupRegions(grown, grown.clusters);
      const match = after.regions.map((region) => {
        const counts = new Map<number, number>();
        for (const i of region.members) {
          const before = was.get(grown.nodes[i]!.key);
          if (before !== undefined) counts.set(before, (counts.get(before) ?? 0) + 1);
        }
        let best = -1;
        for (const [k, c] of counts) {
          if (best === -1 || c > counts.get(best)! || (c === counts.get(best)! && k < best)) best = k;
        }
        return best;
      });

      let moved = 0;
      for (const node of graph.nodes) {
        if (match[after.of[grown.index.get(node.key)!]!] !== was.get(node.key)) moved += 1;
      }
      let reclustered = 0;
      for (const cluster of grown.clusters.clusters) {
        for (const i of cluster.members) {
          const key = grown.nodes[i]!.key;
          if (clusterWas.has(key) && clusterWas.get(key) !== cluster.id) reclustered += 1;
        }
      }
      if (moved > 0) {
        churned += 1;
        if (reclustered === 0) groupingAlone += 1;
      }
      worst = Math.max(worst, moved);
    }

    // Measured on this vault: 25 of 109 captures move at least one note to
    // another region, at worst thirteen notes — and in all but one of them it is
    // the clustering underneath that reassigned notes, not the grouping into
    // regions. The grouping's own contribution is what the cut along cluster
    // boundaries is for: the prototype's median split over the *notes* of a
    // group tipped a note on the boundary for far more of them.
    expect(churned).toBeLessThanOrEqual(Math.round(data.nodes.length / 3));
    expect(worst).toBeLessThanOrEqual(15);
    expect(groupingAlone).toBeLessThanOrEqual(3);
  });
});
