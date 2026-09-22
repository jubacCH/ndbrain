/**
 * Appending to a note, over HTTP.
 *
 * The quick-capture field on the start page throws a thought at today's note
 * without opening it. Doing that as a read-modify-write from the browser would
 * race the editor — the same note may be open in another tab holding text that
 * has not been saved yet — so the whole operation happens on the server, inside
 * the note's own write lock.
 *
 * What is pinned here:
 *
 *  - the text lands, with a blank line between it and what was there;
 *  - a note that is not there yet is created from the template the caller sends,
 *    and refused when it sends none;
 *  - two appends racing each other lose nothing, which is the property that
 *    only holds because read and write are under one lock;
 *  - the text goes at the end of a named section rather than at the end of the
 *    file, so a thought does not land under the daily note's "Links";
 *  - a grantee without write access is answered exactly as for a note that does
 *    not exist.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { appended } from '../src/markdown/edit.js';
import { startHarness, type Harness } from './support/harness.js';

let h: Harness;

beforeEach(async () => {
  h = await startHarness('append');
  for (const [id, password] of [
    ['julian', 'ein gutes passwort'],
    ['ramona', 'ihr gutes passwort'],
  ] as const) {
    await h.runtime.users.create(id, password);
    await h.login(id, password);
  }
});

afterEach(async () => {
  await h.close();
});

const read = (notePath: string): Promise<string> =>
  h.runtime.app.notes.getNote('julian', notePath).then((note) => note.content);

const append = (
  user: string,
  notePath: string,
  payload: Record<string, unknown>,
): ReturnType<Harness['as']> =>
  h.as(user, { method: 'POST', url: `/api/v1/append/${encodeURI(notePath)}`, payload });

const TEMPLATE = '# Tag\n\n## Notizen\n\n## Aufgaben\n- [ ]\n\n## Links\n';

describe('where the text goes', () => {
  it('separates the addition from what was there by one blank line', () => {
    expect(appended('Bestand.', 'Zusatz.')).toBe('Bestand.\n\nZusatz.');
    expect(appended('Bestand.\n', 'Zusatz.')).toBe('Bestand.\n\nZusatz.');
    expect(appended('Bestand.\n\n', 'Zusatz.')).toBe('Bestand.\n\nZusatz.');
  });

  it('puts the addition at the end of a named section, not at the end of the note', () => {
    expect(appended(TEMPLATE, 'Ein Gedanke.', 'Notizen')).toBe(
      '# Tag\n\n## Notizen\n\nEin Gedanke.\n\n## Aufgaben\n- [ ]\n\n## Links\n',
    );
  });

  it('keeps the order of a section it has already written into', () => {
    const once = appended(TEMPLATE, 'Erster.', 'Notizen');
    expect(appended(once, 'Zweiter.', 'Notizen')).toContain('Erster.\n\nZweiter.\n\n## Aufgaben');
  });

  it('keeps a multi-line thought as its own lines', () => {
    expect(appended(TEMPLATE, 'Eins\nZwei', 'Notizen')).toContain('## Notizen\n\nEins\nZwei\n\n## Aufgaben');
  });

  it('stops the section at the next heading of the same or a higher level', () => {
    const source = '# Tag\n\n## Notizen\n\n### Unterpunkt\n\nText.\n\n## Aufgaben\n';
    expect(appended(source, 'Neu.', 'Notizen')).toBe(
      '# Tag\n\n## Notizen\n\n### Unterpunkt\n\nText.\n\nNeu.\n\n## Aufgaben\n',
    );
  });

  /**
   * The text must land somewhere. A note whose section somebody renamed is not
   * a reason to refuse a thought — losing it is the one outcome this field may
   * never have.
   */
  it('falls back to the end of the note when the section is not there', () => {
    expect(appended('# Tag\n\n## Anderes\n', 'Neu.', 'Notizen')).toBe('# Tag\n\n## Anderes\n\nNeu.');
  });
});

