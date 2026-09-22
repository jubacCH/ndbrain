/**
 * A single file the path rules reject must not keep the server from starting.
 *
 * `listNotes` returns whatever is on disk; `getNote` applies the naming rules.
 * Between those two sits every way a file arrives without passing through this
 * server — Obsidian, an import, rsync, a shell on the host. A name like
 * `Was ist ein VLAN?.md` is perfectly legal on Linux and is refused by
 * `normalizeVaultPath`, so the start-up sync threw, `main` exited, and
 * `restart: unless-stopped` turned that into a crash loop with no port open to
 * look at. The vault layer promises the opposite: names are checked when one is
 * *chosen*, never when one is read.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { Database } from '../src/db/database.js';
import { migrate } from '../src/db/schema.js';
import { Indexer } from '../src/index/indexer.js';
import { Queries } from '../src/index/queries.js';
import { NoteService } from '../src/notes/service.js';
import { createRuntime, syncAllVaults, type Runtime } from '../src/runtime.js';
import { Vault } from '../src/vault/fs.js';

let dataDir: string;
let db: Database;
let notes: NoteService;
let q: Queries;
let skipped: Array<{ owner: string; notePath: string }>;

/** Writes a file straight into the vault, the way an import or an rsync would. */
async function dropFile(owner: string, name: string, content: string): Promise<void> {
  const file = path.join(dataDir, 'vaults', owner, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

function newIndexer(): Indexer {
  return new Indexer(db, notes, {
    onSkipped: (owner, notePath) => {
      skipped.push({ owner, notePath });
    },
  });
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-startup-'));
  const vault = new Vault(dataDir);
  notes = new NoteService(vault);
  await vault.ensureVault('julian');

  db = new Database(':memory:');
  migrate(db);
  q = new Queries(db);
  skipped = [];
});

afterEach(async () => {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('a file nobody could have created through ndbrain', () => {
  it('is skipped by sync, by name, and the rest of the vault still indexes', async () => {
    await notes.createNote('julian', 'Homelab/Proxmox.md', '# Proxmox\n');
    await dropFile('julian', 'Was ist ein VLAN?.md', '# VLAN\n');

    const stats = await newIndexer().sync('julian');

    expect(stats.added).toBe(1);
    expect(stats.skipped).toEqual(['Was ist ein VLAN?.md']);
    expect(skipped).toEqual([{ owner: 'julian', notePath: 'Was ist ein VLAN?.md' }]);
    expect(q.countNotes('julian')).toBe(1);
  });

  it('is skipped by rebuild too', async () => {
    await notes.createNote('julian', 'Homelab/Proxmox.md', '# Proxmox\n');
    // Reserved on Windows, so `normalizeVaultPath` refuses it whatever the extension.
    await dropFile('julian', 'aux.md', 'aux\n');

    const stats = await newIndexer().rebuild('julian');

    expect(stats.added).toBe(1);
    expect(stats.skipped).toEqual(['aux.md']);
    expect(skipped).toEqual([{ owner: 'julian', notePath: 'aux.md' }]);
    expect(q.countNotes('julian')).toBe(1);
  });

  it('does not come back as a phantom removal on the next sync', async () => {
    await notes.createNote('julian', 'Homelab/Proxmox.md', '# Proxmox\n');
    await dropFile('julian', 'Was ist ein VLAN?.md', '# VLAN\n');

    const indexer = newIndexer();
    await indexer.sync('julian');
    const second = await indexer.sync('julian');

    expect(second.removed).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(second.skipped).toEqual(['Was ist ein VLAN?.md']);
  });
});

describe('the start-up sync', () => {
  let runtime: Runtime;

  beforeEach(async () => {
    const config = { ...loadConfig(), dataDir, logLevel: 'silent', reconcileIntervalMs: 0 };
    runtime = await createRuntime(config, {
      onSkipped: (owner, notePath) => {
        skipped.push({ owner, notePath });
      },
    });
  });

  afterEach(() => {
    runtime.close();
  });

  it('gets past a vault holding a file it cannot index, and reaches the next one', async () => {
    await runtime.users.create('anna', 'passwort-eins-zwei');
    await runtime.users.create('bruno', 'passwort-eins-zwei');

    await dropFile('anna', 'Was ist ein VLAN?.md', '# VLAN\n');
    await runtime.notes.createNote('bruno', 'Notiz.md', '# Notiz\n');

    const report = await syncAllVaults(runtime);

    expect(report.failed).toEqual([]);
    expect(skipped).toContainEqual({ owner: 'anna', notePath: 'Was ist ein VLAN?.md' });
    expect(runtime.app.queries.countNotes('bruno')).toBe(1);
  });

  it('carries on to the next vault when one fails outright', async () => {
    await runtime.users.create('anna', 'passwort-eins-zwei');
    await runtime.users.create('bruno', 'passwort-eins-zwei');
    await runtime.notes.createNote('bruno', 'Notiz.md', '# Notiz\n');

    const broken = new Error('disk fell over');
    runtime.indexer.sync = async (owner: string) => {
      if (owner === 'anna') throw broken;
      return { added: 0, updated: 0, removed: 0, unchanged: 0, skipped: [] };
    };

    const report = await syncAllVaults(runtime);

    expect(report.failed).toEqual([{ owner: 'anna', error: broken }]);
  });
});
