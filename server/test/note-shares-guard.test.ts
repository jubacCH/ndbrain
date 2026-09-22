/**
 * A note share never comes to point at a different note — the ways around it.
 *
 * `note-shares-follow.test.ts` walks a note moving and going. This file pins
 * what a review of release 8 found still open, each from the side of whoever
 * would profit from the hole:
 *
 * - A bulk move checks every note's real destination, and folder operations
 *   are never covered by a note share whose path is spelled like the folder.
 * - A write by ndBrain in the moment between a file being replaced behind its
 *   back and the watcher noticing never carries the share over to the stranger
 *   — nor does a read in that moment show the stranger to the grantee.
 * - Without a birth time, a reused inode does not make a new file the old one.
 * - An equal hash vouches for a new file only when the content is substantial.
 * - A save that names the version it started from never creates a note, so a
 *   save racing a rename cannot leave one behind at the old path.
 * - The path of a conflict copy is named only to somebody who may read it.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RESCUE_MIN_BYTES, substantial } from '../src/auth/noteBindings.js';
import { createWatcher, syncAllVaults } from '../src/runtime.js';
import { startHarness, type Harness } from './support/harness.js';

vi.setConfig({ testTimeout: 30_000 });

let h: Harness;

beforeEach(async () => {
  h = await startHarness('guard');
  for (const [id, password] of [
    ['julian', 'ein gutes passwort'],
    ['ramona', 'ihr gutes passwort'],
  ] as const) {
    await h.runtime.users.create(id, password);
    await h.login(id, password);
  }
  const app = h.runtime.app;
  await app.createNote('julian', 'Projekt/Plan.md', '# Plan\n\ngeteilt [[Alt]]\n\n- [ ] eins\n', 'julian');
  await app.createNote('julian', 'Projekt/Alt.md', '# Alt\n', 'julian');
  await app.createNote('julian', 'Projekt/Geheim.md', '# Geheim\n\nnur für Julian\n', 'julian');
  await app.createNote('julian', 'Archiv/x.md', '# x\n', 'julian');
  await app.createNote('julian', 'x.md', '# x im Wurzelordner\n', 'julian');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await h.close();
});

const onDisk = (notePath: string): string => path.join(h.dataDir, 'vaults', 'julian', notePath);
const exists = (notePath: string): Promise<boolean> => fs.stat(onDisk(notePath)).then(() => true, () => false);

async function share(grantee: string, kind: 'note' | 'folder', sharePath: string, canWrite: boolean): Promise<void> {
  const reply = await h.as('julian', {
    method: 'POST',
    url: '/api/v1/shares',
    payload: { grantee, kind, path: sharePath, canWrite },
  });
  expect(reply.status).toBe(200);
}

function noteShares(): string[] {
  return h.runtime.shares
    .byOwner('julian')
    .filter((s) => s.kind === 'note')
    .map((s) => `${s.grantee}:${s.prefix}`);
}

const reads = async (user: string, notePath: string): Promise<number> =>
  (await h.as(user, { url: `/api/v1/notes/${encodeURI(notePath)}?owner=julian` })).status;

/** Puts a different file at `notePath` in one step, as `mv` over it does. */
async function replaceBehindTheBack(notePath: string, content: string): Promise<void> {
  await fs.writeFile(onDisk('Fremd.tmp'), content, 'utf8');
  await fs.rename(onDisk('Fremd.tmp'), onDisk(notePath));
}

// The replacement keeps what the writes below need to find (the task, the
// link), so each write really goes through and is not refused for a reason of
// its own.
const FOREIGN = '# Plan\n\ngeteilt [[Alt]]\n\n- [ ] eins\n\nfremder, privater Zusatz\n';

