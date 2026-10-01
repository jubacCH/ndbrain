/**
 * Capturing a thought into today's note, in one call.
 *
 * `POST /api/v1/append/*` already does the writing. What this route adds is the
 * part the browser does for itself and a native client cannot: where today's
 * note lives, what heading a thought goes under, and what the note starts with
 * when the day has not been written yet. All three come out of
 * `shared/journal.ts`, whose own header says there must be exactly one copy of
 * that pattern — so the Mac client does not get a second one, it asks here.
 *
 * What is pinned:
 *
 *  - the day's note is created at the journal path from the shared template, and
 *    the thought lands under `## Notizen` rather than at the end, which is under
 *    `## Links`;
 *  - the second thought of the same day goes into the same note, after the first;
 *  - the day comes from the caller and is checked: an impossible date is refused
 *    rather than filed under `50_Journal/2026/02/2026-02-30.md`;
 *  - naming somebody else's vault without write access looks like a vault that
 *    is not there, the same as everywhere else.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { startHarness, type Harness } from './support/harness.js';
import { NOTES_SECTION, dailyNoteTemplate } from '../../shared/journal.js';

let h: Harness;
let julian: string;
let ramona: string;

beforeEach(async () => {
  h = await startHarness('capture');
  const ids: Record<string, string> = {};
  for (const [login, password] of [
    ['julian', 'ein gutes passwort'],
    ['ramona', 'ihr gutes passwort'],
  ] as const) {
    ids[login] = (await h.runtime.users.create(login, password)).id;
    await h.login(login, password);
  }
  julian = ids['julian']!;
  ramona = ids['ramona']!;
});

afterEach(async () => {
  await h.close();
});

const capture = (
  user: string,
  payload: Record<string, unknown>,
): ReturnType<Harness['as']> => h.as(user, { method: 'POST', url: '/api/v1/capture', payload });

const read = (notePath: string): Promise<string> =>
  h.runtime.app.notes.getNote(julian, notePath).then((note) => note.content);

describe('POST /api/v1/capture', () => {
  it("starts the day's note from the shared template and answers 201", async () => {
    const reply = await capture('julian', { content: 'Ein Gedanke.', date: '2026-10-01' });

    expect(reply.status).toBe(201);
    expect(reply.body.note.path).toBe('50_Journal/2026/10/2026-10-01.md');

    // The template, not something this route spells out for itself.
    const content = await read('50_Journal/2026/10/2026-10-01.md');
    const template = dailyNoteTemplate({ year: 2026, month: 10, day: 1 });
    expect(content).toContain(template.split('\n')[7]); // the `# Donnerstag, 1. …` heading
    expect(content).toContain('## Aufgaben');
  });

  /**
   * The point of the section argument. A daily note ends with `## Links`, so a
   * thought appended to the end of the file reads as an unfinished link.
   */
  it('puts the thought under the notes heading, not at the end of the note', async () => {
    await capture('julian', { content: 'Ein Gedanke.', date: '2026-10-01' });

    const content = await read('50_Journal/2026/10/2026-10-01.md');
    expect(content).toContain(`## ${NOTES_SECTION}\n\nEin Gedanke.\n\n## Aufgaben`);
    expect(content.trimEnd().endsWith('Ein Gedanke.')).toBe(false);
  });

  it('adds the second thought of the day to the same note, after the first', async () => {
    await capture('julian', { content: 'Erster.', date: '2026-10-01' });
    const reply = await capture('julian', { content: 'Zweiter.', date: '2026-10-01' });

    expect(reply.status).toBe(200);
    expect(await read('50_Journal/2026/10/2026-10-01.md')).toContain(
      'Erster.\n\nZweiter.\n\n## Aufgaben',
    );
  });

  it('files a thought under the day the caller names, not the day the server is having', async () => {
    const reply = await capture('julian', { content: 'Von gestern.', date: '2025-01-09' });

    expect(reply.status).toBe(201);
    expect(reply.body.note.path).toBe('50_Journal/2025/01/2025-01-09.md');
  });

  it('refuses a day that does not exist instead of creating a note for it', async () => {
    const reply = await capture('julian', { content: 'Ein Gedanke.', date: '2026-02-30' });

    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe('invalid_body');
    expect(reply.body.message).toContain('date');
    await expect(read('50_Journal/2026/02/2026-02-30.md')).rejects.toThrow();
  });

  it('refuses a date that is not a date at all', async () => {
    const reply = await capture('julian', { content: 'Ein Gedanke.', date: '1. Oktober' });
    expect(reply.status).toBe(400);
  });

  it('refuses an empty thought', async () => {
    expect((await capture('julian', { content: '', date: '2026-10-01' })).status).toBe(400);
  });

  it('turns nobody away who is signed in, and everybody who is not', async () => {
    const reply = await h.server.inject({
      method: 'POST',
      url: '/api/v1/capture',
      payload: { content: 'Ein Gedanke.', date: '2026-10-01' },
    });
    expect(reply.statusCode).toBe(401);
  });

  /**
   * Refusal looks like absence, the rule the whole multi-tenant half rests on.
   * `ramona` may not write into `julian`'s vault, and is told what she would be
   * told about a vault that does not exist.
   */
  it("answers a thought aimed at somebody else's vault as if it were not there", async () => {
    const reply = await capture('ramona', {
      content: 'Fremder Gedanke.',
      date: '2026-10-01',
      owner: julian,
    });

    expect(reply.status).toBe(404);
    await expect(read('50_Journal/2026/10/2026-10-01.md')).rejects.toThrow();
  });
});
