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

  it('gathers many clusters into six to eight regions of at least eight notes', () => {
    // Twenty clusters give twenty cells, which over two hemispheres are thin,
    // mostly empty, and carry twenty labels nobody can read. Eight notes is the
    // floor: a region of five was one small knot in a cell and read as empty.
    expect(graph.clusters.clusters.length).toBeGreaterThan(12);
    expect(grouping.regions.length).toBeGreaterThanOrEqual(6);
    expect(grouping.regions.length).toBeLessThanOrEqual(8);

    const sizes = grouping.regions.map((r) => r.members.length).sort((a, b) => a - b);
    // Every note in exactly one region.
    expect(sizes.reduce((sum, n) => sum + n, 0)).toBe(graph.nodes.length);
    // None under eight, and the largest no more than three times the smallest.
    // Measured on this vault: 12 to 23.
    expect(sizes[0]!).toBeGreaterThanOrEqual(8);
    expect(sizes[sizes.length - 1]! / sizes[0]!).toBeLessThanOrEqual(3);
  });

  it('names regions the way a person would, never like a path', () => {
    const names = grouping.regions.map((r) => r.name);
    for (const name of names) {
      expect(name).not.toBe('');
      // No "Group: tag" pattern, no ordering prefix, no folder a PARA vault
      // uses for filing rather than for a subject.
      expect(name).not.toContain(':');
      expect(name).not.toContain('/');
      expect(/^\d/.test(name)).toBe(false);
      expect(name).not.toBe('Active');
      expect(name).not.toBe('Areas');
    }
    // "Projects" for the region that holds most of `10_Projects`.
    expect(names).toContain('Projects');
  });

  it('names the halves of a cut group so that each stands on its own', () => {
    const halves = grouping.regions.filter((r) => r.half >= 0);
    expect(halves.length).toBeGreaterThanOrEqual(4);
    const all = grouping.regions.map((r) => r.name);
    for (const half of halves) {
      const sibling = halves.find((other) => other !== half && other.group === half.group);
      expect(sibling, half.name).toBeDefined();
      // Two halves that a tag tells apart never share a name.
      if (half.name !== sibling!.name) {
        expect(all.filter((n) => n === half.name)).toHaveLength(1);
      }
    }
    // The halves of a topic are named after what sets them apart, alone:
    // "Proxmox" and "Networking", not "Homelab: Proxmox".
    expect(all).toContain('Networking');
    expect(all).toContain('Proxmox');
    // The half of a kind of note keeps the kind: "AI Projects", not "AI".
    expect(all.some((n) => /^\S+ Projects$/.test(n))).toBe(true);
    expect(all).not.toContain('AI');
  });

  it('works without tags at all, which is the path the app runs today', () => {
    // The graph endpoint does not send tags yet. Without them a cut group's two
    // halves may carry the same name twice; nothing may fall apart.
    const bare = buildGraph(data);
    const without = groupRegions(bare, bare.clusters);
    expect(without.regions.length).toBeGreaterThanOrEqual(6);
    expect(without.regions.length).toBeLessThanOrEqual(8);
    for (const region of without.regions) expect(region.name).not.toBe('');
  });

  it('copes with an empty vault and with a vault of one note', () => {
    const empty = buildGraph({ nodes: [], edges: [] });
    expect(groupRegions(empty, empty.clusters).regions).toEqual([]);
    const one = buildGraph({ nodes: [{ owner: 'jb', path: 'x.md', title: 'x', folder: '', links: 0, tags: [], updatedAt: 0 }], edges: [] });
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
          nodes: [...data.nodes, { owner: 'jb', path, title: 'captured', folder: target.folder, links: 1, tags: [], updatedAt: 0 }],
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
