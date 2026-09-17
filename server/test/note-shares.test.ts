/**
 * Sharing one note: the whole reading surface, in two worlds.
 *
 * Julian shares exactly `Projekt/Plan.md` with Ramona. World A is his vault
 * with that note and nothing else; world B adds every kind of neighbour a
 * prefix comparison would let through — `Plan.md.bak`, `Plan2.md`,
 * `Plan.md/x.md`, a subfolder, notes linking to the shared note, tags, tasks,
 * properties, edits and an attachment. Everything Ramona can ask must come
 * back **byte for byte** the same in both worlds. A difference anywhere is a
 * neighbour showing through: as a row, a count, an edge, a folder, a status
 * code or the order of something.
 *
 * `Plan.md/x.md` cannot exist on disk beside a file called `Plan.md`, so it is
 * written straight into the index — which is where every query reads from, and
 * precisely where a `startsWith` would have found it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startHarness, type Harness, type Reply } from './support/harness.js';

const DAY = 24 * 60 * 60 * 1000;

let h: Harness;
let ramonaKey: string;
let bounds: string;

const PLAN =
  '---\ntags: [projekt]\nstatus: offen\n---\n# Plan\n\nZwei Nodes, Qdevice auf [[Technik]] und [[Plan2]].\n\n- [ ] Termin fixieren\n';

beforeEach(async () => {
  h = await startHarness('note-shares');
  await h.runtime.users.create('julian', 'ein gutes passwort');
  await h.runtime.users.create('ramona', 'ihr gutes passwort');
  await h.runtime.app.createNote('julian', 'Projekt/Plan.md', PLAN, 'julian');
  await h.runtime.app.createNote('ramona', 'Eigenes.md', '# Eigenes\n\n#projekt Qdevice bei mir.\n\n- [ ] eigene Aufgabe\n', 'ramona');
  await h.login('julian', 'ein gutes passwort');
  await h.login('ramona', 'ihr gutes passwort');
  ramonaKey = h.runtime.keys.create('ramona', 'ramonas-agent', { canWrite: true }).secret;
  const start = Date.now() - 12 * 60 * 60 * 1000;
  bounds = `${start},${start + DAY}`;
});

afterEach(async () => {
  await h.close();
});

async function shareNote(canWrite = true): Promise<Reply> {
  return h.as('julian', {
    method: 'POST',
    url: '/api/v1/shares',
    payload: { grantee: 'ramona', kind: 'note', path: 'Projekt/Plan.md', canWrite },
  });
}

/** Every neighbour a prefix rule would have let through, and some that only a careless query would. */
async function addNeighbours(): Promise<void> {
  const app = h.runtime.app;
  await app.createNote(
    'julian',
    'Projekt/Plan2.md',
    '---\ntags: [projekt, geheim]\nstatus: geheim\n---\n# Plan2\n\nQdevice geheim, siehe [[Plan]].\n\n- [ ] geheime Aufgabe\n- [x] erledigt geheim\n',
    'julian',
  );
  await app.createNote('julian', 'Projekt/Technik.md', '# Technik\n\nQdevice Details, zurück zu [[Plan]].\n', 'julian');
  await app.createNote('julian', 'Projekt/Sub/Tief.md', '# Tief\n\n#projekt Qdevice tief [[Plan]]\n', 'julian');
  await app.createNote('julian', 'Verweis.md', 'Siehe [[Projekt/Plan.md]] #projekt Qdevice\n', 'julian');
  await app.createNote('julian', 'Plan.md', '# Plan im Wurzelordner\n\nQdevice\n', 'julian');
  await app.createNote('julian', 'Projekt/Plan (Konflikt 2026-01-01 10.00).md', 'Qdevice alt\n', 'julian');
  await app.writeFile('julian', 'Projekt/Plan.md.bak', Buffer.from('Qdevice Sicherung'), 'julian');
  await app.writeFile('julian', 'Projekt/bild.png', Buffer.from([137, 80, 78, 71]), 'julian');
  await app.createFolder('julian', 'Projekt/Leer');
  await app.putNote('julian', 'Projekt/Plan2.md', '# Plan2\n\nQdevice, geändert, [[Plan]]\n\n- [ ] noch eine\n', 'julian');

  // Index-only: `Projekt/Plan.md/x.md` cannot sit on disk next to the file.
  const db = h.runtime.db;
  const x = 'Projekt/Plan.md/x.md';
  db.run(
    `INSERT INTO notes (owner, path, title, path_key, title_key, size, mtime_ms, hash, indexed_at)
     VALUES ('julian', ?, 'x', ?, 'x', 10, ?, 'h', ?)`,
    x,
    x.toLowerCase(),
    Date.now(),
    Date.now(),
  );
  db.run("INSERT INTO notes_fts (owner, path, title, body) VALUES ('julian', ?, 'x', 'Qdevice darunter')", x);
  db.run("INSERT INTO tags (owner, path, tag, key) VALUES ('julian', ?, 'projekt', 'projekt')", x);
  db.run("INSERT INTO tags (owner, path, tag, key) VALUES ('julian', ?, 'darunter', 'darunter')", x);
  db.run("INSERT INTO tasks (owner, path, line, done, text) VALUES ('julian', ?, 1, 0, 'Aufgabe darunter')", x);
  db.run(
    "INSERT INTO props (owner, path, key, value, key_fold, value_fold) VALUES ('julian', ?, 'status', 'darunter', 'status', 'darunter')",
    x,
  );
  db.run(
    `INSERT INTO links (owner, source, target_raw, target_key, target_path, heading, alias, offset)
     VALUES ('julian', ?, 'Plan', 'plan', 'Projekt/Plan.md', NULL, NULL, 0)`,
    x,
  );
  db.run("INSERT INTO edits (owner, path, actor, action, at) VALUES ('julian', ?, 'julian', 'update', ?)", x, Date.now());
}