describe('B1: a bulk move checks where each note really goes', () => {
  it('refuses to move a note out of a shared folder through a note share on a stand-in path', async () => {
    await share('ramona', 'folder', 'Projekt', true);
    await share('ramona', 'note', 'Archiv/x.md', true);

    const reply = await h.as('ramona', {
      method: 'POST',
      url: '/api/v1/bulk',
      payload: { owner: 'julian', action: 'move', paths: ['Projekt/Geheim.md'], dir: 'Archiv' },
    });
    expect(reply.body.ok).toEqual([]);
    expect(reply.body.failed).toEqual([{ path: 'Projekt/Geheim.md', reason: 'note does not exist' }]);
    expect(await exists('Projekt/Geheim.md')).toBe(true);
    expect(await exists('Archiv/Geheim.md')).toBe(false);
  });

  it('refuses the vault root through a note share on a note in it', async () => {
    await share('ramona', 'folder', 'Projekt', true);
    await share('ramona', 'note', 'x.md', true);

    const reply = await h.as('ramona', {
      method: 'POST',
      url: '/api/v1/bulk',
      payload: { owner: 'julian', action: 'move', paths: ['Projekt/Geheim.md'], dir: '' },
    });
    expect(reply.body.ok).toEqual([]);
    expect(await exists('Geheim.md')).toBe(false);
  });

  it('still moves between two folders the grantee may write', async () => {
    await share('ramona', 'folder', 'Projekt', true);
    h.runtime.shares.grant('julian', 'Archiv', 'ramona', true);

    const reply = await h.as('ramona', {
      method: 'POST',
      url: '/api/v1/bulk',
      payload: { owner: 'julian', action: 'move', paths: ['Projekt/Geheim.md'], dir: 'Archiv' },
    });
    expect(reply.body.ok).toEqual(['Archiv/Geheim.md']);
  });

  it('checks each note on its own: one allowed destination does not carry another', async () => {
    await share('ramona', 'folder', 'Projekt', true);
    // A note share on exactly where Geheim.md would land, nothing for Alt.md.
    await h.runtime.app.createNote('julian', 'Archiv/Geheim.md', '# Platzhalter\n', 'julian');
    await share('ramona', 'note', 'Archiv/Geheim.md', true);
    await h.runtime.app.deleteNote('julian', 'Archiv/Geheim.md', 'julian');
    h.runtime.shares.grant('julian', { kind: 'note', path: 'Archiv/Geheim.md' }, 'ramona', true);

    const reply = await h.as('ramona', {
      method: 'POST',
      url: '/api/v1/bulk',
      payload: { owner: 'julian', action: 'move', paths: ['Projekt/Alt.md'], dir: 'Archiv' },
    });
    expect(reply.body.ok).toEqual([]);
    expect(await exists('Archiv/Alt.md')).toBe(false);
  });
});

describe('B1: a folder operation is never covered by a note share', () => {
  it('refuses to rename a folder to a path spelled like a shared note', async () => {
    await share('ramona', 'folder', 'Projekt', true);
    await h.runtime.app.createNote('julian', 'Projekt/Sub/Tief.md', '# Tief\n', 'julian');
    await share('ramona', 'note', 'Archiv/x.md', true);

    const reply = await h.as('ramona', {
      method: 'POST',
      url: '/api/v1/folders/rename',
      payload: { owner: 'julian', from: 'Projekt/Sub', to: 'Archiv/x.md' },
    });
    expect(reply.status).toBe(404);
    expect(await exists('Projekt/Sub/Tief.md')).toBe(true);
  });

  it('refuses to create or delete a folder by that name', async () => {
    await share('ramona', 'note', 'Archiv/x.md', true);
    const created = await h.as('ramona', {
      method: 'POST',
      url: '/api/v1/folders',
      payload: { owner: 'julian', path: 'Archiv/x.md' },
    });
    const deleted = await h.as('ramona', { method: 'DELETE', url: '/api/v1/folders/Archiv/x.md?owner=julian' });
    expect([created.status, deleted.status]).toEqual([404, 404]);
  });
});

