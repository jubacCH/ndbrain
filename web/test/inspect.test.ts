/**
 * What the inspector says about a note, from the structure and the text alone.
 */

import { describe, expect, it } from 'vitest';

import type { GraphData } from '../src/api';
import { indexGraph, neighbourhood, summarize, whyConnected } from '../src/inspect';
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
