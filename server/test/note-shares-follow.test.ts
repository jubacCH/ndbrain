/**
 * A note share follows its note, and dies with it.
 *
 * Every way a note can move or go is walked here: rename and move through
 * ndBrain, a bulk move, a folder rename; delete through the note route, the
 * file route and a bulk delete; and the ways around ndBrain, which only the
 * watcher and reconciliation see. The rule each test checks is the same one
 * from two sides: the grantee still has the note wherever it went, and nobody
 * ever holds a share that has come to point at a different note.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VaultWatcher } from '../src/index/watcher.js';
import { createWatcher, syncAllVaults } from '../src/runtime.js';
import { startHarness, type Harness } from './support/harness.js';

vi.setConfig({ testTimeout: 30_000 });

let h: Harness;
let watcher: VaultWatcher | null = null;

beforeEach(async () => {
  h = await startHarness('follow');
  for (const [id, password] of [
    ['julian', 'ein gutes passwort'],
    ['ramona', 'ihr gutes passwort'],
    ['peter', 'sein gutes passwort'],
  ] as const) {
    await h.runtime.users.create(id, password);
    await h.login(id, password);
  }
  await h.runtime.app.createNote('julian', 'Projekt/Plan.md', '# Plan\n\ngeteilt\n', 'julian');
  await h.runtime.app.createNote('julian', 'Projekt/Alt.md', '# Alt\n\nfür Peter\n', 'julian');
  await h.runtime.app.createNote('julian', 'Verweis.md', 'Siehe [[Plan]]\n', 'julian');
});

afterEach(async () => {
  if (watcher !== null) await watcher.stop();
  watcher = null;
  await h.close();
});

async function shareNote(grantee: string, notePath: string, canWrite = false): Promise<void> {
  const reply = await h.as('julian', {
    method: 'POST',
    url: '/api/v1/shares',
    payload: { grantee, kind: 'note', path: notePath, canWrite },
  });
  expect(reply.status).toBe(200);
}

async function reads(user: string, notePath: string): Promise<number> {
  return (await h.as(user, { url: `/api/v1/notes/${encodeURI(notePath)}?owner=julian` })).status;
}

function noteShares(): Array<{ path: string; grantee: string }> {
  return h.runtime.shares
    .byOwner('julian')
    .filter((share) => share.kind === 'note')
    .map((share) => ({ path: share.prefix, grantee: share.grantee }));
}

/** A note share left behind by a note that disappeared while nobody was looking. */
async function strandShare(grantee: string, notePath: string): Promise<void> {
  await shareNote(grantee, notePath);
  await fs.rm(path.join(h.dataDir, 'vaults', 'julian', notePath));
  h.runtime.indexer.removeNote('julian', notePath);
  expect(noteShares()).toContainEqual({ path: notePath, grantee });
}

