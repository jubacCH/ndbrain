/**
 * Link previews: the one route where the server connects to an address a user
 * chose, from inside a home network.
 *
 * The interesting tests are the refusals. A link preview that can be pointed
 * at `http://10.10.10.1/` reads the router's login page and hands its title
 * back; one that can be pointed at a name which resolves to a private address
 * does the same with one more step. Both have to end before a byte is sent.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { SESSION_COOKIE, buildServer } from '../src/http/server.js';
import { LoginThrottle } from '../src/http/throttle.js';
import {
  UnfurlRefused,
  checkUrl,
  guardedLookup,
  isPublicAddress,
  readHead,
  unfurl,
} from '../src/http/unfurl.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import * as S from '../../shared/schema.js';

describe('which addresses count as public', () => {
  it('refuses the home network, loopback and the cloud metadata address', () => {
    for (const address of [
      '10.10.30.98',
      '192.168.0.1',
      '172.16.5.4',
      '127.0.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:10.0.0.1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it('accepts ordinary internet addresses', () => {
    for (const address of ['1.1.1.1', '104.16.132.229', '2606:4700::6810:84e5', '::ffff:8.8.8.8']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });
});

describe('checking a URL before anything is sent', () => {
  it('refuses private literals, odd ports, other schemes and credentials', () => {
    for (const url of [
      'http://10.10.10.1/',
      'http://[::1]/',
      'http://localhost/',
      'http://proxmox.local/',
      'https://example.org:8006/',
      'ftp://example.org/',
      'file:///etc/passwd',
      'https://user:pw@example.org/',
      'kein url',
    ]) {
      expect(() => checkUrl(url), url).toThrow(UnfurlRefused);
    }
  });

  it('lets an ordinary page through', () => {
    expect(checkUrl('https://example.org/seite?x=1').hostname).toBe('example.org');
    expect(checkUrl('http://example.org:80/').hostname).toBe('example.org');
  });

  it('refuses a name that resolves to a private address, at connection time', async () => {
    // `localhost` is refused by name before it gets here; the lookup is what
    // stands between a rebinding name and the network, so it is tested on its
    // own with a name every system resolves to loopback.
    const error = await new Promise<Error | null>((resolve) => {
      guardedLookup('localhost', {}, (failure) => resolve(failure));
    });
    expect(error).toBeInstanceOf(UnfurlRefused);
  });
});

describe('reading a page head', () => {
  const base = new URL('https://example.org/artikel');

  it('prefers Open Graph over the title tag', () => {
    const html = `<!doctype html><html><head>
      <title>Fallback</title>
      <meta property="og:title" content="Proxmox &amp; Ceph">
      <meta name="description" content="Ein Artikel">
      <meta property="og:site_name" content='Example'>
      <meta property="og:image" content="/bild.png">
      </head><body><meta property="og:title" content="nicht das"></body></html>`;
    expect(readHead(html, base)).toEqual({
      url: 'https://example.org/artikel',
      title: 'Proxmox & Ceph',
      description: 'Ein Artikel',
      site: 'Example',
    });
  });

  it('falls back to the title tag, and passes no image on', () => {
    // The page's CSP allows images from this origin only, so a preview image
    // would be refused in the browser — and would tell the linked site who reads.
    const html = '<head><title>  Nur\n Titel </title><meta property="og:image" content="/bild.png"></head>';
    const preview = readHead(html, base);
    expect(preview.title).toBe('Nur Titel');
    expect(Object.keys(preview)).not.toContain('image');
  });
});

describe('the cache', () => {
  it('asks the network once per URL', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return { url: new URL('https://example.net/a'), html: '<title>A</title>' };
    };
    expect((await unfurl('https://example.net/a', fetcher))?.title).toBe('A');
    expect((await unfurl('https://example.net/a', fetcher))?.title).toBe('A');
    expect(calls).toBe(1);
  });

  it('answers null, not an error, when the page cannot be read', async () => {
    const fetcher = async () => {
      throw new Error('timed out');
    };
    expect(await unfurl('https://example.net/kaputt', fetcher)).toBeNull();
  });
});

describe('the route', () => {
  let dataDir: string;
  let runtime: Runtime;
  let server: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-unfurl-'));
    const config = { ...loadConfig(), dataDir, cookieSecure: false };
    runtime = await createRuntime(config);
    await runtime.users.create('julian', 'ein gutes passwort', { role: 'admin' });
    server = await buildServer({
      app: runtime.app,
      db: runtime.db,
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

  it('is not an open proxy', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/v1/unfurl?url=https://example.org' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a private address with a 400 and sends nothing', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/unfurl?url=${encodeURIComponent('http://10.10.10.1/')}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { code: string }).code).toBe('invalid_url');
  });

  it('answers in the shape the browser checks', async () => {
    // A name that does not exist: the lookup fails, and the answer is a card
    // without content rather than an error the page would have to explain.
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/unfurl?url=${encodeURIComponent('https://does-not-exist.invalid/')}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = S.UnfurlResponse.parse(response.json());
    expect(body.preview).toBeNull();
  });
});