describe('POST /api/v1/append/*', () => {
  it('appends to a note that is there', async () => {
    await h.runtime.app.createNote('julian', 'Plan.md', 'Bestand.\n', 'julian');

    const reply = await append('julian', 'Plan.md', { content: 'Zusatz.' });

    expect(reply.status).toBe(200);
    expect(reply.body.created).toBe(false);
    expect(await read('Plan.md')).toBe('Bestand.\n\nZusatz.');
  });

  it('creates the note from the text the caller sends when it is not there', async () => {
    const reply = await append('julian', '50_Journal/2026/09/2026-09-22.md', {
      content: 'Ein Gedanke.',
      section: 'Notizen',
      ifAbsent: TEMPLATE,
    });

    expect(reply.status).toBe(201);
    expect(reply.body.created).toBe(true);
    expect(await read('50_Journal/2026/09/2026-09-22.md')).toContain('## Notizen\n\nEin Gedanke.\n\n## Aufgaben');
  });

  it('indexes a note it created, rather than leaving it out of the search', async () => {
    await append('julian', '50_Journal/2026/09/2026-09-22.md', {
      content: 'unverwechselbarer Gedanke',
      section: 'Notizen',
      ifAbsent: TEMPLATE,
    });

    const hits = h.runtime.app.queries.search('julian', 'unverwechselbarer');
    expect(hits.map((hit) => hit.path)).toContain('50_Journal/2026/09/2026-09-22.md');
  });

  it('indexes an append into a note that was already there', async () => {
    await h.runtime.app.createNote('julian', 'Plan.md', 'Bestand.\n', 'julian');
    await append('julian', 'Plan.md', { content: 'unverwechselbarer Zusatz' });

    const hits = h.runtime.app.queries.search('julian', 'unverwechselbarer');
    expect(hits.map((hit) => hit.path)).toContain('Plan.md');
  });

  it('refuses a note that is not there when no starting text came with the request', async () => {
    const reply = await append('julian', 'Fehlt.md', { content: 'Zusatz.' });
    expect(reply.status).toBe(404);
  });

  /**
   * The property the endpoint exists for. Read and write sit inside the same
   * lock, so of two appends one waits for the other and reads what it wrote;
   * a read-modify-write from the browser would lose whichever finished first.
   */
  it('loses nothing when two appends race', async () => {
    await h.runtime.app.createNote('julian', 'Plan.md', 'Bestand.\n', 'julian');

    const replies = await Promise.all([
      append('julian', 'Plan.md', { content: 'Erster.' }),
      append('julian', 'Plan.md', { content: 'Zweiter.' }),
    ]);

    expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
    const content = await read('Plan.md');
    expect(content).toContain('Erster.');
    expect(content).toContain('Zweiter.');
  });

  it('loses nothing when two appends race into the same section', async () => {
    await h.runtime.app.createNote('julian', 'Tag.md', TEMPLATE, 'julian');

    await Promise.all([
      append('julian', 'Tag.md', { content: 'Erster.', section: 'Notizen' }),
      append('julian', 'Tag.md', { content: 'Zweiter.', section: 'Notizen' }),
    ]);

    const content = await read('Tag.md');
    expect(content).toContain('Erster.');
    expect(content).toContain('Zweiter.');
    // Both still under the heading they were addressed to.
    expect(content.indexOf('Erster.')).toBeLessThan(content.indexOf('## Aufgaben'));
    expect(content.indexOf('Zweiter.')).toBeLessThan(content.indexOf('## Aufgaben'));
  });

  it('never leaves a conflict copy: nothing is displaced by an append', async () => {
    await h.runtime.app.createNote('julian', 'Plan.md', 'Bestand.\n', 'julian');
    await append('julian', 'Plan.md', { content: 'Zusatz.' });

    const copies = (await h.runtime.app.notes.listNotes('julian'))
      .map((entry) => entry.path)
      .filter((notePath) => notePath.includes('Konflikt'));
    expect(copies).toEqual([]);
  });
});

