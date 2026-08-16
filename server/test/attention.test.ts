/**
 * The headline number on the overview.
 *
 * It used to be the four finding counts added together, which overstates the
 * total whenever a note is orphaned *and* untagged *and* untouched — the common
 * case, not the corner case. On a real vault of sixty notes that arithmetic
 * reported a hundred, a number no amount of tidying could bring to zero.
 *
 * The second rule here is about not nagging: a vault where nothing is tagged is
 * not behind on tagging, it files differently, and reporting every note as a
 * defect says more about the tool's assumptions than about the vault.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { SESSION_COOKIE, buildServer } from '../src/http/server.js';
import { LoginThrottle } from '../src/http/throttle.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

let dataDir: string;
let runtime: Runtime;
let server: FastifyInstance;
let cookie: string;

interface Counts {
  notes: number;
  orphans: number;
  untagged: number;
  deadLinks: number;
  stale: number;
  attention: number;
  tagsInUse: boolean;
}

async function counts(): Promise<Counts> {
  const response = await server.inject({ url: '/api/v1/overview', headers: { cookie } });
  return response.json().counts as Counts;
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-attention-'));
  const config = { ...loadConfig(), dataDir, cookieSecure: false };
  runtime = await createRuntime(config);
  await runtime.users.create('julian', 'ein gutes passwort', { role: 'admin' });

  server = await buildServer({
    app: runtime.app,
    users: runtime.users,
    sessions: runtime.sessions,
    keys: runtime.keys,
    shares: runtime.shares,
    settings: runtime.settings,
    history: runtime.history,
    config,
    throttle: new LoginThrottle({ limit: 1000 }),
  });

  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { user: 'julian', password: 'ein gutes passwort' },
  });
  const jar = response.cookies.find((c) => c.name === SESSION_COOKIE);
  cookie = `${jar?.name}=${jar?.value}`;
});

afterEach(async () => {
  await server.close();
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('the attention count', () => {
  it('counts one note once, however many findings it carries', async () => {
    // A tagged note first, so that tagging counts as a convention in this vault
    // and "untagged" is a real finding — otherwise the overlap this is about
    // cannot arise at all.
    await runtime.app.createNote('julian', 'Getaggt.md', '---\ntags: [x]\n---\nSiehe [[Allein]].\n');
    // Nothing tags this one, and once the link above is the only thing pointing
    // at it, it is untagged. Linked, so the finding under test stands alone.
    await runtime.app.createNote('julian', 'Allein.md', 'Kein Tag.\n');

    const c = await counts();
    expect(c.tagsInUse).toBe(true);
    expect(c.untagged).toBe(1);
    // Getaggt is orphaned; Allein is untagged. Two distinct notes, counted twice
    // by the old arithmetic as well — the point is that neither is double-counted.
    expect(c.attention).toBe(2);
    expect(c.attention).toBeLessThanOrEqual(c.notes);
  });

  it('never exceeds the number of notes', async () => {
    for (let i = 0; i < 5; i += 1) {
      await runtime.app.createNote('julian', `Note ${i}.md`, 'Nichts verweist hierher.\n');
    }

    const c = await counts();
    expect(c.notes).toBe(5);
    expect(c.attention).toBeLessThanOrEqual(c.notes);
  });

  it('counts a broken link against the note that holds it', async () => {
    await runtime.app.createNote('julian', 'Quelle.md', '---\ntags: [x]\n---\nSiehe [[Gibt Es Nicht]].\n');
    await runtime.app.createNote('julian', 'Ziel.md', '---\ntags: [x]\n---\nVerweist auf [[Quelle]].\n');

    const c = await counts();
    expect(c.deadLinks).toBe(1);
    // Quelle holds the broken link; Ziel is orphaned. Two distinct notes.
    expect(c.attention).toBe(2);
  });

  it('keeps the tidy view and the overview telling the same story', async () => {
    // They are driven by one rule and must not disagree: the overview declaring
    // that tagging is not a convention here, while the table lists every note as
    // untagged, is two views contradicting each other about the same vault.
    await runtime.app.createNote('julian', 'Eins.md', 'Ohne Tag.\n');
    await runtime.app.createNote('julian', 'Zwei.md', 'Auch ohne.\n');

    const response = await server.inject({ url: '/api/v1/tidy', headers: { cookie } });
    const tidy = response.json() as { untagged: unknown[] };

    expect((await counts()).tagsInUse).toBe(false);
    expect(tidy.untagged).toHaveLength(0);
  });

  it('holds back the untagged finding while no note is tagged', async () => {
    await runtime.app.createNote('julian', 'Eins.md', 'Ohne Tag.\n');
    await runtime.app.createNote('julian', 'Zwei.md', 'Auch ohne.\n');

    const c = await counts();
    expect(c.tagsInUse).toBe(false);
    // Zero, not two. The count and the tidy list are the same rule, so reporting
    // a number here that the list does not contain would be the contradiction
    // this is meant to remove.
    expect(c.untagged).toBe(0);
    // Both are orphans, so they still need attention — but not *for being untagged*.
    expect(c.orphans).toBe(2);
    expect(c.attention).toBe(2);
  });

  it('starts counting untagged notes as soon as one note is tagged', async () => {
    // Linked to each other, so neither is an orphan and untagged is the only
    // finding in play — otherwise this would not distinguish the two rules.
    await runtime.app.createNote('julian', 'Eins.md', 'Siehe [[Zwei]].\n');
    await runtime.app.createNote('julian', 'Zwei.md', 'Siehe [[Eins]].\n');

    expect((await counts()).attention).toBe(0);

    await runtime.app.updateNote('julian', 'Zwei.md', '---\ntags: [homelab]\n---\nSiehe [[Eins]].\n');

    const c = await counts();
    expect(c.tagsInUse).toBe(true);
    expect(c.untagged).toBe(1);
    expect(c.attention).toBe(1);
  });
});
