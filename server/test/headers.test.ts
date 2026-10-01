/**
 * The headers every response carries.
 *
 * Checked against a running server rather than by reading the source, because
 * the thing that matters is what a browser receives. A policy that is composed
 * correctly and then overwritten by a route, or never reaches a static asset
 * because the hook ran too late, is the same as no policy at all.
 *
 * Two properties are worth more than the rest and have a test each:
 *
 *  - `script-src` allows no inline code except the page's own bootstrap, named
 *    by digest. `'unsafe-inline'` there would make the whole policy decorative.
 *  - The download route keeps its own, stricter policy. A blanket header set in
 *    the hook must not loosen the one place that already refused everything.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { inlineScriptHashes } from '../src/http/csp.js';
import { SESSION_COOKIE } from '../src/http/server.js';
import { startHarness, type Harness } from './support/harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The page the real deployment serves, as the bundler leaves it. */
const SHIPPED_INDEX = path.resolve(here, '../../web/index.html');

let h: Harness;
let webRoot: string;

/** Exactly the inline script the fixture page carries, byte for byte. */
const BOOTSTRAP = "document.documentElement.setAttribute('data-theme', 'dark');";

const FIXTURE_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <title>ndBrain</title>
    <style>html { background: #050b0e; }</style>
    <script>${BOOTSTRAP}</script>
    <script type="module" crossorigin src="/assets/index-abc123.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>
`;

/** The digest CSP expects for that script, derived here and not from the code. */
const BOOTSTRAP_HASH = `'sha256-${createHash('sha256').update(BOOTSTRAP, 'utf8').digest('base64')}'`;

/** The policy as one map, so a test can name a directive instead of a substring. */
function directives(policy: string): Map<string, string[]> {
  const entries = policy
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => part.split(/\s+/))
    .map((words) => [words[0] ?? '', words.slice(1)] as const);
  return new Map(entries);
}

async function policyOf(url: string): Promise<string> {
  const response = await h.server.inject({ method: 'GET', url });
  const header = response.headers['content-security-policy'];
  expect(header, `no policy on ${url}`).toBeTypeOf('string');
  return String(header);
}

beforeEach(async () => {
  webRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-web-'));
  await fs.writeFile(path.join(webRoot, 'index.html'), FIXTURE_PAGE, 'utf8');
  h = await startHarness('headers', { webRoot });
  await h.runtime.users.create('anna', 'passwort-eins-zwei');
});

afterEach(async () => {
  await h.close();
  await fs.rm(webRoot, { recursive: true, force: true });
});

describe('the content security policy', () => {
  it('reaches the page, an asset and the API alike', async () => {
    const page = await policyOf('/');
    const deepLink = await policyOf('/Homelab/Proxmox.md');
    const api = await policyOf('/api/v1/health');

    expect(page).toBe(deepLink);
    expect(api).toBe(page);
  });

  it('allows no inline script but the page\'s own bootstrap', async () => {
    const script = directives(await policyOf('/')).get('script-src') ?? [];

    expect(script).toContain("'self'");
    expect(script).toContain(BOOTSTRAP_HASH);
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).not.toContain('*');
  });

  it('confines every fetch to this origin', async () => {
    const policy = directives(await policyOf('/'));

    for (const directive of ['default-src', 'img-src', 'connect-src', 'font-src', 'worker-src']) {
      expect(policy.get(directive), directive).toEqual(["'self'"]);
    }
    // Nothing may be framed, and nothing may frame this.
    expect(policy.get('frame-ancestors')).toEqual(["'none'"]);
    expect(policy.get('frame-src')).toEqual(["'none'"]);
    expect(policy.get('object-src')).toEqual(["'none'"]);
    expect(policy.get('base-uri')).toEqual(["'none'"]);
    // A form may not post anywhere but here, which is where none of them post.
    expect(policy.get('form-action')).toEqual(["'self'"]);
  });

  it('leaves the download route its stricter policy', async () => {
    const login = await h.server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { user: 'anna', password: 'passwort-eins-zwei' },
    });
    const jar = login.cookies.find((c) => c.name === SESSION_COOKIE);
    const cookie = `${SESSION_COOKIE}=${String(jar?.value)}`;
    const anna = h.runtime.users.byLogin('anna')!.id;

    await h.runtime.app.writeFile(anna, 'bild.png', Buffer.from([1, 2, 3]), anna);

    const download = await h.server.inject({
      method: 'GET',
      url: `/api/v1/files/bild.png?owner=${anna}`,
      headers: { cookie },
    });

    expect(download.statusCode).toBe(200);
    // Not the page's policy, which would let a served file load from this
    // origin. This route already said no to everything and stays that way.
    expect(download.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  });

  it('covers every inline script the shipped page actually has', async () => {
    // Guards the extraction against the real file rather than the fixture: a
    // second inline script added to `web/index.html` and not hashed here is a
    // blank page in production and a failure here.
    const shipped = await fs.readFile(SHIPPED_INDEX, 'utf8');
    const inline = shipped.match(/<script(?![^>]*\ssrc\s*=)[^>]*>/gi) ?? [];

    expect(inline.length).toBeGreaterThan(0);
    expect(inlineScriptHashes(shipped)).toHaveLength(inline.length);
  });

  it('ignores a script element that only points at a file', () => {
    expect(inlineScriptHashes('<script type="module" src="/a.js"></script>')).toEqual([]);
  });
});

describe('strict transport security', () => {
  it('is sent when this server believes it is behind TLS', async () => {
    const secure = await startHarness('headers-hsts', { webRoot, cookieSecure: true });
    try {
      const response = await secure.server.inject({ method: 'GET', url: '/api/v1/health' });
      expect(response.headers['strict-transport-security']).toBe(
        'max-age=31536000; includeSubDomains',
      );
    } finally {
      await secure.close();
    }
  });

  it('stays away from the plain-HTTP test case', async () => {
    // `NDBRAIN_COOKIE_SECURE=false` is the one documented reason to run this
    // without TLS. Pinning a browser to HTTPS from such a server would lock
    // somebody out of the very setup the flag exists for.
    const response = await h.server.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });
});