describe('refusal looks like absence', () => {
  it('answers a grantee without write access as it answers a note that is not there', async () => {
    await h.runtime.app.createNote('julian', 'Projekt/Plan.md', 'Bestand.\n', 'julian');
    const granted = await h.as('julian', {
      method: 'POST',
      url: '/api/v1/shares',
      payload: { grantee: 'ramona', kind: 'folder', path: 'Projekt', canWrite: false },
    });
    expect(granted.status).toBe(200);

    const refused = await h.as('ramona', {
      method: 'POST',
      url: `/api/v1/append/${encodeURI('Projekt/Plan.md')}`,
      payload: { content: 'Zusatz.', owner: 'julian' },
    });
    const absent = await h.as('ramona', {
      method: 'POST',
      url: `/api/v1/append/${encodeURI('Projekt/Gibtsnicht.md')}`,
      payload: { content: 'Zusatz.', owner: 'julian' },
    });

    expect(refused.status).toBe(404);
    expect(refused.status).toBe(absent.status);
    expect(refused.body).toEqual(absent.body);
    expect(await read('Projekt/Plan.md')).toBe('Bestand.\n');
  });

  it('refuses to create a note in a vault the caller may not write to', async () => {
    const reply = await h.as('ramona', {
      method: 'POST',
      url: `/api/v1/append/${encodeURI('Privat/Neu.md')}`,
      payload: { content: 'Zusatz.', ifAbsent: TEMPLATE, owner: 'julian' },
    });

    expect(reply.status).toBe(404);
    await expect(h.runtime.app.notes.getNote('julian', 'Privat/Neu.md')).rejects.toThrow();
  });

  /**
   * The window `Authorized` exists for, from the side of whoever would profit.
   *
   * Ramona may write this one note. Somebody puts a different file on that path
   * behind ndBrain's back — `mv` over it — and until the watcher notices, the
   * route's own check still says yes, because the shares table still names the
   * path. The check made again inside the lock, after `confirm` has withdrawn
   * the share, is the only thing between her text and a stranger's file.
   */
  it('refuses the write when the file was replaced since the route said yes', async () => {
    await h.runtime.app.createNote('julian', 'Projekt/Plan.md', 'Bestand.\n', 'julian');
    await h.as('julian', {
      method: 'POST',
      url: '/api/v1/shares',
      payload: { grantee: 'ramona', kind: 'note', path: 'Projekt/Plan.md', canWrite: true },
    });

    const onDisk = path.join(h.dataDir, 'vaults', 'julian', 'Projekt', 'Plan.md');
    const stranger = path.join(h.dataDir, 'vaults', 'julian', 'Projekt', 'Fremd.tmp');
    await fs.writeFile(stranger, '# Fremd\n\nfremder, privater Text\n', 'utf8');
    await fs.rename(stranger, onDisk);

    const reply = await h.as('ramona', {
      method: 'POST',
      url: `/api/v1/append/${encodeURI('Projekt/Plan.md')}`,
      payload: { content: 'Von Ramona.', owner: 'julian' },
    });

    expect(reply.status).toBe(404);
    expect(await read('Projekt/Plan.md')).not.toContain('Von Ramona.');
    expect(h.runtime.shares.byOwner('julian').filter((entry) => entry.kind === 'note')).toEqual([]);
  });

  it('lets a grantee with write access append', async () => {
    await h.runtime.app.createNote('julian', 'Projekt/Plan.md', 'Bestand.\n', 'julian');
    await h.as('julian', {
      method: 'POST',
      url: '/api/v1/shares',
      payload: { grantee: 'ramona', kind: 'folder', path: 'Projekt', canWrite: true },
    });

    const reply = await h.as('ramona', {
      method: 'POST',
      url: `/api/v1/append/${encodeURI('Projekt/Plan.md')}`,
      payload: { content: 'Von Ramona.', owner: 'julian' },
    });

    expect(reply.status).toBe(200);
    expect(await read('Projekt/Plan.md')).toContain('Von Ramona.');
  });
});
