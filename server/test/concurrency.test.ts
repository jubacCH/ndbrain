/**
 * Two writers, one note.
 *
 * The conflict copy was built in phase 7 for shared notes, but the writer it
 * matters most for is the one you cannot see: an agent writing through MCP. It
 * reads a note, thinks, and writes it back, and anything a person typed inside
 * that window is what gets lost. These tests exist because the protection was
 * built and then not connected to that path.
 *
 * **What `append_note` promises changed here, and why.** It used to be that
 * read-modify-write, and this file pinned the consolation prize: the version it
 * displaced was kept as a conflict copy and the answer named it. It now goes
 * through `NoteService.appendNote`, which reads and writes inside one hold of
 * the note's lock, so a person's save cannot land between the two halves — it
 * lands before them or after them, and both texts end up in the one note. The
 * promise is therefore stronger, not merely different: nothing is displaced, so
 * there is nothing to keep a copy of, and no copy is the assertion. What the
 * old test guarded — an agent must not silently swallow what a person wrote in
 * the meantime — is what the first test below still guards, by the better
 * mechanism.
 *
 * `edit_note` keeps the old shape and the old promise; the test for it says
 * why that is right rather than merely unfinished.
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
 * For the tools that still read, think and write back — `edit_note`. The window
 * being tested lives *inside* one tool call, between its read and its write, so
 * it cannot be reached by ordering calls from the outside. This wraps the read
 * instead, which is the only deterministic way to land a write in the middle of
 * it. Everything after the wrapper behaves exactly as in production; nothing
 * about the write path is stubbed.
 *
 * Useless against a tool whose read happens *inside* the note's lock: the write
 * this fires would queue behind the very call that is waiting for it, and the
 * test would hang rather than fail. That is not a shortcoming of the helper, it
 * is the property `personSavesFirst` below exists to test.
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

/**
 * A person's save that has the note's lock and holds it until released.
 *
 * The save is started here, so it is first in the queue for that note; whatever
 * the test starts next waits for it. Holding it open is what makes the test
 * mean something: while the lock is held, a tool that reads outside it has time
 * to read the note as it was *before* this paragraph, which is exactly the
 * mistake being guarded against. The pause sits in the vault write rather than
 * in a stubbed service method, so everything above it — lock, lifecycle,
 * indexing — runs as in production.
 */