describe('B2: a write before the watcher has spoken carries no share to a stranger', () => {
  const writes: Array<[string, () => Promise<unknown>]> = [
    [
      'a bulk tag',
      () => h.as('julian', { method: 'POST', url: '/api/v1/bulk', payload: { action: 'tag', paths: ['Projekt/Plan.md'], tag: 'x' } }),
    ],
    [
      'a task toggle',
      () =>
        h.as('julian', {
          method: 'POST',
          url: '/api/v1/tasks/toggle',
          payload: { path: 'Projekt/Plan.md', line: 5, expectedText: 'eins', expectedDone: false, done: true },
        }),
    ],
    [
      'an agent appending',
      () => h.tool(h.runtime.keys.create('julian', 'agent', { canWrite: true }).secret, 'append_note', { path: 'Projekt/Plan.md', content: 'vom agenten' }),
    ],
    [
      'an agent editing',
      () =>
        h.tool(h.runtime.keys.create('julian', 'agent', { canWrite: true }).secret, 'edit_note', {
          path: 'Projekt/Plan.md',
          find: 'eins',
          replace: 'zwei',
        }),
    ],
    [
      'an upload through the file route',
      () => h.as('julian', { method: 'POST', url: '/api/v1/files/Projekt/Plan.md', payload: Buffer.from(`${FOREIGN}hochgeladen\n`) }),
    ],
    [
      'a save by the owner',
      () => h.as('julian', { method: 'PUT', url: '/api/v1/notes/Projekt/Plan.md', payload: { content: `${FOREIGN}gespeichert\n` } }),
    ],
    [
      'an append by the owner',
      () => h.as('julian', { method: 'POST', url: '/api/v1/append/Projekt/Plan.md', payload: { content: 'angehängt' } }),
    ],
    [
      'a link rewrite from renaming the note it links to',
      () => h.as('julian', { method: 'POST', url: '/api/v1/rename', payload: { from: 'Projekt/Alt.md', to: 'Projekt/Alt 2.md' } }),
    ],
  ];

  it.each(writes)('withdraws the share on %s', async (_name, write) => {
    await share('ramona', 'note', 'Projekt/Plan.md', false);
    await replaceBehindTheBack('Projekt/Plan.md', FOREIGN);

    await write();
    // Before any watcher, reconciliation or read could have looked.
    expect(noteShares()).toEqual([]);
    expect(await reads('ramona', 'Projekt/Plan.md')).toBe(404);
  });

  it('withdraws the share on a bulk untag', async () => {
    await share('ramona', 'note', 'Projekt/Plan.md', false);
    // Untagging writes only where the tag is there to remove.
    await replaceBehindTheBack('Projekt/Plan.md', '---\ntags: [fremd]\n---\n# Fremd\n\nprivat\n');

    const reply = await h.as('julian', { method: 'POST', url: '/api/v1/bulk', payload: { action: 'untag', paths: ['Projekt/Plan.md'], tag: 'fremd' } });
    expect(reply.body.ok).toEqual(['Projekt/Plan.md']);
    expect(noteShares()).toEqual([]);
  });

  it('does not carry the share along when the replaced note is renamed', async () => {
    await share('ramona', 'note', 'Projekt/Plan.md', false);
    await replaceBehindTheBack('Projekt/Plan.md', FOREIGN);

    const reply = await h.as('julian', { method: 'POST', url: '/api/v1/rename', payload: { from: 'Projekt/Plan.md', to: 'Projekt/Plan 2.md' } });
    expect(reply.status).toBe(200);
    expect(noteShares()).toEqual([]);
    expect(await reads('ramona', 'Projekt/Plan 2.md')).toBe(404);
  });

  it('keeps a share that was the file all along through the same writes', async () => {
    await share('ramona', 'note', 'Projekt/Plan.md', false);
    for (const [, write] of writes) await write();
    expect(noteShares()).toEqual(['ramona:Projekt/Plan.md']);
    expect(await reads('ramona', 'Projekt/Plan.md')).toBe(200);
  });

  it('shows the grantee nothing of a replacement the watcher has not reported yet', async () => {
    await share('ramona', 'note', 'Projekt/Plan.md', false);
    await replaceBehindTheBack('Projekt/Plan.md', FOREIGN);

    for (const url of [
      '/api/v1/notes/Projekt/Plan.md?owner=julian',
      '/api/v1/files/Projekt/Plan.md?owner=julian',
      '/api/v1/history/Projekt/Plan.md?owner=julian',
    ]) {
      const reply = await h.as('ramona', { url });
      expect({ url, status: reply.status }).toEqual({ url, status: 404 });
      expect(reply.raw).not.toContain('privater Zusatz');
    }
    expect(noteShares()).toEqual([]);
  });
});

