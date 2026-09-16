/**
 * The link graph behind the relationship view.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

let dataDir: string;
let runtime: Runtime;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-graph-'));
  runtime = await createRuntime({ ...loadConfig(), dataDir });
  await runtime.users.create('julian', 'ein gutes passwort');

  await runtime.app.createNote('julian', 'MOC.md', 'Siehe [[Proxmox]] und [[Storage]].\n');
  await runtime.app.createNote('julian', 'Homelab/Proxmox.md', '# Proxmox\n\nMehr in [[Storage]].\n');
  await runtime.app.createNote('julian', 'Homelab/Storage.md', '# Storage\n');
  await runtime.app.createNote('julian', 'Allein.md', '# Allein\n\nNiemand verlinkt mich.\n');
});

afterEach(async () => {
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('the link graph', () => {
  it('returns every note as a node, with its folder and its degree', () => {
    const g = runtime.app.queries.graph('julian');
    const by = Object.fromEntries(g.nodes.map((n) => [n.path, n]));

    expect(g.nodes).toHaveLength(4);
    expect(by['Homelab/Proxmox.md']!.folder).toBe('Homelab');
    expect(by['MOC.md']!.folder).toBe('');
    // Storage wird von MOC und von Proxmox erreicht.
    expect(by['Homelab/Storage.md']!.links).toBe(2);
    expect(by['Allein.md']!.links).toBe(0);
    // A note without tags gets an empty array, not a missing field.
    expect(by['Allein.md']!.tags).toEqual([]);
  });

  it('carries each note\'s tags, gathered in one query rather than one per node', async () => {
    await runtime.app.putNote(
      'julian',
      'Homelab/Proxmox.md',
      '---\ntags: [server, homelab]\n---\n# Proxmox\n\nMehr in [[Storage]].\n',
    );
    await runtime.app.putNote('julian', 'MOC.md', '---\ntags: [moc]\n---\nSiehe [[Proxmox]] und [[Storage]].\n');

    const spy = vi.spyOn(runtime.db, 'all');
    const g = runtime.app.queries.graph('julian');
    // One query for the tag table across all nodes, not one per node: with four
    // notes in this vault a per-node subquery would show up as several extra
    // `tags`-touching calls, one query would not.
    const tagCalls = spy.mock.calls.filter(([sql]) => String(sql).includes('FROM tags'));
    expect(tagCalls).toHaveLength(1);
    spy.mockRestore();

    const by = Object.fromEntries(g.nodes.map((n) => [n.path, n]));
    expect(by['Homelab/Proxmox.md']!.tags.sort()).toEqual(['homelab', 'server']);
    expect(by['MOC.md']!.tags).toEqual(['moc']);
    expect(by['Homelab/Storage.md']!.tags).toEqual([]);
  });

  it('reports each note\'s own last-write time as updatedAt, matching the index', async () => {
    await runtime.app.putNote('julian', 'Allein.md', '# Allein\n\nGeändert.\n');

    const g = runtime.app.queries.graph('julian');
    const map = runtime.app.queries.vaultMap('julian');
    const mtimeByPath = new Map(map.map((n) => [n.path, n.mtimeMs]));

    for (const n of g.nodes) {
      expect(n.updatedAt).toBe(mtimeByPath.get(n.path));
    }
  });

  it('keeps a tag in one vault out of another', async () => {
    await runtime.users.create('ramona', 'ihr gutes passwort');
    await runtime.app.createNote('ramona', 'Ihres.md', '---\ntags: [privat]\n---\nx');

    const mine = runtime.app.queries.graph('julian');
    for (const n of mine.nodes) expect(n.tags).not.toContain('privat');

    const hers = runtime.app.queries.graph('ramona');
    expect(hers.nodes).toHaveLength(1);
    expect(hers.nodes[0]!.tags).toEqual(['privat']);
  });

  it('gives a restricted caller the identical graph whether hidden notes and tags exist or not', async () => {
    await runtime.users.create('ramona', 'ihr gutes passwort');
    runtime.shares.grant('julian', 'Homelab', 'ramona', false);
    await runtime.app.putNote(
      'julian',
      'Homelab/Proxmox.md',
      '---\ntags: [server]\n---\n# Proxmox\n\nMehr in [[Storage]].\n',
    );

    // World A: nothing private exists outside the share.
    const worldA = runtime.app.queries.graph(runtime.shares.view('ramona'));

    // World B: the same vault, but now with a private note and a tag outside
    // the share — "not yours" and "not there" must read the same to Ramona.
    await runtime.app.createNote('julian', 'Privat/Tagebuch.md', '---\ntags: [geheim]\n---\nstreng geheim\n');
    await runtime.app.putNote('julian', 'MOC.md', '---\ntags: [oeffentlich]\n---\nSiehe [[Proxmox]] und [[Storage]].\n');
    const worldB = runtime.app.queries.graph(runtime.shares.view('ramona'));

    expect(worldB).toEqual(worldA);
    // Sanity: the shared note's own tag did come through in both worlds.
    expect(worldA.nodes.find((n) => n.path === 'Homelab/Proxmox.md')?.tags).toEqual(['server']);
  });

  it('draws an edge only where a link actually resolved', async () => {
    await runtime.app.putNote('julian', 'MOC.md', 'Siehe [[Proxmox]] und [[GibtEsNicht]].\n');
    const g = runtime.app.queries.graph('julian');

    const from = g.edges.filter((e) => e.from === 'MOC.md').map((e) => e.to);
    expect(from).toEqual(['Homelab/Proxmox.md']);
    // Der tote Verweis bleibt ein Befund für die Aufräum-Ansicht, keine Kante.
    expect(runtime.app.queries.deadLinks('julian')).toHaveLength(1);
  });

  it('collapses repeated mentions of the same note into one edge', async () => {
    await runtime.app.putNote(
      'julian',
      'MOC.md',
      'Erst [[Proxmox]], dann nochmal [[Proxmox]], und [[Proxmox|noch einmal]].\n',
    );
    const g = runtime.app.queries.graph('julian');
    expect(g.edges.filter((e) => e.from === 'MOC.md' && e.to === 'Homelab/Proxmox.md')).toHaveLength(1);
  });

  it('leaves out a note that links to itself', async () => {
    await runtime.app.putNote('julian', 'Homelab/Storage.md', '# Storage\n\nSiehe [[Storage]].\n');
    const g = runtime.app.queries.graph('julian');
    expect(g.edges.filter((e) => e.from === e.to)).toEqual([]);
  });

  it('keeps one vault out of another', async () => {
    await runtime.users.create('ramona', 'ihr gutes passwort');
    await runtime.app.createNote('ramona', 'Ihres.md', 'x');

    const mine = runtime.app.queries.graph('julian');
    expect(mine.nodes.map((n) => n.path)).not.toContain('Ihres.md');
    expect(runtime.app.queries.graph('ramona').nodes).toHaveLength(1);
  });

  it('includes a shared folder when one is granted', async () => {
    await runtime.users.create('ramona', 'ihr gutes passwort');
    runtime.shares.grant('julian', 'Homelab', 'ramona', false);

    const hers = runtime.app.queries.graph(runtime.shares.view('ramona'));
    const paths = hers.nodes.map((n) => n.path);

    expect(paths).toContain('Homelab/Proxmox.md');
    // Ausserhalb der Freigabe bleibt unsichtbar — auch im Graphen.
    expect(paths).not.toContain('MOC.md');
  });
});
