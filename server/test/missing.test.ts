/**
 * "Asked for, never written": the one gap the index can actually name.
 *
 * The briefing's point 21 wants to know where the knowledge gaps are. Without a
 * model the only gap the data records is the one somebody wrote down themselves:
 * a wikilink to a name, and no note of that name. `missingNotes` groups exactly
 * the rows `deadLinks` returned, so everything the query's own comment promises
 * about regions and existence oracles holds here unchanged.
 *
 * The tests below are mostly about what is *left out*. A single note asking for
 * a name is a typo or a passing reference, and the tidy list already carries it
 * as a broken link; calling it a knowledge gap would be a claim the data does
 * not make.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../src/db/database.js';
import { migrate } from '../src/db/schema.js';
import { Indexer } from '../src/index/indexer.js';
import { Queries, missingNotes } from '../src/index/queries.js';
import { NoteService } from '../src/notes/service.js';
import type { View } from '../src/auth/shares.js';
import { Vault } from '../src/vault/fs.js';

let dataDir: string;
let db: Database;
let notes: NoteService;
let indexer: Indexer;
let q: Queries;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-missing-'));
  const vault = new Vault(dataDir);
  notes = new NoteService(vault);
  await vault.ensureVault('julian');
  await vault.ensureVault('ramona');

  db = new Database(':memory:');
  migrate(db);
  indexer = new Indexer(db, notes);
  q = new Queries(db);
});

afterEach(async () => {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

/** Writes a note and brings the index up to date with it. */
async function write(owner: string, notePath: string, body: string): Promise<void> {
  await notes.createNote(owner, notePath, body);
  await indexer.rebuild(owner);
}

/** Everything `missingNotes` makes of one vault's dead links. */
function missing(owner: string | View): ReturnType<typeof missingNotes> {
  return missingNotes(q.deadLinks(owner));
}

describe('a name several notes ask for', () => {
  it('is reported once, with every note that asks', async () => {
    await write('julian', 'Services.md', '# Services\n\nRates are in [[Pricing]].\n');
    await write('julian', 'Offer.md', '# Offer\n\nSee [[Pricing]] before quoting.\n');

    expect(missing('julian')).toEqual([
      { owner: 'julian', name: 'Pricing', asked: ['Offer.md', 'Services.md'] },
    ]);
  });

  it('counts notes, not links: one note asking twice is still one note', async () => {
    await write('julian', 'Services.md', '# Services\n\n[[Pricing]] and again [[Pricing]].\n');

    expect(q.deadLinks('julian')).toHaveLength(2);
    expect(missing('julian')).toEqual([]);
  });

  it('is left out when only one note asks, though the broken link stays a finding', async () => {
    await write('julian', 'Services.md', '# Services\n\nRates are in [[Pricing]].\n');

    expect(q.deadLinks('julian').map((l) => l.targetRaw)).toEqual(['Pricing']);
    expect(missing('julian')).toEqual([]);
  });

  it('collapses the spellings the resolver itself collapses, and shows the commonest', async () => {
    await write('julian', 'Services.md', '# Services\n\n[[Pricing]]\n');
    await write('julian', 'Offer.md', '# Offer\n\n[[pricing]]\n');
    await write('julian', 'Invoice.md', '# Invoice\n\n[[Pricing.md]]\n');

    expect(missing('julian')).toEqual([
      { owner: 'julian', name: 'Pricing', asked: ['Invoice.md', 'Offer.md', 'Services.md'] },
    ]);
  });

  it('says nothing about a name that is written', async () => {
    await write('julian', 'Pricing.md', '# Pricing\n');
    await write('julian', 'Services.md', '# Services\n\n[[Pricing]]\n');
    await write('julian', 'Offer.md', '# Offer\n\n[[Pricing]]\n');

    expect(missing('julian')).toEqual([]);
  });

  it('keeps two vaults apart — one name asked for in each is not one gap', async () => {
    await write('julian', 'Services.md', '# Services\n\n[[Pricing]]\n');
    await write('ramona', 'Angebot.md', '# Angebot\n\n[[Pricing]]\n');

    expect(missing('julian')).toEqual([]);
    expect(missing('ramona')).toEqual([]);
  });

  it('puts the most asked for first', async () => {
    await write('julian', 'A.md', '# A\n\n[[Pricing]] [[Sales]]\n');
    await write('julian', 'B.md', '# B\n\n[[Pricing]] [[Sales]]\n');
    await write('julian', 'C.md', '# C\n\n[[Pricing]]\n');

    expect(missing('julian').map((m) => [m.name, m.asked.length])).toEqual([
      ['Pricing', 3],
      ['Sales', 2],
    ]);
  });

  it('leaves a daily note’s link to a day nobody has written out of it', async () => {
    await write('julian', '50_Journal/2026/09/2026-09-21.md', '# 2026-09-21\n\n[[50_Journal/2026/09/2026-09-23]]\n');
    await write('julian', '50_Journal/2026/09/2026-09-22.md', '# 2026-09-22\n\n[[50_Journal/2026/09/2026-09-23]]\n');

    expect(missing('julian')).toEqual([]);
  });
});

/**
 * The rule `deadLinks` states in its own comment, one representation further on.
 *
 * A caller who sees one folder is told about the links that leave it, because
 * from where they stand those links lead nowhere. `missingNotes` regroups that
 * answer and must not quietly widen it back out — it never sees a link the
 * caller was not given.
 */
describe('a caller who sees part of the vault', () => {
  const homelab: View = [{ owner: 'julian', prefix: 'Homelab', exact: false, canWrite: false }];

  it('is told about the names its own notes ask for and cannot reach', async () => {
    await write('julian', 'Pricing.md', '# Pricing\n');
    await write('julian', 'Homelab/Proxmox.md', '# Proxmox\n\n[[Pricing]]\n');
    await write('julian', 'Homelab/Storage.md', '# Storage\n\n[[Pricing]]\n');

    expect(missing('julian')).toEqual([]);
    expect(missing(homelab)).toEqual([
      { owner: 'julian', name: 'Pricing', asked: ['Homelab/Proxmox.md', 'Homelab/Storage.md'] },
    ]);
  });

  it('is told nothing about a name only notes outside its region ask for', async () => {
    await write('julian', 'Services.md', '# Services\n\n[[Pricing]]\n');
    await write('julian', 'Offer.md', '# Offer\n\n[[Pricing]]\n');
    await write('julian', 'Homelab/Proxmox.md', '# Proxmox\n');

    expect(missing(homelab)).toEqual([]);
  });
});
