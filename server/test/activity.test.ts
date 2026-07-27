import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

let dataDir: string;
let runtime: Runtime;

const HOUR = 60 * 60 * 1000;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-act-'));
  runtime = await createRuntime({ ...loadConfig(), dataDir });
  await runtime.users.create('julian', 'ein gutes passwort');
  await runtime.users.create('ramona', 'ihr gutes passwort');
});

afterEach(async () => {
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const since = (): number => Date.now() - 24 * HOUR;

describe('the edit log', () => {
  it('records who did what', async () => {
    await runtime.app.createNote('julian', 'A.md', 'x');
    await runtime.app.updateNote('julian', 'A.md', 'y');

    const activity = runtime.app.queries.activity('julian', since());
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      path: 'A.md',
      title: 'A',
      actor: 'julian',
      action: 'update',
      edits: 2,
      deleted: false,
    });
  });

  it('collapses many edits of one note into one entry', async () => {
    await runtime.app.createNote('julian', 'A.md', 'x');
    for (let i = 0; i < 20; i += 1) {
      await runtime.app.updateNote('julian', 'A.md', `Fassung ${i}`);
    }

    // Twenty autosaves of one paragraph are one thing that happened.
    const activity = runtime.app.queries.activity('julian', since());
    expect(activity).toHaveLength(1);
    expect(activity[0]?.edits).toBe(21);
  });

  it('names an agent as the actor when one writes', async () => {
    await runtime.app.putNote('julian', 'Digest.md', 'vom Agenten\n', 'myai');

    const activity = runtime.app.queries.activity('julian', since());
    expect(activity[0]).toMatchObject({ actor: 'myai', action: 'create' });
  });

  it('still lists a note that was deleted', async () => {
    // "The note you are looking for was deleted this morning" is precisely the
    // answer somebody needs, so a deletion must not vanish from the log.
    await runtime.app.createNote('julian', 'Weg.md', 'x');
    await runtime.app.deleteNote('julian', 'Weg.md');

    const activity = runtime.app.queries.activity('julian', since());
    expect(activity[0]).toMatchObject({ path: 'Weg.md', title: 'Weg', action: 'delete', deleted: true });
  });

  it('records a rename under the new name', async () => {
    await runtime.app.createNote('julian', 'Alt.md', 'x');
    await runtime.app.renameNote('julian', 'Alt.md', 'Neu.md');

    const activity = runtime.app.queries.activity('julian', since());
    expect(activity.map((row) => row.path)).toContain('Neu.md');
    expect(activity.find((row) => row.path === 'Neu.md')?.action).toBe('rename');
  });

  it('respects the time window', async () => {
    await runtime.app.createNote('julian', 'A.md', 'x');
    expect(runtime.app.queries.activity('julian', Date.now() + HOUR)).toEqual([]);
  });

  it('never shows another user\'s activity', async () => {
    await runtime.app.createNote('ramona', 'Privat.md', 'geheim');
    expect(runtime.app.queries.activity('julian', since())).toEqual([]);
    expect(runtime.app.queries.activity('ramona', since())).toHaveLength(1);
  });
});

describe('the log is not part of the rebuildable cache', () => {
  it('survives a full reindex', async () => {
    // The index can be thrown away and rebuilt from the files. The edit log
    // cannot — who wrote a note is not written in the note — so a rebuild must
    // leave it alone rather than silently emptying it.
    await runtime.app.putNote('julian', 'A.md', 'x', 'myai');
    expect(runtime.app.queries.activity('julian', since())).toHaveLength(1);

    await runtime.indexer.rebuild('julian');

    const activity = runtime.app.queries.activity('julian', since());
    expect(activity).toHaveLength(1);
    expect(activity[0]?.actor).toBe('myai');
  });

  it('leaves accounts intact across a reindex too', async () => {
    await runtime.indexer.rebuild('julian');
    expect(runtime.users.list().map((user) => user.id).sort()).toEqual(['julian', 'ramona']);
  });

  it('reports a note as deleted once a rebuild drops it from the index', async () => {
    await runtime.app.createNote('julian', 'A.md', 'x');
    await fs.rm(path.join(dataDir, 'vaults', 'julian', 'A.md'));
    await runtime.indexer.rebuild('julian');

    // The file is gone, so the note row is gone, but the history of it is not.
    const activity = runtime.app.queries.activity('julian', since());
    expect(activity[0]).toMatchObject({ path: 'A.md', deleted: true });
  });
});