describe('B3: without a birth time, a reused inode is not the same file', () => {
  /** A filesystem that keeps no birth time and hands the freed inode to the next file. */
  function withoutBirthTime(): void {
    const real = fs.stat.bind(fs);
    vi.spyOn(fs, 'stat').mockImplementation((async (target: string, options?: { bigint?: boolean }) => {
      const stat = await real(target, options as never);
      if (options?.bigint !== true || !String(target).endsWith(path.join('Projekt', 'Plan.md'))) return stat;
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
        dev: 1n,
        ino: 4711n,
        birthtimeNs: 0n,
      });
    }) as typeof fs.stat);
  }

  it('withdraws the share when the file is replaced by one with other content', async () => {
    withoutBirthTime();
    await share('ramona', 'note', 'Projekt/Plan.md', false);

    await fs.rm(onDisk('Projekt/Plan.md'));
    await fs.writeFile(onDisk('Projekt/Plan.md'), '# ganz andere Notiz\n', 'utf8');
    await h.runtime.app.noteChanged('julian', 'Projekt/Plan.md');

    expect(noteShares()).toEqual([]);
  });

  it('keeps it through ndBrain\'s own saves and renames all the same', async () => {
    withoutBirthTime();
    await share('ramona', 'note', 'Projekt/Plan.md', true);

    const saved = await h.as('ramona', { method: 'PUT', url: '/api/v1/notes/Projekt/Plan.md?owner=julian', payload: { content: '# Plan\n\nneu\n' } });
    expect(saved.status).toBe(200);
    await h.runtime.app.noteChanged('julian', 'Projekt/Plan.md');
    expect(noteShares()).toEqual(['ramona:Projekt/Plan.md']);
  });
});

describe('B5: an equal hash vouches only for substantial content', () => {
  it('does not keep a share through an empty file put in place and filled later', async () => {
    await share('ramona', 'note', 'Projekt/Plan.md', true);
    const emptied = await h.as('ramona', { method: 'PUT', url: '/api/v1/notes/Projekt/Plan.md?owner=julian', payload: { content: '# Plan\n\nkurz\n' } });
    expect(emptied.status).toBe(200);

    await replaceBehindTheBack('Projekt/Plan.md', '# Plan\n\nkurz\n');
    await h.runtime.app.noteChanged('julian', 'Projekt/Plan.md');
    await fs.writeFile(onDisk('Projekt/Plan.md'), '# Plan\n\nkurz\n\nund jetzt eine neue private Notiz\n', 'utf8');
    await h.runtime.app.noteChanged('julian', 'Projekt/Plan.md');

    expect(noteShares()).toEqual([]);
    expect(await reads('ramona', 'Projekt/Plan.md')).toBe(404);
  });

  it('draws the line at non-whitespace bytes', () => {
    expect(RESCUE_MIN_BYTES).toBe(64);
    expect(substantial('')).toBe(false);
    expect(substantial(`${' \n\t'.repeat(100)}${'a'.repeat(63)}`)).toBe(false);
    expect(substantial('a'.repeat(64))).toBe(true);
  });
});

describe('R5: the file is looked at twice around its content', () => {
  it('withdraws a share when the file changes while it is read', async () => {
    const text = `# Plan\n\n${'wiederhergestellt '.repeat(8)}\n`;
    await h.runtime.app.putNote('julian', 'Projekt/Plan.md', text, 'julian');
    await share('ramona', 'note', 'Projekt/Plan.md', false);
    // Same substantial content in a new file, so the hash alone would keep it —
    // but the file is swapped once more between the two looks.
    await replaceBehindTheBack('Projekt/Plan.md', text);
    const vault = h.runtime.notes.vault;
    const real = vault.fileIdentity.bind(vault);
    let calls = 0;
    vi.spyOn(vault, 'fileIdentity').mockImplementation(async (owner, notePath) => {
      calls += 1;
      const identity = await real(owner, notePath);
      return calls === 2 ? `${identity}-swapped` : identity;
    });

    await h.runtime.app.noteChanged('julian', 'Projekt/Plan.md');
    expect(noteShares()).toEqual([]);
  });
});