function personSavesFirst(
  notePath: string,
  content: string,
): { saved: Promise<unknown>; release: () => void } {
  const vault = runtime.app.notes.vault;
  const write = vault.writeNote.bind(vault);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let armed = true;

  vault.writeNote = async (owner: string, p: string, text: string) => {
    if (armed && p === notePath) {
      armed = false;
      await held;
    }
    return write(owner, p, text);
  };

  return { saved: runtime.app.putNote('julian', notePath, content, 'julian'), release };
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

const conflictCopies = async (): Promise<string[]> =>
  (await runtime.app.notes.listNotes('julian'))
    .map((n) => n.path)
    .filter((p) => p.includes('Konflikt'));

describe('an agent writing over somebody', () => {
  /**
   * The promise this file was written for, in its stronger form.
   *
   * It used to read: the person's paragraph is displaced but kept as a conflict
   * copy, and the answer names it. Now the append waits for the person's save
   * and adds itself to what that save left behind, so both paragraphs are in
   * the one note and there is nothing beside it. Two files the person has to
   * reconcile were always the consolation prize, never the goal.
   *
   * The person's save is deliberately held open across a `tick`, so a tool that
   * read the note outside the lock would have read the old text by now and
   * would go on to displace her. Take the read back out of the lock and this
   * test fails on both counts: a copy appears, and her paragraph is missing
   * from the note.
   */
  it('adds after the person rather than over her', async () => {
    const person = personSavesFirst('Plan.md', 'Ausgangsfassung.\n\nJulians Absatz.\n');

    // Issued while she still holds the note.
    const agent = tool('append_note').handler(context, {
      path: 'Plan.md',
      content: 'Vom Agenten ergänzt.',
    });

    await tick();
    person.release();
    const [, answer] = await Promise.all([person.saved, agent]);

    const note = await runtime.app.notes.getNote('julian', 'Plan.md');
    expect(note.content).toContain('Julians Absatz');
    expect(note.content).toContain('Vom Agenten ergänzt');
    // Hers first: the append went on top of her save, it did not overwrite it.
    expect(note.content.indexOf('Julians Absatz')).toBeLessThan(
      note.content.indexOf('Vom Agenten ergänzt'),
    );

    expect(await conflictCopies()).toEqual([]);
    expect(answer).not.toContain('Konflikt');
  });

  /**
   * The other side of the same guarantee, and the reason the append needs no
   * base version of its own. A tab that was holding this note from before the
   * append saves afterwards, carrying the version it started from — and *that*
   * save keeps the appended text as a conflict copy, exactly as it does for any
   * other note two people write to. The agent's text is protected by the
   * mechanism that already existed, not by a second one inside the append.
   */
  it('keeps the appended text when a tab from before it saves over it', async () => {
    const whatTheTabIsHolding = await runtime.app.notes.getNote('julian', 'Plan.md');

    await tick();
    await tool('append_note').handler(context, { path: 'Plan.md', content: 'Vom Agenten ergänzt.' });

    await tick();
    const saved = await runtime.app.putNote('julian', 'Plan.md', 'Julians Fassung.\n', 'julian', {
      baseMtimeMs: whatTheTabIsHolding.mtimeMs,
    });

    expect(saved.conflictCopy).toBeDefined();
    const copy = await runtime.app.notes.getNote('julian', saved.conflictCopy!);
    expect(copy.content).toContain('Vom Agenten ergänzt');
  });

  it('makes no copy when the agent is the only writer', async () => {
    await tool('append_note').handler(context, { path: 'Plan.md', content: 'Erster Zusatz.' });
    await tick();
    await tool('append_note').handler(context, { path: 'Plan.md', content: 'Zweiter Zusatz.' });

    expect(await conflictCopies()).toEqual([]);
  });

  /**
   * `edit_note` keeps the conflict copy, and should.
   *
   * It is not the same operation with a different name: an append adds after
   * whatever is there and cannot be wrong about it, whereas an edit replaces a
   * span it located in a particular version of the text. Moving its read inside
   * the lock would make the splice atomic but would not make it right — the
   * person may have rewritten the very paragraph the agent matched, and then the
   * correct answer is to keep her version, not to overwrite it because the write
   * happened to be indivisible. `baseMtimeMs` is what says "this edit was
   * reasoned about that text", and it is load-bearing here in a way it never was
   * for the append.
   */
  it('protects edit_note the same way', async () => {
    await personSavesDuringNextRead('Plan.md', 'Ausgangsfassung.\n\nJulians Nachtrag.\n');

    await tool('edit_note').handler(context, {
      path: 'Plan.md',
      find: 'Ausgangsfassung.',
      replace: 'Überarbeitet vom Agenten.',
    });

    const copies = await conflictCopies();
    expect(copies).toHaveLength(1);
    const copy = await runtime.app.notes.getNote('julian', copies[0]!);
    expect(copy.content).toContain('Julians Nachtrag');
  });

  // Through `edit_note` since the change above: it is now the only tool on this
  // surface that can displace anything, and a conflict copy the search cannot
  // find is a file somebody discovers months later and cannot explain.
  it('finds the conflict copy in the index rather than leaving it lying in the folder', async () => {
    await personSavesDuringNextRead('Plan.md', 'Julians unverwechselbarer Absatz.\n');
    await tool('edit_note').handler(context, {
      path: 'Plan.md',
      find: 'Ausgangsfassung.',
      replace: 'Vom Agenten.',
    });

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
    await expect(runtime.app.renameNote('julian', 'Plan.md', '[Plan] alt.md', { view: 'julian' })).rejects.toThrow(
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
    const renamed = await runtime.app.renameNote('julian', '[CT 110] phpIPAM.md', 'CT 110 — phpIPAM.md', { view: 'julian' });
    expect(renamed.note.path).toBe('CT 110 — phpIPAM.md');
  });

  it('allows the characters in a folder name, where they are not a link target', async () => {
    const note = await runtime.app.createNote('julian', 'Projekt #1/Plan.md', 'x');
    expect(note.path).toBe('Projekt #1/Plan.md');
  });
});
