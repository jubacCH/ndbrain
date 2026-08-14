/**
 * Frontmatter, finally indexed.
 *
 * It was parsed from the first phase and then dropped on the floor: only `tags`
 * reached a table. Everything else a note declared about itself lived in the
 * file and nowhere a query could reach it, which is why there was no way to ask
 * "what is still open" and no way for an agent to see the shape of the vault
 * without reading all of it.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

let dataDir: string;
let runtime: Runtime;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-props-'));
  runtime = await createRuntime({ ...loadConfig(), dataDir });
  await runtime.users.create('julian', 'ein gutes passwort');

  await runtime.app.createNote(
    'julian',
    'Projekte/Umbau.md',
    '---\nstatus: aktiv\ntype: projekt\ntopic: [homelab, netz]\ntags: [projekt]\n---\n# Umbau\n\nLäuft.\n',
  );
  await runtime.app.createNote(
    'julian',
    'Projekte/Alt.md',
    '---\nstatus: erledigt\ntype: projekt\n---\n# Alt\n\nFertig.\n',
  );
  await runtime.app.createNote('julian', 'Lose.md', '# Lose\n\nOhne Frontmatter.\n');
});

afterEach(async () => {
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('filtering by a declared property', () => {
  it('finds the notes that declare a value', () => {
    const hits = runtime.app.queries.search('julian', '', { prop: { key: 'status', value: 'aktiv' } });
    expect(hits.map((h) => h.path)).toEqual(['Projekte/Umbau.md']);
  });

  it('finds every note that declares the key at all', () => {
    const hits = runtime.app.queries.search('julian', '', { prop: { key: 'status' } });
    expect(hits.map((h) => h.path).sort()).toEqual(['Projekte/Alt.md', 'Projekte/Umbau.md']);
  });

  it('matches regardless of letter case, like tags do', async () => {
    await runtime.app.putNote('julian', 'Gross.md', '---\nStatus: Aktiv\n---\n# Gross\n');
    const hits = runtime.app.queries.search('julian', '', { prop: { key: 'status', value: 'aktiv' } });
    expect(hits.map((h) => h.path).sort()).toEqual(['Gross.md', 'Projekte/Umbau.md']);
  });

  it('indexes a list as one entry per item', () => {
    const byTopic = runtime.app.queries.search('julian', '', { prop: { key: 'topic', value: 'netz' } });
    expect(byTopic.map((h) => h.path)).toEqual(['Projekte/Umbau.md']);
  });

  it('combines with the other filters rather than replacing them', () => {
    const hits = runtime.app.queries.search('julian', '', {
      prop: { key: 'type', value: 'projekt' },
      dir: 'Projekte',
    });
    expect(hits).toHaveLength(2);

    const none = runtime.app.queries.search('julian', '', {
      prop: { key: 'type', value: 'projekt' },
      dir: 'Woanders',
    });
    expect(none).toEqual([]);
  });

  /**
   * `tags` is left out of `props` on purpose: it has its own table, and two
   * sources for one answer is how they start disagreeing.
   */
  it('does not duplicate tags into the property table', () => {
    const keys = runtime.app.queries.propKeys('julian').map((k) => k.key);
    expect(keys).not.toContain('tags');
    expect(runtime.app.queries.tagCounts('julian').map((t) => t.tag)).toContain('projekt');
  });
});

describe('the vault map', () => {
  it('gives one line per note with its tags and properties, and no bodies', () => {
    const map = runtime.app.queries.vaultMap('julian');
    const umbau = map.find((m) => m.path === 'Projekte/Umbau.md');

    expect(umbau).toBeDefined();
    expect(umbau!.title).toBe('Umbau');
    expect(umbau!.tags).toEqual(['projekt']);
    expect(umbau!.props['status']).toEqual(['aktiv']);
    expect(umbau!.props['topic']?.sort()).toEqual(['homelab', 'netz']);
    expect(JSON.stringify(umbau)).not.toContain('Läuft');
  });

  it('includes notes that declare nothing', () => {
    const map = runtime.app.queries.vaultMap('julian');
    const lose = map.find((m) => m.path === 'Lose.md');
    expect(lose?.tags).toEqual([]);
    expect(lose?.props).toEqual({});
  });

  it('lists the vocabulary the vault actually uses', () => {
    expect(runtime.app.queries.propKeys('julian').map((k) => k.key).sort()).toEqual([
      'status',
      'topic',
      'type',
    ]);
    expect(runtime.app.queries.propValues('julian', 'status')).toEqual([
      { value: 'aktiv', count: 1 },
      { value: 'erledigt', count: 1 },
    ]);
  });
});

describe('the index stays a cache', () => {
  it('rebuilds the properties from the files alone', async () => {
    await runtime.indexer.rebuild('julian');
    const hits = runtime.app.queries.search('julian', '', { prop: { key: 'status', value: 'aktiv' } });
    expect(hits.map((h) => h.path)).toEqual(['Projekte/Umbau.md']);
  });

  it('drops properties a note no longer declares', async () => {
    await runtime.app.putNote('julian', 'Projekte/Umbau.md', '---\nstatus: pausiert\n---\n# Umbau\n');

    expect(
      runtime.app.queries.search('julian', '', { prop: { key: 'status', value: 'aktiv' } }),
    ).toEqual([]);
    expect(
      runtime.app.queries
        .search('julian', '', { prop: { key: 'status', value: 'pausiert' } })
        .map((h) => h.path),
    ).toEqual(['Projekte/Umbau.md']);
    // `topic` was in the old frontmatter and is gone from the new one.
    expect(runtime.app.queries.propKeys('julian').map((k) => k.key)).not.toContain('topic');
  });

  it('survives a note being deleted', async () => {
    await runtime.app.deleteNote('julian', 'Projekte/Alt.md');
    expect(runtime.app.queries.propValues('julian', 'status')).toEqual([
      { value: 'aktiv', count: 1 },
    ]);
  });

  it('ignores frontmatter that is not valid YAML rather than failing the write', async () => {
    const note = await runtime.app.putNote('julian', 'Kaputt.md', '---\n: : :\n---\n# Kaputt\n');
    expect(note.note.path).toBe('Kaputt.md');
    expect(runtime.app.queries.vaultMap('julian').find((m) => m.path === 'Kaputt.md')).toBeDefined();
  });
});

describe('one vault never sees another', () => {
  it('keeps properties owner-scoped', async () => {
    await runtime.users.create('ramona', 'ihr gutes passwort');
    await runtime.app.createNote('ramona', 'Ihres.md', '---\nstatus: aktiv\n---\n# Ihres\n');

    const mine = runtime.app.queries.search('julian', '', { prop: { key: 'status', value: 'aktiv' } });
    expect(mine.map((h) => h.path)).toEqual(['Projekte/Umbau.md']);
    expect(runtime.app.queries.vaultMap('julian').map((m) => m.path)).not.toContain('Ihres.md');
  });
});