describe('B4: a save that names its version never creates a note', () => {
  it('answers 404 and writes nothing when the note is gone', async () => {
    const reply = await h.as('julian', {
      method: 'PUT',
      url: '/api/v1/notes/Projekt/Weg.md',
      payload: { content: '# Weg\n', baseMtimeMs: Date.now() },
    });
    expect(reply.status).toBe(404);
    expect(await exists('Projekt/Weg.md')).toBe(false);
  });

  it('leaves nothing at the old path when a grantee saves while the owner renames', async () => {
    await share('ramona', 'note', 'Projekt/Plan.md', true);
    let from = 'Projekt/Plan.md';
    let stray = 0;
    for (let i = 0; i < 20; i += 1) {
      const to = `Projekt/Plan-${i}.md`;
      const [renamed, saved] = await Promise.all([
        h.as('julian', { method: 'POST', url: '/api/v1/rename', payload: { from, to } }),
        h.as('ramona', {
          method: 'PUT',
          url: `/api/v1/notes/${encodeURI(from)}?owner=julian`,
          payload: { content: `# Plan\n\nramona ${i}\n`, baseMtimeMs: Date.now() },
        }),
      ]);
      expect(renamed.status).toBe(200);
      expect([200, 404]).toContain(saved.status);
      if (await exists(from)) stray += 1;
      expect(noteShares()).toEqual([`ramona:${to}`]);
      from = to;
    }
    expect(stray).toBe(0);
  });

  it('still creates a note when no version is named', async () => {
    const reply = await h.as('julian', { method: 'PUT', url: '/api/v1/notes/Projekt/Neu.md', payload: { content: '# Neu\n' } });
    expect(reply.status).toBe(201);
  });
});

describe('B7: the path of a conflict copy', () => {
  it('is not named to a grantee of the note alone, and is to the owner', async () => {
    await share('ramona', 'note', 'Projekt/Plan.md', true);
    const asRamona = await h.as('ramona', {
      method: 'PUT',
      url: '/api/v1/notes/Projekt/Plan.md?owner=julian',
      payload: { content: '# Plan\n\nramona\n', baseMtimeMs: 1 },
    });
    expect(asRamona.status).toBe(200);
    expect(asRamona.body.conflictCopy).toBeUndefined();
    expect(asRamona.raw).not.toContain('Konflikt');
    // The copy was made all the same.
    expect(h.runtime.app.queries.conflictCopies('julian')).toHaveLength(1);

    const asJulian = await h.as('julian', {
      method: 'PUT',
      url: '/api/v1/notes/Projekt/Plan.md',
      payload: { content: '# Plan\n\njulian\n', baseMtimeMs: 1 },
    });
    expect(typeof asJulian.body.conflictCopy).toBe('string');
  });

  it('is named to a grantee of the folder the copy lies in', async () => {
    await share('ramona', 'folder', 'Projekt', true);
    const reply = await h.as('ramona', {
      method: 'PUT',
      url: '/api/v1/notes/Projekt/Plan.md?owner=julian',
      payload: { content: '# Plan\n\nramona\n', baseMtimeMs: 1 },
    });
    expect(typeof reply.body.conflictCopy).toBe('string');
  });
});

// Kept here because it is the same guarantee from the shell's side: a delete and
// a new file in one command, which the watcher alone cannot tell from an edit.
describe('a shell replacing the file in one command', () => {
  it('withdraws the share at the next look', async () => {
    await share('ramona', 'note', 'Projekt/Plan.md', false);
    execFileSync('sh', ['-c', 'rm "$1" && printf "# fremd\\n" > "$1"', 'sh', onDisk('Projekt/Plan.md')]);
    await h.runtime.app.dropDanglingShares('julian');
    expect(noteShares()).toEqual([]);
  });
});

/**
 * What the confirmation costs, and who pays it.
 *
 * Confirming a binding takes the note's lock, a `stat` and a hash of the file;
 * a path no note share names takes one query. Run for every signed-in caller,
 * that difference is a clock anybody can read: it says which of the owner's
 * paths are shared with somebody.
 */
