/**
 * What the inspector says about a note, from the structure and the text alone.
 */

import { describe, expect, it } from 'vitest';

import type { GraphData } from '../src/api';
import { indexGraph, neighbourhood, regionFacts, summarize, whyConnected } from '../src/inspect';
import { refKey } from '../src/refkey';

const O = 'jb';

function node(path: string, tags: string[] = []): GraphData['nodes'][number] {
  return {
    owner: O,
    path,
    title: path.split('/').pop()!.replace(/\.md$/, ''),
    folder: path.split('/').slice(0, -1).join('/'),
    links: 0,
    tags,
    updatedAt: 0,
  };
}

const graph: GraphData = {
  nodes: [
    node('20_Areas/21_Homelab/Proxmox.md', ['homelab', 'Backup']),
    node('20_Areas/21_Homelab/Backup.md', ['backup', 'homelab', 'azure']),
    node('20_Areas/22_Services/Vault.md', ['homelab']),
    node('10_Projects/ndBrain.md'),
    node('30_Resources/Lonely.md'),
  ],
  edges: [
    { owner: O, from: '20_Areas/21_Homelab/Proxmox.md', to: '20_Areas/21_Homelab/Backup.md' },
    { owner: O, from: '20_Areas/21_Homelab/Backup.md', to: '20_Areas/21_Homelab/Proxmox.md' },
    { owner: O, from: '20_Areas/22_Services/Vault.md', to: '20_Areas/21_Homelab/Proxmox.md' },
    { owner: O, from: '20_Areas/22_Services/Vault.md', to: '20_Areas/21_Homelab/Backup.md' },
    { owner: O, from: '10_Projects/ndBrain.md', to: '20_Areas/21_Homelab/Proxmox.md' },
    { owner: O, from: '20_Areas/21_Homelab/Proxmox.md', to: '10_Projects/ndBrain.md' },
    { owner: O, from: '20_Areas/21_Homelab/Backup.md', to: '10_Projects/ndBrain.md' },
    // An edge to a note the reply does not carry, and a self-link: both ignored.
    { owner: O, from: '20_Areas/21_Homelab/Proxmox.md', to: 'Hidden/Secret.md' },
    { owner: O, from: '30_Resources/Lonely.md', to: '30_Resources/Lonely.md' },
  ],
};
const key = (path: string): string => refKey(O, path);
const PROXMOX = key('20_Areas/21_Homelab/Proxmox.md');
const BACKUP = key('20_Areas/21_Homelab/Backup.md');
const VAULT = key('20_Areas/22_Services/Vault.md');
const NDBRAIN = key('10_Projects/ndBrain.md');
const LONELY = key('30_Resources/Lonely.md');

describe('neighbourhood', () => {
  const index = indexGraph(graph);

  it('splits the direct neighbours into links to and links from, by title', () => {
    const around = neighbourhood(index, PROXMOX);
    expect(around.outgoing.map((n) => n.title)).toEqual(['Backup', 'ndBrain']);
    expect(around.incoming.map((n) => n.title)).toEqual(['Backup', 'ndBrain', 'Vault']);
  });

  it('names no note the graph reply does not carry, and no note as its own neighbour', () => {
    const around = neighbourhood(index, PROXMOX);
    expect(around.outgoing.some((n) => n.path.startsWith('Hidden/'))).toBe(false);
    expect(neighbourhood(index, LONELY)).toEqual({ outgoing: [], incoming: [] });
  });
});

describe('whyConnected', () => {
  const index = indexGraph(graph);

  it('gives the link, the shared folder, the shared tags and the shared neighbours', () => {
    expect(whyConnected(index, PROXMOX, BACKUP)).toEqual({
      link: 'both',
      folder: { name: '21_Homelab', same: true },
      tags: ['homelab', 'Backup'],
      // Vault and ndBrain are linked with both.
      shared: 2,
    });
  });

  it('reads the direction from the first note, and a common ancestor as such', () => {
    const reasons = whyConnected(index, PROXMOX, VAULT);
    expect(reasons.link).toBe('incoming');
    expect(reasons.folder).toEqual({ name: '20_Areas', same: false });
    expect(whyConnected(index, VAULT, PROXMOX).link).toBe('outgoing');
  });

  it('claims nothing that is not there', () => {
    expect(whyConnected(index, NDBRAIN, LONELY)).toEqual({ link: null, folder: null, tags: [], shared: 0 });
  });
});

