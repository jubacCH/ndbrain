/**
 * Turning an import's metadata line into real tags.
 *
 * The vault this was written for has 53 notes carrying `> **type:** … **topic:**
 * proxmox, homelab · …` as the first line of the body, and zero tags — so the
 * tag filter, the tag cloud and the untagged finding are all dark for want of a
 * translation nobody will do sixty times by hand.
 *
 * What these tests are really guarding is restraint. The parser must not guess:
 * putting words into somebody's notes that they never wrote is worse than
 * leaving the feature switched off, in a format whose whole promise is that the
 * file is theirs. So the shape is matched tightly, the body is never edited, and
 * the tags applied are the ones the server re-derives rather than the ones a
 * client claims a proposal contained.
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
import { proposeFor } from '../src/notes/topics.js';
import * as S from '../../shared/schema.js';

let dataDir: string;
let runtime: Runtime;
let server: FastifyInstance;
let cookie: string;

const REAL_LINE =
  '> **type:** reference · **topic:** proxmox, homelab · **src:** manual · **updated:** 2026-06-06';

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-topics-'));
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
  cookie = `${SESSION_COOKIE}=${response.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});

afterEach(async () => {
  await server.close();
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('reading the line', () => {
  it('reads the shape the importer actually wrote', () => {
    const proposal = proposeFor('a.md', 'a', `---\ncreated: x\n---\n${REAL_LINE}\n\nText.\n`);

    expect(proposal?.proposed).toEqual(['proxmox', 'homelab']);
  });

  it('stops at the separator, so the next field is not a tag', () => {
    // Without the boundary, "manual" and the date would become tags.
    const proposal = proposeFor('a.md', 'a', `${REAL_LINE}\n`);

    expect(proposal?.proposed).not.toContain('manual');
    expect(proposal?.proposed).not.toContain('2026-06-06');
  });

  it('hyphenates a topic with a space rather than dropping it', () => {
    const proposal = proposeFor('a.md', 'a', '> **topic:** smart home, netzwerk\n');

    expect(proposal?.proposed).toEqual(['smart-home', 'netzwerk']);
  });

  it('ignores prose that merely mentions the word', () => {
    // The restraint that matters: no line, no proposal. Guessing tags from
    // ordinary sentences puts words in somebody's notes that they never wrote.
    for (const text of [
      'Der topic: dieser Notiz ist Proxmox.\n',
      'We discussed the topic of backups at length.\n',
      '**topic:** not in a blockquote\n',
    ]) {
      expect(proposeFor('a.md', 'a', text)).toBeNull();
    }
  });

  it('proposes nothing when the tags are already there', () => {
    const content = `---\ntags: [proxmox, homelab]\n---\n${REAL_LINE}\n`;

    expect(proposeFor('a.md', 'a', content)).toBeNull();
  });

  it('proposes only what is missing', () => {
    const content = `---\ntags: [proxmox]\n---\n${REAL_LINE}\n`;

    expect(proposeFor('a.md', 'a', content)?.proposed).toEqual(['homelab']);
  });
});

describe('the proposal endpoint', () => {
  beforeEach(async () => {
    await runtime.app.createNote('julian', 'Mit.md', `${REAL_LINE}\n\nZwei Nodes.\n`);
    await runtime.app.createNote('julian', 'Ohne.md', 'Nur Text, keine Metazeile.\n');
  });

  it('lists only the notes that would change', async () => {
    const response = await server.inject({ url: '/api/v1/topics', headers: { cookie } });
    const parsed = S.TopicsResponse.parse(response.json());

    expect(parsed.proposals.map((p) => p.path)).toEqual(['Mit.md']);
    expect(parsed.proposals[0]!.proposed).toEqual(['proxmox', 'homelab']);
    // The line itself comes back, so a person can check the machine's reading
    // rather than take its word for it.
    expect(parsed.proposals[0]!.source).toContain('**topic:**');
  });

  it('applies only the notes it was given', async () => {
    await runtime.app.createNote('julian', 'Auch.md', '> **topic:** netzwerk\n');

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/topics/apply',
      headers: { cookie },
      payload: { paths: ['Mit.md'] },
    });

    expect(S.ApplyTopicsResponse.parse(response.json()).applied.map((a) => a.path)).toEqual([
      'Mit.md',
    ]);
    // The one not named is untouched.
    expect((await runtime.app.notes.getNote('julian', 'Auch.md')).content).not.toContain('tags:');
  });

  it('writes the tags into the frontmatter and leaves the body alone', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/topics/apply',
      headers: { cookie },
      payload: { paths: ['Mit.md'] },
    });

    const note = await runtime.app.notes.getNote('julian', 'Mit.md');
    expect(note.content).toContain('proxmox');
    // Additive only: the line it read is still exactly where it was. Removing it
    // would be editing prose to tidy up after a migration, and if the result is
    // wrong the evidence would be gone.
    expect(note.content).toContain(REAL_LINE);
    expect(note.content).toContain('Zwei Nodes.');
  });

  it('makes the tags real everywhere the tool uses them', async () => {
    // The whole point: an axis of the product switches on.
    const before = await server.inject({ url: '/api/v1/tags', headers: { cookie } });
    expect(S.TagsResponse.parse(before.json()).tags).toHaveLength(0);

    await server.inject({
      method: 'POST',
      url: '/api/v1/topics/apply',
      headers: { cookie },
      payload: { paths: ['Mit.md'] },
    });

    const after = await server.inject({ url: '/api/v1/tags', headers: { cookie } });
    expect(S.TagsResponse.parse(after.json()).tags.map((t) => t.tag).sort()).toEqual([
      'homelab',
      'proxmox',
    ]);

    // And the untagged finding, which withholds itself until tagging is a
    // convention here, starts reporting.
    const overview = await server.inject({ url: '/api/v1/overview', headers: { cookie } });
    expect((overview.json() as { counts: { tagsInUse: boolean } }).counts.tagsInUse).toBe(true);
  });

  it('is idempotent', async () => {
    const apply = async (): Promise<number> => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/topics/apply',
        headers: { cookie },
        payload: { paths: ['Mit.md'] },
      });
      return S.ApplyTopicsResponse.parse(response.json()).applied.length;
    };

    expect(await apply()).toBe(1);
    // Second time there is nothing left to propose, so nothing is written.
    expect(await apply()).toBe(0);
  });

  it('ignores a path that has nothing to propose', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/topics/apply',
      headers: { cookie },
      payload: { paths: ['Ohne.md'] },
    });

    expect(S.ApplyTopicsResponse.parse(response.json()).applied).toEqual([]);
  });

  it("only ever touches the caller's own vault", async () => {
    await runtime.users.create('ramona', 'ihr gutes passwort');
    await runtime.app.createNote('ramona', 'Ihre.md', '> **topic:** privat\n');

    const response = await server.inject({ url: '/api/v1/topics', headers: { cookie } });
    const parsed = S.TopicsResponse.parse(response.json());

    expect(parsed.proposals.map((p) => p.path)).not.toContain('Ihre.md');
  });
});