/** What Ramona sees, everywhere she can look. Volatile fields are removed, nothing else. */
async function surface(): Promise<Record<string, { status: number; raw: string }>> {
  const out: Record<string, { status: number; raw: string }> = {};
  // The probe's own agent calls land in Ramona's access log and would show up
  // in her pulse on the second pass. That is her own activity, not a
  // neighbour, so each pass starts from the same empty log.
  h.runtime.db.run('DELETE FROM access_log');
  const get = async (name: string, url: string): Promise<void> => {
    const reply = await h.as('ramona', { url });
    out[name] = { status: reply.status, raw: stripVolatile(reply) };
  };
  const send = async (name: string, method: string, url: string, payload?: unknown): Promise<void> => {
    const reply = await h.as('ramona', { method, url, ...(payload === undefined ? {} : { payload }) });
    out[name] = { status: reply.status, raw: stripVolatile(reply) };
  };
  const tool = async (name: string, args: Record<string, unknown>): Promise<void> => {
    const reply = await h.tool(ramonaKey, name, args);
    out[`mcp ${name} ${JSON.stringify(args)}`] = { status: reply.status, raw: reply.raw };
  };

  await get('tree', '/api/v1/tree');
  await get('note', '/api/v1/notes/Projekt/Plan.md?owner=julian');
  for (const neighbour of [
    'Projekt/Plan2.md',
    'Projekt/Plan.md/x.md',
    'Projekt/Plan.md.bak',
    'Projekt/Technik.md',
    'Plan.md',
    'Projekt/Plan (Konflikt 2026-01-01 10.00).md',
    'Projekt/Gibtsnicht.md',
  ]) {
    await get(`note ${neighbour}`, `/api/v1/notes/${encodeURI(neighbour)}?owner=julian`);
    await get(`backlinks ${neighbour}`, `/api/v1/backlinks/${encodeURI(neighbour)}?owner=julian`);
    await get(`history ${neighbour}`, `/api/v1/history/${encodeURI(neighbour)}?owner=julian`);
    await get(`file ${neighbour}`, `/api/v1/files/${encodeURI(neighbour)}?owner=julian`);
  }
  await get('file bild', '/api/v1/files/Projekt/bild.png?owner=julian');
  await get('file own md', '/api/v1/files/Projekt/Plan.md?owner=julian');
  await get('files listing', '/api/v1/files?owner=julian');
  await get('backlinks', '/api/v1/backlinks/Projekt/Plan.md?owner=julian');
  await get('history', '/api/v1/history/Projekt/Plan.md?owner=julian');
  await get('search words', '/api/v1/search?q=Qdevice');
  await get('search plan', '/api/v1/search?q=Plan');
  await get('search tag', '/api/v1/search?tag=projekt');
  await get('search dir', '/api/v1/search?dir=Projekt');
  await get('search dir deep', '/api/v1/search?dir=Projekt/Plan.md');
  await get('search prop', '/api/v1/search?prop=status');
  await get('search prop value', '/api/v1/search?prop=status&propValue=geheim');
  await get('search days', '/api/v1/search?days=7');
  await get('quickfind', '/api/v1/quickfind?q=Plan');
  await get('quickfind empty', '/api/v1/quickfind');
  await get('map', '/api/v1/map');
  await get('props', '/api/v1/props/status');
  await get('graph', '/api/v1/graph');
  await get('pulse', '/api/v1/pulse?since=1');
  await get('activity days', `/api/v1/activity/days?bounds=${bounds}`);
  await get('tags', '/api/v1/tags');
  await get('overview', '/api/v1/overview');
  await get('overview week', '/api/v1/overview?days=7');
  await get('tasks', '/api/v1/tasks');
  await get('tasks all', '/api/v1/tasks?includeDone=true');
  await get('tasks dir', '/api/v1/tasks?dir=Projekt&includeDone=true');
  await get('tidy', '/api/v1/tidy');
  await get('shares', '/api/v1/shares');
  await get('topics', '/api/v1/topics');

  // Writes against neighbours, with a write share on the note next to them.
  // Each is refused, so none of them changes the world it is compared in.
  for (const neighbour of ['Projekt/Plan2.md', 'Projekt/Plan.md/x.md', 'Projekt/Gibtsnicht.md']) {
    await send(`put ${neighbour}`, 'PUT', `/api/v1/notes/${encodeURI(neighbour)}?owner=julian`, { content: 'x' });
    await send(`delete ${neighbour}`, 'DELETE', `/api/v1/notes/${encodeURI(neighbour)}?owner=julian`);
    await send(`rename from ${neighbour}`, 'POST', '/api/v1/rename', {
      owner: 'julian',
      from: neighbour,
      to: 'Projekt/Anders.md',
    });
    await send(`toggle ${neighbour}`, 'POST', '/api/v1/tasks/toggle', {
      owner: 'julian',
      path: neighbour,
      line: 9,
      expectedText: 'geheime Aufgabe',
      expectedDone: false,
      done: true,
    });
    await send(`restore ${neighbour}`, 'POST', '/api/v1/history/restore', {
      owner: 'julian',
      path: neighbour,
      version: 'abcdef',
    });
  }
  await send('rename onto neighbour', 'POST', '/api/v1/rename', {
    owner: 'julian',
    from: 'Projekt/Plan.md',
    to: 'Projekt/Plan2.md',
  });
  await send('rename away', 'POST', '/api/v1/rename', {
    owner: 'julian',
    from: 'Projekt/Plan.md',
    to: 'Projekt/Plan3.md',
  });
  await send('upload beside', 'POST', '/api/v1/files/Projekt/Plan.md.bak?owner=julian', 'neu');
  await send('bulk', 'POST', '/api/v1/bulk', {
    owner: 'julian',
    paths: ['Projekt/Plan2.md', 'Projekt/Plan.md/x.md', 'Projekt/Gibtsnicht.md'],
    action: 'delete',
  });
  await send('bulk move', 'POST', '/api/v1/bulk', {
    owner: 'julian',
    paths: ['Projekt/Plan2.md'],
    action: 'move',
    dir: 'Projekt',
  });
  await send('folder of the owner', 'POST', '/api/v1/folders/rename', { from: 'Projekt', to: 'Anders' });
  await send('folder create beside', 'POST', '/api/v1/folders', { owner: 'julian', path: 'Projekt/Neu' });
  await send('folder create under', 'POST', '/api/v1/folders', { owner: 'julian', path: 'Projekt/Plan.md/Neu' });
  await send('folder rename beside', 'POST', '/api/v1/folders/rename', {
    owner: 'julian',
    from: 'Projekt/Leer',
    to: 'Projekt/Voll',
  });
  await send('folder rename parent', 'POST', '/api/v1/folders/rename', {
    owner: 'julian',
    from: 'Projekt',
    to: 'Projekt2',
  });
  await send('folder delete beside', 'DELETE', '/api/v1/folders/Projekt/Leer?owner=julian');
  await send('folder delete parent', 'DELETE', '/api/v1/folders/Projekt?owner=julian');
  await get('admin tree', '/api/v1/admin/spaces/julian/tree');

  await tool('vault_map', {});
  await tool('search_notes', { query: 'Qdevice' });
  await tool('list_notes', {});
  await tool('get_note', { path: 'Projekt/Plan.md' });
  await tool('get_links', { path: 'Projekt/Plan.md' });
  return out;
}