describe('rename and move', () => {
  it('moves the share with a renamed note', async () => {
    await shareNote('ramona', 'Projekt/Plan.md');
    const reply = await h.as('julian', {
      method: 'POST',
      url: '/api/v1/rename',
      payload: { from: 'Projekt/Plan.md', to: 'Archiv/Planung.md' },
    });
    expect(reply.status).toBe(200);

    expect(noteShares()).toEqual([{ path: 'Archiv/Planung.md', grantee: 'ramona' }]);
    expect(await reads('ramona', 'Archiv/Planung.md')).toBe(200);
    expect(await reads('ramona', 'Projekt/Plan.md')).toBe(404);
  });

  it('moves it when a grantee with a folder share renames the note', async () => {
    await shareNote('ramona', 'Projekt/Plan.md');
    h.runtime.shares.grant('julian', 'Projekt', 'peter', true);
    const reply = await h.as('peter', {
      method: 'POST',
      url: '/api/v1/rename',
      payload: { owner: 'julian', from: 'Projekt/Plan.md', to: 'Projekt/Plan neu.md' },
    });
    expect(reply.status).toBe(200);
    expect(await reads('ramona', 'Projekt/Plan neu.md')).toBe(200);
  });

  it('moves it with a bulk move', async () => {
    await shareNote('ramona', 'Projekt/Plan.md');
    const reply = await h.as('julian', {
      method: 'POST',
      url: '/api/v1/bulk',
      payload: { owner: 'julian', paths: ['Projekt/Plan.md'], action: 'move', dir: 'Archiv' },
    });
    expect(reply.body.ok).toEqual(['Archiv/Plan.md']);
    expect(noteShares()).toEqual([{ path: 'Archiv/Plan.md', grantee: 'ramona' }]);
    expect(await reads('ramona', 'Archiv/Plan.md')).toBe(200);
  });

  it('moves note shares inside a renamed folder, and the folder shares on it and below', async () => {
    await shareNote('ramona', 'Projekt/Plan.md');
    await h.runtime.app.createNote('julian', 'Projekt/Sub/Tief.md', 'tief\n', 'julian');
    await h.runtime.app.createNote('julian', 'Projektil.md', 'daneben\n', 'julian');
    h.runtime.shares.grant('julian', 'Projekt', 'peter', false);
    h.runtime.shares.grant('julian', 'Projekt/Sub', 'ramona', false);
    h.runtime.shares.grant('julian', 'Projektil.md', 'peter', false);

    const reply = await h.as('julian', {
      method: 'POST',
      url: '/api/v1/folders/rename',
      payload: { from: 'Projekt', to: 'Archiv/Projekt 2026' },
    });
    expect(reply.status).toBe(200);

    const all = h.runtime.shares
      .byOwner('julian')
      .map((share) => ({ kind: share.kind, path: share.prefix, grantee: share.grantee }))
      .sort((a, b) => `${a.grantee}${a.path}`.localeCompare(`${b.grantee}${b.path}`));
    expect(all).toEqual([
      { kind: 'folder', path: 'Archiv/Projekt 2026/', grantee: 'peter' },
      // A folder share on a folder merely starting with the same letters stays.
      { kind: 'folder', path: 'Projektil.md/', grantee: 'peter' },
      { kind: 'note', path: 'Archiv/Projekt 2026/Plan.md', grantee: 'ramona' },
      { kind: 'folder', path: 'Archiv/Projekt 2026/Sub/', grantee: 'ramona' },
    ]);
    expect(await reads('ramona', 'Archiv/Projekt 2026/Plan.md')).toBe(200);
    expect(await reads('peter', 'Archiv/Projekt 2026/Alt.md')).toBe(200);
  });

  it('follows a folder rename that only changes letter case', async () => {
    await shareNote('ramona', 'Projekt/Plan.md');
    h.runtime.shares.grant('julian', 'Projekt', 'peter', false);
    const reply = await h.as('julian', {
      method: 'POST',
      url: '/api/v1/folders/rename',
      payload: { from: 'Projekt', to: 'projekt' },
    });
    expect(reply.status).toBe(200);
    expect(await reads('ramona', 'projekt/Plan.md')).toBe(200);
    expect(await reads('peter', 'projekt/Alt.md')).toBe(200);
  });

  it('does not let a renamed note inherit a share that named its new path', async () => {
    // Peter was given Alt.md. That note vanished behind ndBrain's back, and
    // before anything noticed, Plan.md is renamed to Alt.md.
    await strandShare('peter', 'Projekt/Alt.md');
    await shareNote('ramona', 'Projekt/Plan.md');

    const reply = await h.as('julian', {
      method: 'POST',
      url: '/api/v1/rename',
      payload: { from: 'Projekt/Plan.md', to: 'Projekt/Alt.md' },
    });
    expect(reply.status).toBe(200);

    expect(noteShares()).toEqual([{ path: 'Projekt/Alt.md', grantee: 'ramona' }]);
    expect(await reads('peter', 'Projekt/Alt.md')).toBe(404);
    expect(await reads('ramona', 'Projekt/Alt.md')).toBe(200);
  });

  it('swaps two shared notes through a third name without mixing up the shares', async () => {
    await shareNote('ramona', 'Projekt/Plan.md');
    await shareNote('peter', 'Projekt/Alt.md');
    const rename = (from: string, to: string) =>
      h.as('julian', { method: 'POST', url: '/api/v1/rename', payload: { from, to } });

    expect((await rename('Projekt/Plan.md', 'Projekt/Tmp.md')).status).toBe(200);
    expect((await rename('Projekt/Alt.md', 'Projekt/Plan.md')).status).toBe(200);
    expect((await rename('Projekt/Tmp.md', 'Projekt/Alt.md')).status).toBe(200);

    const ramona = await h.as('ramona', { url: '/api/v1/notes/Projekt/Alt.md?owner=julian' });
    expect(ramona.body.note.content).toContain('geteilt');
    const peter = await h.as('peter', { url: '/api/v1/notes/Projekt/Plan.md?owner=julian' });
    expect(peter.body.note.content).toContain('für Peter');
    expect(await reads('ramona', 'Projekt/Plan.md')).toBe(404);
    expect(await reads('peter', 'Projekt/Alt.md')).toBe(404);
  });
});

