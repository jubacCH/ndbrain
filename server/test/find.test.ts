import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { SESSION_COOKIE, buildServer } from '../src/http/server.js';
import { LoginThrottle } from '../src/http/throttle.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

let dataDir: string;
let runtime: Runtime;
let server: FastifyInstance;
let cookie: string;

const DAY = 24 * 60 * 60 * 1000;

async function seed(): Promise<void> {
  await runtime.app.createNote(
    'julian',
    'Homelab/Proxmox Cluster.md',
    '---\ntags: [homelab, proxmox]\n---\n# Proxmox Cluster\n\nZwei Nodes, Qdevice auf dns01.\n',
  );
  await runtime.app.createNote(
    'julian',
    'Homelab/UniFi ZBF.md',
    '---\ntags: [homelab, netzwerk]\n---\n# UniFi\n\nZonen und Regeln.\n',
  );
  await runtime.app.createNote(
    'julian',
    'Projekte/ndBrain.md',
    '---\ntags: [projekt]\n---\n# ndBrain\n\nNotiz-Tool. Erwähnt Proxmox am Rande.\n',
  );
  await runtime.app.createNote('julian', 'Journal/2026-07-27.md', 'Ohne Tag, ohne alles.\n');
}

/** Backdates a note on disk and in the index, to test the time filter. */
async function backdate(notePath: string, days: number): Promise<void> {
  const file = path.join(dataDir, 'vaults', 'julian', notePath);
  const when = new Date(Date.now() - days * DAY);
  await fs.utimes(file, when, when);
  await runtime.indexer.rebuild('julian');
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-find-'));
  const config = { ...loadConfig(), dataDir, cookieSecure: false };
  runtime = await createRuntime(config);

  await runtime.users.create('julian', 'ein gutes passwort', { role: 'admin' });
  await runtime.users.create('ramona', 'ihr gutes passwort');
  await seed();
  await runtime.app.createNote('ramona', 'Privat/Proxmox.md', 'Ramona schreibt auch über Proxmox\n');

  server = await buildServer({
    app: runtime.app,
    users: runtime.users,
    sessions: runtime.sessions,
    keys: runtime.keys,
    shares: runtime.shares,
    settings: runtime.settings,
    config,
    throttle: new LoginThrottle({ limit: 1000 }),
  });

  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { user: 'julian', password: 'ein gutes passwort' },
  });
  const jar = response.cookies.find((c) => c.name === SESSION_COOKIE);
  cookie = `${jar?.name}=${jar?.value}`;
});

afterEach(async () => {
  await server.close();
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function search(query: string): Promise<string[]> {
  const response = await server.inject({ url: `/api/v1/search?${query}`, headers: { cookie } });
  return (response.json().hits as Array<{ path: string }>).map((hit) => hit.path);
}

describe('search filters', () => {
  it('finds by word', async () => {
    expect(await search('q=Qdevice')).toEqual(['Homelab/Proxmox Cluster.md']);
  });

  it('filters by tag', async () => {
    const paths = await search('tag=homelab');
    expect(paths.sort()).toEqual(['Homelab/Proxmox Cluster.md', 'Homelab/UniFi ZBF.md']);
  });

  it('filters by tag case-insensitively', async () => {
    expect((await search('tag=Homelab')).length).toBe(2);
  });

  it('filters by folder', async () => {
    expect(await search('dir=Projekte')).toEqual(['Projekte/ndBrain.md']);
  });

  it('does not let a folder filter match a folder that merely starts the same', async () => {
    await runtime.app.createNote('julian', 'Homelab2/Fremd.md', 'x');
    await runtime.indexer.rebuild('julian');

    const paths = await search('dir=Homelab');
    expect(paths).not.toContain('Homelab2/Fremd.md');
    expect(paths).toHaveLength(2);
  });

  it('combines a word with a tag', async () => {
    // "Proxmox" appears in the ndBrain note too, but that one is not #homelab.
    expect(await search('q=Proxmox&tag=homelab')).toEqual(['Homelab/Proxmox Cluster.md']);
  });

  it('combines a word with a folder', async () => {
    expect(await search('q=Proxmox&dir=Projekte')).toEqual(['Projekte/ndBrain.md']);
  });

  it('filters by age', async () => {
    await backdate('Journal/2026-07-27.md', 30);

    const recent = await search('days=7');
    expect(recent).not.toContain('Journal/2026-07-27.md');
    expect(recent.length).toBe(3);
  });

  it('answers a filter-only query by recency instead of returning nothing', async () => {
    // "Everything tagged #homelab" is a question people ask without search words.
    const paths = await search('tag=homelab');
    expect(paths.length).toBe(2);
  });

  it('returns nothing for a filter that matches nothing, rather than everything', async () => {
    expect(await search('tag=gibtsnicht')).toEqual([]);
    expect(await search('dir=GibtsNicht')).toEqual([]);
  });

  it('never crosses into another vault, filters or not', async () => {
    for (const query of ['q=Proxmox', 'tag=homelab', 'dir=Privat', 'days=7', 'q=Ramona']) {
      const paths = await search(query);
      expect(paths.every((p) => !p.startsWith('Privat/'))).toBe(true);
    }
  });
});

describe('quick switcher', () => {
  async function quick(q: string): Promise<string[]> {
    const response = await server.inject({
      url: `/api/v1/quickfind?q=${encodeURIComponent(q)}`,
      headers: { cookie },
    });
    return (response.json().notes as Array<{ title: string }>).map((note) => note.title);
  }

  it('puts an exact title first', async () => {
    expect((await quick('ndBrain'))[0]).toBe('ndBrain');
  });

  it('ranks a prefix above a mere mention', async () => {
    // "Proxmox Cluster" starts with it; "ndBrain" only mentions Proxmox in its body,
    // which the quick switcher does not look at at all.
    const results = await quick('prox');
    expect(results[0]).toBe('Proxmox Cluster');
    expect(results).not.toContain('ndBrain');
  });

  it('matches a subsequence, so initials find a long title', async () => {
    expect(await quick('pxcl')).toContain('Proxmox Cluster');
  });

  it('matches on the folder as well as the title', async () => {
    expect(await quick('journal')).toContain('2026-07-27');
  });

  it('is case-insensitive', async () => {
    expect(await quick('PROXMOX')).toContain('Proxmox Cluster');
  });

  it('offers recent notes when nothing has been typed yet', async () => {
    expect((await quick('')).length).toBeGreaterThan(0);
  });

  it('returns nothing for gibberish rather than everything', async () => {
    expect(await quick('zzzqqqxxx')).toEqual([]);
  });

  it('never offers another user\'s notes', async () => {
    const results = await quick('Privat');
    expect(results).toEqual([]);
  });
});

describe('tags endpoint', () => {
  it('lists tags with counts, most used first', async () => {
    const response = await server.inject({ url: '/api/v1/tags', headers: { cookie } });
    const tags = response.json().tags as Array<{ tag: string; count: number }>;

    expect(tags[0]).toEqual({ tag: 'homelab', count: 2 });
    expect(tags.map((t) => t.tag).sort()).toEqual(['homelab', 'netzwerk', 'projekt', 'proxmox']);
  });

  it('is scoped to the caller', async () => {
    const response = await server.inject({ url: '/api/v1/tags', headers: { cookie } });
    expect(response.body).not.toContain('Privat');
  });

  it('needs a session', async () => {
    expect((await server.inject({ url: '/api/v1/tags' })).statusCode).toBe(401);
    expect((await server.inject({ url: '/api/v1/quickfind?q=x' })).statusCode).toBe(401);
  });
});