function stripVolatile(reply: Reply): string {
  if (reply.body !== null && typeof reply.body === 'object' && 'now' in reply.body) {
    const { now: _now, ...rest } = reply.body as Record<string, unknown>;
    return JSON.stringify(rest);
  }
  return reply.raw;
}

describe('a share on one note', () => {
  it('is granted by kind and path, and listed with both', async () => {
    const granted = await shareNote();
    expect(granted.status).toBe(200);
    expect(granted.body.share).toMatchObject({
      owner: 'julian',
      grantee: 'ramona',
      kind: 'note',
      path: 'Projekt/Plan.md',
      prefix: 'Projekt/Plan.md',
      canWrite: true,
    });

    const listed = await h.as('ramona', { url: '/api/v1/shares' });
    expect(listed.body.received).toEqual([granted.body.share]);
    const tree = await h.as('ramona', { url: '/api/v1/tree' });
    expect(tree.body.owners).toEqual([
      { id: 'ramona', kind: 'person', displayName: 'ramona' },
      { id: 'julian', kind: 'person', displayName: 'julian' },
    ]);
  });

  it('shows the same everywhere whether the neighbours exist or not', async () => {
    expect((await shareNote()).status).toBe(200);

    const before = await surface();
    await addNeighbours();
    const after = await surface();

    // Sanity: the note itself is really visible, so equality means something.
    expect(before['note']!.status).toBe(200);
    expect(before['tree']!.raw).toContain('Projekt/Plan.md');
    expect(before['search words']!.raw).toContain('Projekt/Plan.md');
    expect(before['graph']!.raw).toContain('Projekt/Plan.md');
    expect(before['tasks']!.raw).toContain('Termin fixieren');

    expect(Object.keys(after)).toEqual(Object.keys(before));
    // All differing surfaces at once, so a regression names every place it shows.
    const differing = Object.keys(before).filter(
      (name) => JSON.stringify(after[name]) !== JSON.stringify(before[name]),
    );
    expect(differing).toEqual([]);
  });

  it('answers a neighbour exactly as a note that does not exist', async () => {
    await shareNote();
    await addNeighbours();
    const missing = await h.as('ramona', { url: '/api/v1/notes/Projekt/Gibtsnicht.md?owner=julian' });
    for (const neighbour of ['Projekt/Plan2.md', 'Projekt/Plan.md/x.md', 'Projekt/Plan.md.bak', 'Plan.md']) {
      const reply = await h.as('ramona', { url: `/api/v1/notes/${neighbour}?owner=julian` });
      expect({ neighbour, status: reply.status, raw: reply.raw }).toEqual({
        neighbour,
        status: missing.status,
        raw: missing.raw,
      });
    }
  });

  it('lets the tree name only the folders on the path to the note', async () => {
    await shareNote();
    await addNeighbours();
    const tree = await h.as('ramona', { url: '/api/v1/tree' });
    const foreign = tree.body.dirs.filter((dir: { owner: string }) => dir.owner === 'julian');
    expect(foreign).toEqual([{ owner: 'julian', path: 'Projekt' }]);
    const notes = tree.body.notes.filter((note: { owner: string }) => note.owner === 'julian');
    expect(notes.map((note: { path: string }) => note.path)).toEqual(['Projekt/Plan.md']);
  });

  it('reports the outgoing links of the note with hidden targets unresolved', async () => {
    await shareNote();
    await addNeighbours();
    const links = await h.as('ramona', { url: '/api/v1/backlinks/Projekt/Plan.md?owner=julian' });
    expect(links.body.backlinks).toEqual([]);
    for (const link of links.body.outgoing) expect(link.targetPath).toBeNull();
  });

  it('refuses a note share on a note that is not there, as missing', async () => {
    const reply = await h.as('julian', {
      method: 'POST',
      url: '/api/v1/shares',
      payload: { grantee: 'ramona', kind: 'note', path: 'Projekt/Gibtsnicht.md', canWrite: false },
    });
    expect(reply.status).toBe(404);
    expect(h.runtime.shares.byOwner('julian')).toEqual([]);
  });

  it('never shares a note of somebody else', async () => {
    const reply = await h.as('ramona', {
      method: 'POST',
      url: '/api/v1/shares',
      payload: { grantee: 'julian', kind: 'note', path: 'Projekt/Plan.md', canWrite: true },
    });
    expect(reply.status).toBe(404);
    expect(h.runtime.shares.byOwner('ramona')).toEqual([]);
  });

  it('refuses a note share that does not name a note, and a vault share with a path', async () => {
    for (const payload of [
      { grantee: 'ramona', kind: 'note', path: 'Projekt', canWrite: false },
      { grantee: 'ramona', kind: 'note', path: '', canWrite: false },
      { grantee: 'ramona', kind: 'vault', path: 'Projekt', canWrite: false },
      { grantee: 'ramona', kind: 'folder', path: '', canWrite: false },
    ]) {
      const reply = await h.as('julian', { method: 'POST', url: '/api/v1/shares', payload });
      expect({ payload, status: reply.status }).toEqual({ payload, status: 400 });
    }
  });

  it('still grants the old way, by prefix, as a folder or the vault', async () => {
    const folder = await h.as('julian', {
      method: 'POST',
      url: '/api/v1/shares',
      payload: { grantee: 'ramona', prefix: 'Projekt', canWrite: false },
    });
    expect(folder.body.share).toMatchObject({ kind: 'folder', prefix: 'Projekt/', path: 'Projekt' });
    const vault = await h.as('julian', {
      method: 'POST',
      url: '/api/v1/shares',
      payload: { grantee: 'ramona', prefix: '', canWrite: false },
    });
    expect(vault.body.share).toMatchObject({ kind: 'vault', prefix: '', path: '' });
  });

  it('writes the note it names and nothing else', async () => {
    await shareNote(true);
    const put = await h.as('ramona', {
      method: 'PUT',
      url: '/api/v1/notes/Projekt/Plan.md?owner=julian',
      payload: { content: '# Plan\n\nvon Ramona\n' },
    });
    expect(put.status).toBe(200);
    const created = await h.as('ramona', {
      method: 'PUT',
      url: '/api/v1/notes/Projekt/Neu.md?owner=julian',
      payload: { content: 'x' },
    });
    expect(created.status).toBe(404);
  });

  it('is read-only when granted read-only', async () => {
    await shareNote(false);
    const reply = await h.as('ramona', { url: '/api/v1/notes/Projekt/Plan.md?owner=julian' });
    expect(reply.body.canWrite).toBe(false);
    const put = await h.as('ramona', {
      method: 'PUT',
      url: '/api/v1/notes/Projekt/Plan.md?owner=julian',
      payload: { content: 'x' },
    });
    expect(put.status).toBe(404);
  });
});
