/**
 * The link graph behind the relationship view.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
