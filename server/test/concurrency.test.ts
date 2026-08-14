/**
 * Two writers, one note.
 *
 * The conflict copy was built in phase 7 for shared notes, but the writer it
 * matters most for is the one you cannot see: an agent writing through MCP. It
 * reads a note, thinks, and writes it back, and anything a person typed inside
 * that window is what gets lost. These tests exist because the protection was
 * built and then not connected to that path.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { TOOLS, type ToolContext } from '../src/mcp/tools.js';
import { UnlinkableNameError } from '../src/errors.js';

let dataDir: string;
let runtime: Runtime;
let context: ToolContext;

const tool = (name: string) => {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no such tool: ${name}`);
  return found;
};

/** Makes the next write land on a later second than the read. */
const tick = () => new Promise((r) => setTimeout(r, 1100));

/**
 * Opens the race deliberately: the next time the agent reads this note, a person
 * saves it before the agent gets to write.
 *
 * The window being tested lives *inside* one tool call — between its read and
 * its write — so it cannot be reached by ordering calls from the outside. This
 * wraps the read instead, which is the only deterministic way to land a write in
 * the middle of it. Everything after the wrapper behaves exactly as in
 * production; nothing about the write path is stubbed.
 */
async function personSavesDuringNextRead(notePath: string, content: string): Promise<void> {
  const service = runtime.app.notes;
  const read = service.getNote.bind(service);
  let armed = true;

  (service as unknown as { getNote: typeof read }).getNote = async (owner: string, p: string) => {
    const note = await read(owner, p);
    if (armed && p === notePath) {
      armed = false;
      await tick();
      await runtime.app.putNote(owner, p, content, 'julian');
    }
    return note;
  };
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-conc-'));
  runtime = await createRuntime({ ...loadConfig(), dataDir });
  await runtime.users.create('julian', 'ein gutes passwort');

  const key = runtime.keys.create('julian', 'test-agent', { canWrite: true });
  context = {
    app: runtime.app,
    keys: runtime.keys,
    key: runtime.keys.resolve(key.secret)!,
  } as ToolContext;

  await runtime.app.createNote('julian', 'Plan.md', 'Ausgangsfassung.\n');
});

afterEach(async () => {
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('an agent writing over somebody', () => {
  it('keeps the displaced version when a person saved in between', async () => {
    await personSavesDuringNextRead('Plan.md', 'Julians Absatz.\n');

    const answer = await tool('append_note').handler(context, {
      path: 'Plan.md',
      content: 'Vom Agenten ergänzt.',
    });

    const copies = (await runtime.app.notes.listNotes('julian'))
      .map((n) => n.path)
      .filter((p) => p.includes('Konflikt'));

    expect(copies).toHaveLength(1);
    expect(answer).toContain('Konflikt');

    // Nothing was lost on either side: the agent's text is in the note, the
    // person's is in the copy.
    const note = await runtime.app.notes.getNote('julian', 'Plan.md');
    expect(note.content).toContain('Vom Agenten ergänzt');
    const copy = await runtime.app.notes.getNote('julian', copies[0]!);
    expect(copy.content).toContain('Julians Absatz');
  });

  it('makes no copy when the agent is the only writer', async () => {
    await tool('append_note').handler(context, { path: 'Plan.md', content: 'Erster Zusatz.' });
    await tick();
    await tool('append_note').handler(context, { path: 'Plan.md', content: 'Zweiter Zusatz.' });

    const copies = (await runtime.app.notes.listNotes('julian'))
      .map((n) => n.path)
      .filter((p) => p.includes('Konflikt'));
    expect(copies).toEqual([]);
  });

  it('protects edit_note the same way', async () => {
    await personSavesDuringNextRead('Plan.md', 'Ausgangsfassung.\n\nJulians Nachtrag.\n');

    await tool('edit_note').handler(context, {
      path: 'Plan.md',
      find: 'Ausgangsfassung.',
      replace: 'Überarbeitet vom Agenten.',
    });

    const copies = (await runtime.app.notes.listNotes('julian'))
      .map((n) => n.path)
      .filter((p) => p.includes('Konflikt'));
    expect(copies).toHaveLength(1);
    const copy = await runtime.app.notes.getNote('julian', copies[0]!);
    expect(copy.content).toContain('Julians Nachtrag');
  });

  it('finds the conflict copy in the index rather than leaving it lying in the folder', async () => {
    await personSavesDuringNextRead('Plan.md', 'Julians unverwechselbarer Absatz.\n');
    await tool('append_note').handler(context, { path: 'Plan.md', content: 'Agent.' });

    const hits = runtime.app.queries.search('julian', 'unverwechselbarer');
    expect(hits.some((h) => h.path.includes('Konflikt'))).toBe(true);
  });
});

describe('names nothing could link to', () => {
  // A pipe is missing from this list on purpose: it never reaches the check,
  // because `normalizeVaultPath` already rejects it as unsafe in a file name.
  it.each([
    ['[CT 110] phpIPAM.md', 'eckige Klammern'],
    ['Thema #1.md', 'Raute'],
  ])('refuses to create %s (%s)', async (notePath) => {
    await expect(runtime.app.createNote('julian', notePath, 'x')).rejects.toThrow(UnlinkableNameError);
  });

  it('refuses the same names through the create-or-update path', async () => {
    await expect(runtime.app.putNote('julian', '[CT 110] phpIPAM.md', 'x')).rejects.toThrow(
      UnlinkableNameError,
    );
  });

  it('refuses renaming a note into such a name', async () => {
    await expect(runtime.app.renameNote('julian', 'Plan.md', '[Plan] alt.md')).rejects.toThrow(
      UnlinkableNameError,
    );
  });

  /**
   * The escape hatch. A vault imported from another tool may be full of these,
   * and the way out is to rename them — so reading, writing and renaming *away*
   * from such a name all have to keep working.
   */
  it('leaves a note that already has such a name usable', async () => {
    // Written past the service, the way an import or a sync would put it there.
    await runtime.app.notes.vault.writeNote('julian', '[CT 110] phpIPAM.md', 'Bestand.\n');
    await runtime.indexer.indexNote('julian', '[CT 110] phpIPAM.md');

    const note = await runtime.app.notes.getNote('julian', '[CT 110] phpIPAM.md');
    expect(note.content).toContain('Bestand');

    // Editing it still works…
    await runtime.app.putNote('julian', '[CT 110] phpIPAM.md', 'Geändert.\n', 'julian');

    // …and renaming it out of the problem is allowed.
    const renamed = await runtime.app.renameNote('julian', '[CT 110] phpIPAM.md', 'CT 110 — phpIPAM.md');
    expect(renamed.note.path).toBe('CT 110 — phpIPAM.md');
  });

  it('allows the characters in a folder name, where they are not a link target', async () => {
    const note = await runtime.app.createNote('julian', 'Projekt #1/Plan.md', 'x');
    expect(note.path).toBe('Projekt #1/Plan.md');
  });
});
