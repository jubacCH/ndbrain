/**
 * Reads the title and description off the page behind a URL, for the link
 * cards in the editor.
 *
 * No preview image. The page's content security policy allows images from this
 * origin only (`./csp.ts`), and loading one from the linked site would also
 * tell that site who is reading the note. A card without a picture is the price.
 *
 * The browser cannot do this itself — almost no page allows a cross-origin read
 * of its HTML — so the server fetches on its behalf. That makes this the one
 * place where the server opens connections to addresses a user chose, and it
 * stands in a home network. Without care it is a way to make the server read
 * the router's admin page, the hypervisor's API or a metadata endpoint and hand
 * the title back. So:
 *
 *  - **public addresses only.** Every address a name resolves to is checked,
 *    and the check happens in the connection's own lookup — the address that
 *    was checked is the address that is connected to, so a name that answers
 *    "public" to the check and "10.0.0.1" to the connection (DNS rebinding)
 *    gets nowhere. Literal IPs are checked the same way.
 *  - **http and https on their usual ports only.** No probing of `:22`.
 *  - **redirects are followed by hand**, each hop checked again, at most three.
 *  - **a hard size and time limit**, and only `text/html` is read.
 *  - **only the head of the page leaves the server**, reduced to three strings.
 *    Nothing fetched is ever passed through as content.
 */

import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';

export interface LinkPreview {
  url: string;
  title: string | null;
  description: string | null;
  site: string | null;
}

/** Addresses that are not the public internet. */
const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  // An IPv4-mapped IPv6 address is checked as the IPv4 address it carries.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped !== null) return !PRIVATE.check(mapped[1]!, 'ipv4');
  return !PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export class UnfurlRefused extends Error {}

/** The connection's own name lookup, refusing anything not public. */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error !== null) {
      callback(error, '', 0);
      return;
    }
    const list = addresses as unknown as LookupAddress[];
    if (list.length === 0 || !list.every((entry) => isPublicAddress(entry.address))) {
      callback(new UnfurlRefused(`${hostname} does not resolve to a public address`), '', 0);
      return;
    }
    if (options.all === true) {
      (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, list);
    } else {
      callback(null, list[0]!.address, list[0]!.family);
    }
  });
};

/** Checks a URL before anything is sent to it. */
export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnfurlRefused('not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UnfurlRefused('only http and https');
  if (url.username !== '' || url.password !== '') throw new UnfurlRefused('no credentials in the URL');
  const port = url.port === '' ? null : Number(url.port);
  if (port !== null && port !== 80 && port !== 443) throw new UnfurlRefused('only the standard ports');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0 && !isPublicAddress(host)) throw new UnfurlRefused('not a public address');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new UnfurlRefused('not a public address');
  }
  return url;
}

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;

interface Fetched {
  url: URL;
  html: string;
}

function fetchOnce(url: URL, deadline: number): Promise<{ status: number; location?: string; html?: string }> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(
      url,
      {
        method: 'GET',
        lookup: guardedLookup,
        timeout: Math.max(1, deadline - Date.now()),
        headers: {
          // Plainly a bot: some sites serve their real title only to things that
          // say what they are, and pretending to be a browser is not this
          // server's business.
          'user-agent': 'ndBrain-LinkPreview/1.0 (+https://github.com/jubacCH/ndbrain)',
          accept: 'text/html,application/xhtml+xml;q=0.9',
          'accept-language': 'de,en;q=0.8',
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.resume();
          const location = response.headers.location;
          resolve(location === undefined ? { status } : { status, location });
          return;
        }
        const type = String(response.headers['content-type'] ?? '');
        if (status !== 200 || !/text\/html|application\/xhtml/i.test(type)) {
          response.resume();
          resolve({ status });
          return;
        }

        const charset = /charset=["']?([\w-]+)/i.exec(type)?.[1]?.toLowerCase() ?? 'utf-8';
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = (): void => {
          const body = Buffer.concat(chunks);
          let html: string;
          try {
            html = new TextDecoder(charset).decode(body);
          } catch {
            html = body.toString('utf8');
          }
          resolve({ status, html });
        };
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          size += chunk.length;
          // The head is all that is needed; once it is in, or once the limit is
          // reached, the rest is not read.
          if (size >= MAX_BYTES || chunk.includes('</head>')) {
            response.destroy();
            finish();
          }
        });
        response.on('end', finish);
        response.on('error', () => finish());
      },
    );
    request.on('timeout', () => request.destroy(new UnfurlRefused('timed out')));
    request.on('error', reject);
    request.end();
  });
}

async function fetchPage(raw: string): Promise<Fetched | null> {
  const deadline = Date.now() + TIMEOUT_MS;
  let url = checkUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const result = await fetchOnce(url, deadline);
    if (result.location !== undefined) {
      url = checkUrl(new URL(result.location, url).toString());
      continue;
    }
    return result.html === undefined ? null : { url, html: result.html };
  }
  return null;
}

/* ---- reading the head --------------------------------------------------- */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text: string): string {
  return text
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) => {
      if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(parseInt(name.slice(2), 16));
      if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match === null ? null : (match[2] ?? match[3] ?? match[4] ?? null);
}

function clip(text: string | null, length: number): string | null {
  if (text === null || text === '') return null;
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/** The three things a card shows, read from a page's `<head>`. */
export function readHead(html: string, base: URL): LinkPreview {
  const head = html.slice(0, Math.max(html.search(/<\/head>/i), 0) || html.length);
  const meta = new Map<string, string>();
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attribute(tag, 'property') ?? attribute(tag, 'name'))?.toLowerCase();
    const content = attribute(tag, 'content');
    if (key !== undefined && content !== null && !meta.has(key)) meta.set(key, decode(content));
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];

  return {
    url: base.toString(),
    title: clip(meta.get('og:title') ?? meta.get('twitter:title') ?? (titleTag ? decode(titleTag) : null), 200),
    description: clip(meta.get('og:description') ?? meta.get('description') ?? meta.get('twitter:description') ?? null, 300),
    site: clip(meta.get('og:site_name') ?? null, 80),
  };
}

/* ---- the cache ---------------------------------------------------------- */

/**
 * Answers are kept for an hour, failures for ten minutes.
 *
 * A note with a link in it is opened again and again, and every opening would
 * otherwise be a request to somebody else's server — on a phone, one per
 * scroll past the card.
 */
const cache = new Map<string, { at: number; value: LinkPreview | null }>();
const CACHE_LIMIT = 500;

export async function unfurl(raw: string, fetcher = fetchPage): Promise<LinkPreview | null> {
  const hit = cache.get(raw);
  const ttl = hit?.value === null ? 10 * 60_000 : 60 * 60_000;
  if (hit !== undefined && Date.now() - hit.at < ttl) return hit.value;

  // Whatever goes wrong past the first check — a timeout, a refused redirect, a
  // page that is not HTML — the answer is the same: no card, just the link.
  // Telling the caller *why* a fetch failed would turn this into a scanner.
  let value: LinkPreview | null = null;
  try {
    const page = await fetcher(raw);
    value = page === null ? null : readHead(page.html, page.url);
  } catch {
    value = null;
  }

  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(raw, { at: Date.now(), value });
  return value;
}