describe('delete', () => {
  it('withdraws the share when the note is deleted, and a new note of that name gets nothing', async () => {
    await shareNote('ramona', 'Projekt/Plan.md');
    expect((await h.as('julian', { method: 'DELETE', url: '/api/v1/notes/Projekt/Plan.md' })).status).toBe(204);
    expect(noteShares()).toEqual([]);

    await h.as('julian', { method: 'PUT', url: '/api/v1/notes/Projekt/Plan.md', payload: { content: 'neu\n' } });
    expect(await reads('ramona', 'Projekt/Plan.md')).toBe(404);
  });

  it('withdraws it on a delete through the file route', async () => {
    await shareNote('ramona', 'Projekt/Plan.md');
    expect((await h.as('julian', { method: 'DELETE', url: '/api/v1/files/Projekt/Plan.md' })).status).toBe(204);
    expect(noteShares()).toEqual([]);
  });

  it('withdraws it on a bulk delete', async () => {
    await shareNote('ramona', 'Projekt/Plan.md');
    await shareNote('peter', 'Projekt/Alt.md');
    const reply = await h.as('julian', {
      method: 'POST',
      url: '/api/v1/bulk',
      payload: { owner: 'julian', paths: ['Projekt/Plan.md'], action: 'delete' },
    });
    expect(reply.body.ok).toEqual(['Projekt/Plan.md']);
    expect(noteShares()).toEqual([{ path: 'Projekt/Alt.md', grantee: 'peter' }]);
  });

  it('withdraws a share on a grantee-deleted note too', async () => {
    await shareNote('ramona', 'Projekt/Plan.md', true);
    expect(
      (await h.as('ramona', { method: 'DELETE', url: '/api/v1/notes/Projekt/Plan.md?owner=julian' })).status,
    ).toBe(204);
    expect(noteShares()).toEqual([]);
  });

  it('withdraws folder shares on a deleted folder', async () => {
    await h.runtime.app.createFolder('julian', 'Leer/Innen');
    h.runtime.shares.grant('julian', 'Leer/Innen', 'ramona', false);
    h.runtime.shares.grant('julian', 'Leer', 'peter', false);
    expect((await h.as('julian', { method: 'DELETE', url: '/api/v1/folders/Leer/Innen' })).status).toBe(204);
    expect(h.runtime.shares.byOwner('julian').map((share) => share.prefix)).toEqual(['Leer/']);
  });
});

describe('a new note never inherits', () => {
  it.each([
    ['a note PUT', async () => h.as('julian', { method: 'PUT', url: '/api/v1/notes/Projekt/Alt.md', payload: { content: 'neu' } })],
    [
      'a create-if-absent',
      async () =>
        h.as('julian', { method: 'PUT', url: '/api/v1/notes/Projekt/Alt.md', payload: { content: 'neu', ifAbsent: true } }),
    ],
    [
      'a file upload',
      async () => h.as('julian', { method: 'POST', url: '/api/v1/files/Projekt/Alt.md', payload: Buffer.from('neu') }),
    ],
  ])('from a stranded share, through %s', async (_name, create) => {
    await strandShare('peter', 'Projekt/Alt.md');
    const reply = await create();
    expect(reply.status).toBe(201);
    expect(noteShares()).toEqual([]);
    expect(await reads('peter', 'Projekt/Alt.md')).toBe(404);
  });

  it('from a stranded share, through an agent creating the note', async () => {
    await strandShare('peter', 'Projekt/Alt.md');
    const secret = h.runtime.keys.create('julian', 'agent', { canWrite: true }).secret;
    const reply = await h.tool(secret, 'create_note', { path: 'Projekt/Alt.md', content: 'vom agenten' });
    expect(reply.body.result.isError).toBeUndefined();
    expect(noteShares()).toEqual([]);
  });
});