describe('summarize', () => {
  it('reads a pathological line only as far as the summary reaches', () => {
    for (const body of ['['.repeat(40_000), '[['.repeat(20_000), `**${'_'.repeat(40_000)}`, `${'word '.repeat(8_000)}`]) {
      const started = performance.now();
      const summary = summarize(`# Title\n\n${body}`);
      const took = performance.now() - started;
      expect(took).toBeLessThan(50);
      expect(summary.length).toBeLessThanOrEqual(241);
    }
    // And many short lines in one paragraph stop early too.
    const many = Array.from({ length: 20_000 }, () => '[x').join('\n');
    const started = performance.now();
    summarize(many);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('skips frontmatter, headings and the blockquote header, and returns the first paragraph', () => {
    const text = [
      '---',
      'tags: [homelab]',
      'status: active',
      '---',
      '# Backup to Azure',
      '',
      '> [!info] Status',
      '> Last reviewed in August.',
      '',
      'Setup and maintain automated backups',
      'to Azure for personal data and projects.',
      '',
      'A second paragraph that is not the summary.',
    ].join('\n');
    expect(summarize(text)).toBe('Setup and maintain automated backups to Azure for personal data and projects.');
  });

  it('turns links and emphasis into their words', () => {
    expect(summarize('See [[21_Homelab/Proxmox|the cluster]], [[Vault]] and [docs](https://x.y) — **now**, `rclone` _daily_.')).toBe(
      'See the cluster, Vault and docs — now, rclone daily.',
    );
  });

  it('keeps snake_case names intact', () => {
    expect(summarize('The job runs backup_to_azure nightly.')).toBe('The job runs backup_to_azure nightly.');
  });

  it('never passes markup through: tags are removed, the rest is text', () => {
    const out = summarize('<img src=x onerror="alert(1)">Hello <script>alert(2)</script>world');
    expect(out).not.toContain('<');
    expect(out).not.toContain('onerror');
    expect(out).toBe('Hello alert(2)world');
  });

  it('skips fenced code and comments, and joins a list into one line', () => {
    const text = ['```bash', 'rm -rf /', '```', '<!-- hidden', 'still hidden -->', '- [ ] first [[Task]]', '- second', '', 'After.'].join('\n');
    expect(summarize(text)).toBe('first Task · second');
  });

  it('says nothing for a note with nothing but headings', () => {
    expect(summarize('---\na: 1\n---\n# Title\n\n## Section\n')).toBe('');
  });

  it('cuts a long paragraph at a word, with an ellipsis', () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const out = summarize(long, 60);
    expect(out.length).toBeLessThanOrEqual(61);
    expect(out.endsWith('…')).toBe(true);
    expect(out.slice(0, -1).split(' ').every((w) => /^word\d+$/.test(w))).toBe(true);
  });
});

/**
 * What the inspector says about a whole region.
 *
 * The briefing's region panel ("Orbit8 · 124 Notes · 18 Resources · 8 MOCs")
 * with the AI taken out of it. Everything here has to be countable off the
 * graph reply the view already holds: a number the data cannot give is left
 * out, never estimated.
 */
describe('regionFacts', () => {
  // A region as the layout hands one over: its members' keys, nothing else.
  const rich: GraphData = {
    nodes: [
      { ...node('20_Areas/21_Homelab/Proxmox.md', ['homelab', 'Backup']), links: 7, updatedAt: 500 },
      { ...node('20_Areas/21_Homelab/Backup.md', ['backup', 'HOMELAB']), links: 3, updatedAt: 900 },
      { ...node('30_Resources/Checkmk.md', ['homelab']), links: 1, updatedAt: 100 },
      { ...node('10_Projects/ndBrain.md'), links: 5, updatedAt: 700 },
      { ...node('40_MOCs/Services.md'), links: 9, updatedAt: 50 },
    ],
    edges: [],
  };
  const index = indexGraph(rich);
  const members = rich.nodes.map((n) => refKey(O, n.path));

  it('counts the notes it can account for, and no others', () => {
    const facts = regionFacts(index, [...members, refKey(O, 'Gone.md')]);
    // The stray key is a note the reply does not carry. It is left out rather
    // than counted as a note nobody can show.
    expect(facts.notes).toBe(5);
    expect(facts.kinds.reduce((sum, k) => sum + k.count, 0)).toBe(5);
  });

  it('counts by kind, most first, and names only the kinds it has', () => {
    const facts = regionFacts(index, members);
    expect(facts.kinds).toEqual([
      { kind: 'area', label: '', count: 2 },
      { kind: 'map', label: '', count: 1 },
      { kind: 'project', label: '', count: 1 },
      { kind: 'resource', label: '', count: 1 },
    ]);
    expect(facts.kinds.some((k) => k.kind === 'client')).toBe(false);
  });

  it('counts tags without case, in the spelling the notes use first', () => {
    const facts = regionFacts(index, members);
    expect(facts.tags).toEqual([
      { tag: 'homelab', count: 3 },
      { tag: 'Backup', count: 2 },
    ]);
  });

  it('reports the last edit in the region, and nothing when it holds no note', () => {
    expect(regionFacts(index, members).lastActive).toBe(900);
    expect(regionFacts(index, []).lastActive).toBeNull();
    expect(regionFacts(index, []).notes).toBe(0);
    expect(regionFacts(index, []).kinds).toEqual([]);
  });

  it('puts the most connected notes first, by the links the server counted', () => {
    const facts = regionFacts(index, members);
    expect(facts.strongest.map((n) => [n.title, n.links])).toEqual([
      ['Services', 9],
      ['Proxmox', 7],
      ['ndBrain', 5],
      ['Backup', 3],
      ['Checkmk', 1],
    ]);
  });

  it('leaves out a note with no links at all rather than calling it a connection', () => {
    const quiet: GraphData = {
      nodes: [{ ...node('20_Areas/Alone.md'), links: 0, updatedAt: 1 }],
      edges: [],
    };
    const facts = regionFacts(indexGraph(quiet), [refKey(O, '20_Areas/Alone.md')]);
    expect(facts.notes).toBe(1);
    expect(facts.strongest).toEqual([]);
  });
});
