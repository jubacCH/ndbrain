/**
 * A running server on a temporary data directory, and requests as somebody.
 *
 * For the share, space and note-share tests, which all need the same three
 * things: a runtime, a Fastify instance on it, and a way to ask as a given
 * person — by session cookie or by agent key.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';

import { loadConfig, type Config } from '../../src/config.js';
import { SESSION_COOKIE, buildServer } from '../../src/http/server.js';
import { LoginThrottle } from '../../src/http/throttle.js';
import { createRuntime, type Runtime } from '../../src/runtime.js';

export interface Reply {
  status: number;
  /** The body exactly as sent, for byte comparisons. */
  raw: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export interface Harness {
  dataDir: string;
  config: Config;
  runtime: Runtime;
  server: FastifyInstance;
  /** Signs in and remembers the cookie for `as`. Returns the raw login reply. */
  login(user: string, password: string): Promise<Reply>;
  as(user: string, options: { method?: string; url: string; payload?: unknown }): Promise<Reply>;
  /** One MCP tool call with an agent key; the text of the result. */
  tool(secret: string, name: string, args?: Record<string, unknown>): Promise<Reply>;
  close(): Promise<void>;
}

function toReply(response: { statusCode: number; body: string }): Reply {
  let body: unknown = null;
  if (response.body !== '') {
    try {
      body = JSON.parse(response.body);
    } catch {
      body = response.body;
    }
  }
  return { status: response.statusCode, raw: response.body, body };
}

export async function startHarness(prefix: string): Promise<Harness> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `ndbrain-${prefix}-`));
  const config: Config = { ...loadConfig(), dataDir, cookieSecure: false, logLevel: 'silent' };
  const runtime = await createRuntime(config);
  const server = await buildServer({
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

  const cookies: Record<string, string> = {};

  const harness: Harness = {
    dataDir,
    config,
    runtime,
    server,
    async login(user, password) {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { user, password },
      });
      const jar = response.cookies.find((c) => c.name === SESSION_COOKIE);
      if (jar !== undefined) cookies[user] = `${jar.name}=${jar.value}`;
      return toReply(response);
    },
    async as(user, options) {
      const injection: InjectOptions = {
        method: (options.method ?? 'GET') as NonNullable<InjectOptions['method']>,
        url: options.url,
        headers: { cookie: cookies[user] ?? '' },
      };
      if (options.payload !== undefined) {
        injection.payload = options.payload as NonNullable<InjectOptions['payload']>;
      }
      return toReply(await server.inject(injection));
    },
    async tool(secret, name, args = {}) {
      const response = await server.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${secret}` },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      });
      return toReply(response);
    },
    async close() {
      await server.close();
      runtime.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
  return harness;
}