describe('changes made around ndBrain', () => {
  async function startWatching(): Promise<VaultWatcher> {
    watcher = createWatcher(h.runtime);
    await watcher.start();
    // chokidar can miss a change made in the instant after `ready`; see watcher.test.ts.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return watcher;
  }

  /** Flushes until `check` holds, without falling back to reconciliation. */
  async function waitForWatcher(description: string, check: () => boolean): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await watcher?.flushNow();
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`the watcher never delivered: ${description}`);
  }

  const onDisk = (notePath: string): string => path.join(h.dataDir, 'vaults', 'julian', notePath);
  const indexed = (notePath: string): boolean =>
    h.runtime.app.queries.getNote('julian', 'julian', notePath) !== undefined;

  it('withdraws the share when the file is deleted, and a file of that name later gets nothing', async () => {
    await shareNote('ramona', 'Projekt/Plan.md');
    await startWatching();

    await fs.rm(onDisk('Projekt/Plan.md'));
    await waitForWatcher('Plan.md removed', () => !indexed('Projekt/Plan.md'));
    expect(noteShares()).toEqual([]);

    await fs.writeFile(onDisk('Projekt/Plan.md'), '# ganz andere Notiz\n', 'utf8');
    await waitForWatcher('the new Plan.md indexed', () => indexed('Projekt/Plan.md'));
    expect(await reads('ramona', 'Projekt/Plan.md')).toBe(404);
  });

  it.each([0, 300])('withdraws the share when a file is deleted and replaced %i ms later', async (gap) => {
    await shareNote('ramona', 'Projekt/Plan.md');
    await startWatching();

    await fs.rm(onDisk('Projekt/Plan.md'));
    if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
    await fs.writeFile(onDisk('Projekt/Plan.md'), '# ersetzt\n', 'utf8');
    await waitForWatcher('the replacement indexed', () =>
      h.runtime.app.queries.search('julian', 'ersetzt').length === 1,
    );
    expect(noteShares()).toEqual([]);
  });

  it('keeps the share through ndBrain\'s own saves, which replace the file atomically', async () => {
    await shareNote('ramona', 'Projekt/Plan.md', true);
    await startWatching();

    for (let i = 0; i < 5; i += 1) {
      await h.as('ramona', {
        method: 'PUT',
        url: '/api/v1/notes/Projekt/Plan.md?owner=julian',
        payload: { content: `# Plan\n\nFassung ${i}\n` },
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    await watcher?.flushNow();

    expect(noteShares()).toEqual([{ path: 'Projekt/Plan.md', grantee: 'ramona' }]);
    expect(await reads('ramona', 'Projekt/Plan.md')).toBe(200);
  });

  it('keeps shares through ndBrain\'s own renames, which the watcher sees as unlink and add', async () => {
    await shareNote('ramona', 'Projekt/Plan.md');
    await startWatching();
    await h.as('julian', {
      method: 'POST',
      url: '/api/v1/rename',
      payload: { from: 'Projekt/Plan.md', to: 'Projekt/Plan 2.md' },
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await watcher?.flushNow();
    expect(noteShares()).toEqual([{ path: 'Projekt/Plan 2.md', grantee: 'ramona' }]);
  });

  // The events alone cannot tell a replaced file from an edited one: a file
  // renamed over the note never leaves the path missing, and a delete followed
  // at once by a new file reaches chokidar as one `change` on every platform.
  // What does tell them apart is the file itself.
  it.each([
    [
      'a file renamed over it',
      async () => {
        await fs.writeFile(onDisk('Fremd.md'), '# fremd\n', 'utf8');
        await fs.rename(onDisk('Fremd.md'), onDisk('Projekt/Plan.md'));
      },
    ],
    [
      'a delete and a new file in one shell command',
      async () => {
        const file = onDisk('Projekt/Plan.md');
        execFileSync('sh', ['-c', 'rm "$1" && printf "# fremd\\n" > "$1"', 'sh', file]);
      },
    ],
  ])('withdraws the share when the note is replaced by %s', async (_name, replace) => {
    await shareNote('ramona', 'Projekt/Plan.md');
    await startWatching();

    await replace();
    await waitForWatcher('the replacement indexed', () =>
      h.runtime.app.queries.search('julian', 'fremd').length === 1,
    );
    expect(noteShares()).toEqual([]);
    expect(await reads('ramona', 'Projekt/Plan.md')).toBe(404);
  });

  it('keeps the share through an edit made in place by another program', async () => {
    await shareNote('ramona', 'Projekt/Plan.md');
    await startWatching();

    // Written into the same file, as nano, VS Code or Obsidian save.
    await fs.writeFile(onDisk('Projekt/Plan.md'), '# Plan\n\nvon draussen bearbeitet\n', 'utf8');
    await waitForWatcher('the edit indexed', () =>
      h.runtime.app.queries.search('julian', 'draussen').length === 1,
    );
    expect(noteShares()).toEqual([{ path: 'Projekt/Plan.md', grantee: 'ramona' }]);
    expect(await reads('ramona', 'Projekt/Plan.md')).toBe(200);
  });

  it('keeps the share when an upload through the file route replaces the note', async () => {
    await shareNote('ramona', 'Projekt/Plan.md');
    await startWatching();

    const reply = await h.as('julian', {
      method: 'POST',
      url: '/api/v1/files/Projekt/Plan.md',
      payload: Buffer.from('# Plan\n\nhochgeladen\n'),
    });
    expect(reply.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await watcher?.flushNow();
    await createWatcher(h.runtime).reconcile();
    expect(noteShares()).toEqual([{ path: 'Projekt/Plan.md', grantee: 'ramona' }]);
  });

  it('lets reconciliation withdraw a share whose note was replaced without any event', async () => {
    await shareNote('ramona', 'Projekt/Plan.md');
    await shareNote('peter', 'Projekt/Alt.md');
    await fs.writeFile(onDisk('Fremd.md'), '# fremd\n', 'utf8');
    await fs.rename(onDisk('Fremd.md'), onDisk('Projekt/Plan.md'));

    await createWatcher(h.runtime).reconcile();
    expect(noteShares()).toEqual([{ path: 'Projekt/Alt.md', grantee: 'peter' }]);
  });

  it('keeps a share whose note came back as a new file with the same text, as after a restore', async () => {
    await shareNote('ramona', 'Projekt/Plan.md');
    await startWatching();
    // Edited in place first, so the text it comes back with is not the text
    // it had when it was shared.
    await fs.writeFile(onDisk('Projekt/Plan.md'), '# Plan\n\nzweite Fassung\n', 'utf8');
    await waitForWatcher('the edit indexed', () =>
      h.runtime.app.queries.search('julian', 'Fassung').length === 1,
    );
    await watcher?.stop();
    watcher = null;

    // Copied out and back, as a restore onto another disk does: new file, same text.
    await fs.copyFile(onDisk('Projekt/Plan.md'), onDisk('Kopie.tmp'));
    await fs.rename(onDisk('Kopie.tmp'), onDisk('Projekt/Plan.md'));

    await syncAllVaults(h.runtime);
    expect(noteShares()).toEqual([{ path: 'Projekt/Plan.md', grantee: 'ramona' }]);
  });

  it('lets reconciliation withdraw a share whose file vanished without any event', async () => {
    await shareNote('ramona', 'Projekt/Plan.md');
    await shareNote('peter', 'Projekt/Alt.md');
    await fs.rm(onDisk('Projekt/Plan.md'));

    await createWatcher(h.runtime).reconcile();
    expect(noteShares()).toEqual([{ path: 'Projekt/Alt.md', grantee: 'peter' }]);
  });

  it('withdraws shares on notes that went while the server was down, on start', async () => {
    await shareNote('ramona', 'Projekt/Plan.md');
    await fs.rm(onDisk('Projekt/Plan.md'));
    await syncAllVaults(h.runtime);
    expect(noteShares()).toEqual([]);
  });
});