describe('a read confirms only for somebody who holds a note share on that path', () => {
  it('does not look at the file for a caller the path is not shared with', async () => {
    await share('ramona', 'note', 'Projekt/Plan.md', false);
    await h.runtime.users.create('anna', 'ihr gutes passwort');
    await h.login('anna', 'ihr gutes passwort');
    await share('anna', 'folder', 'Projekt', false);

    const confirm = vi.spyOn(h.runtime.app, 'noteChanged');

    expect(await reads('anna', 'Projekt/Plan.md')).toBe(200);
    expect(await reads('anna', 'Projekt/Geheim.md')).toBe(200);
    expect(confirm).not.toHaveBeenCalled();

    // The grantee of the note herself pays it, and learns nothing from it that
    // she does not already hold.
    expect(await reads('ramona', 'Projekt/Plan.md')).toBe(200);
    expect(confirm).toHaveBeenCalledWith('julian', 'Projekt/Plan.md');
  });

  it('still keeps the replacement from the grantee', async () => {
    await share('ramona', 'note', 'Projekt/Plan.md', false);
    await replaceBehindTheBack('Projekt/Plan.md', FOREIGN);

    expect(await reads('ramona', 'Projekt/Plan.md')).toBe(404);
    expect(noteShares()).toEqual([]);
  });

  it('writes no binding back when it already says what it would say', async () => {
    await share('ramona', 'note', 'Projekt/Plan.md', false);
    const bind = vi.spyOn(h.runtime.shares, 'bindNote');

    expect(await reads('ramona', 'Projekt/Plan.md')).toBe(200);
    expect(await reads('ramona', 'Projekt/Plan.md')).toBe(200);
    expect(bind).not.toHaveBeenCalled();

    // An edit made in place is a change of content, and that one is written.
    await fs.appendFile(onDisk('Projekt/Plan.md'), 'ein Absatz von julian\n');
    expect(await reads('ramona', 'Projekt/Plan.md')).toBe(200);
    expect(bind).toHaveBeenCalledTimes(1);
  });
});

describe('the file listing of a shared vault', () => {
  it('describes no note whose file was replaced behind ndBrain’s back', async () => {
    await share('ramona', 'note', 'Projekt/Plan.md', false);
    const before = await h.as('ramona', { url: '/api/v1/files?owner=julian' });
    expect(before.body.files.map((file: { path: string }) => file.path)).toEqual(['Projekt/Plan.md']);

    await replaceBehindTheBack('Projekt/Plan.md', FOREIGN);

    // Not its size, not its modification time, not its name: the listing is a
    // read of the file like any other.
    const after = await h.as('ramona', { url: '/api/v1/files?owner=julian' });
    expect(after.status).toBe(404);
    expect(noteShares()).toEqual([]);
  });

  it('says so when the walk stopped short of the whole vault', async () => {
    await share('ramona', 'folder', 'Projekt', false);
    vi.spyOn(h.runtime.app.notes.vault, 'listAll').mockResolvedValue({
      files: [{ path: 'Projekt/Plan.md', size: 10, mtimeMs: 1, isNote: true }],
      dirs: ['Projekt'],
      truncated: true,
    });

    const listed = await h.runtime.app.listFilesIn('ramona', 'julian');
    expect(listed?.truncated).toBe(true);
  });
});

/**
 * Reconciliation is the repair for events the watcher never received — so the
 * file it finds replaced has been shared under the wrong name for as long as
 * five minutes. Indexing it first would put the stranger's words into the
 * grantee's search, tasks and tags for the length of one sync.
 */
describe('the reconcile and the start confirm before they index', () => {
  it('has withdrawn the share by the time the vault is indexed', async () => {
    await share('ramona', 'note', 'Projekt/Plan.md', false);
    await replaceBehindTheBack('Projekt/Plan.md', FOREIGN);

    const indexer = h.runtime.indexer;
    const realSync = indexer.sync.bind(indexer);
    const sharesWhenIndexed: string[][] = [];
    vi.spyOn(indexer, 'sync').mockImplementation(async (owner: string) => {
      if (owner === 'julian') sharesWhenIndexed.push(noteShares());
      return realSync(owner);
    });

    await createWatcher(h.runtime).reconcile();
    expect(sharesWhenIndexed).toEqual([[]]);

    // And the same on start-up, for whatever changed while the process was down.
    await share('ramona', 'note', 'Projekt/Alt.md', false);
    await replaceBehindTheBack('Projekt/Alt.md', FOREIGN);
    sharesWhenIndexed.length = 0;
    await syncAllVaults(h.runtime);
    expect(sharesWhenIndexed).toEqual([[]]);
  });
});
