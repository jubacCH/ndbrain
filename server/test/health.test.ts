/**
 * `/api/v1/health` has to be able to say no.
 *
 * It used to be `async () => ({ status: 'ok' })`, which is a check that a Node
 * process is running and nothing else: a read-only bind mount, a vault
 * directory that never got mounted and a database that cannot be read all
 * reported perfect health.
 *
 * The other half is that it answers before anybody has signed in. So it may say
 * whether the server works and roughly what is wrong, and nothing else — no
 * paths, no account names, and no numbers from which the size or the shape of a
 * vault could be read off.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../src/db/database.js';
import { migrate } from '../src/db/schema.js';
import { Indexer } from '../src/index/indexer.js';
import { VaultWatcher } from '../src/index/watcher.js';
import { NoteService } from '../src/notes/service.js';
import { Vault } from '../src/vault/fs.js';
import { startHarness, type Harness } from './support/harness.js';

let h: Harness;

beforeEach(async () => {
  h = await startHarness('health');
  await h.runtime.users.create('anna', 'passwort-eins-zwei');
});

afterEach(async () => {
  await h.close();
});

async function health(): Promise<{ status: number; raw: string; body: Record<string, unknown> }> {
  const response = await h.server.inject({ method: 'GET', url: '/api/v1/health' });
  return {
    status: response.statusCode,
    raw: response.body,
    body: JSON.parse(response.body) as Record<string, unknown>,
  };
}

describe('the health endpoint', () => {
  it('answers without a session, and says what it checked', async () => {
    const reply = await health();

    expect(reply.status).toBe(200);
    expect(reply.body['status']).toBe('ok');
    expect(reply.body['checks']).toMatchObject({ database: 'ok', vault: 'ok' });
    expect(reply.body['checks']).toHaveProperty('history');
    expect(reply.body['checks']).toHaveProperty('reconcile');
  });

  it('gives an unauthenticated reader nothing to measure the vault with', async () => {
    await h.runtime.app.createNote('anna', 'Notiz.md', '# Notiz\n');

    const reply = await health();

    expect(reply.raw).not.toContain('anna');
    expect(reply.raw).not.toContain(h.dataDir);
    expect(reply.raw).not.toContain(os.tmpdir());
    // No number of any kind: no counts, no sizes, no timestamps, nothing to
    // watch for a change. The verdicts are words on purpose.
    expect(reply.raw).not.toMatch(/\d/);
  });

  it('is readable in a browser rather than one long line', async () => {
    const reply = await health();
    expect(reply.raw).toContain('\n');
  });

  it('refuses health when the vault directory is not there', async () => {
    await fs.rm(path.join(h.dataDir, 'vaults'), { recursive: true, force: true });

    const reply = await health();

    expect(reply.status).toBe(503);
    expect(reply.body['status']).toBe('failing');
    expect(reply.body['checks']).toMatchObject({ vault: 'unwritable' });
    expect(reply.raw).not.toContain(h.dataDir);
  });

  it.skipIf(process.getuid?.() === 0)('refuses health when the vault is read-only', async () => {
    const vaults = path.join(h.dataDir, 'vaults');
    await fs.chmod(vaults, 0o555);

    try {
      const reply = await health();
      expect(reply.status).toBe(503);
      expect(reply.body['checks']).toMatchObject({ vault: 'unwritable' });
    } finally {
      await fs.chmod(vaults, 0o755);
    }
  });

  it('refuses health when the database cannot be read', async () => {
    const own = await startHarness('health-db');
    try {
      own.runtime.db.close();

      const response = await own.server.inject({ method: 'GET', url: '/api/v1/health' });
      const body = JSON.parse(response.body) as Record<string, unknown>;

      expect(response.statusCode).toBe(503);
      expect(body['status']).toBe('failing');
      expect(body['checks']).toMatchObject({ database: 'unreachable' });
      expect(response.body).not.toContain(own.dataDir);
    } finally {
      // Its database is already closed, so the usual teardown would close it twice.
      await own.server.close();
      await fs.rm(own.dataDir, { recursive: true, force: true });
    }
  });

  it('says so when reconciliation has fallen behind, without taking the server out', async () => {
    const own = await startHarness('health-stale', { reconcileIntervalMs: 60_000 });
    try {
      const response = await own.server.inject({ method: 'GET', url: '/api/v1/health' });
      const body = JSON.parse(response.body) as Record<string, unknown>;
      // Nothing is watching in an API-only harness, so this is the honest answer.
      expect(body['checks']).toMatchObject({ reconcile: 'unwatched' });
      expect(body['status']).toBe('degraded');
      // Degraded, not failing: an index drifting is a problem for the operator,
      // not a reason to take the server out of a load balancer.
      expect(response.statusCode).toBe(200);
    } finally {
      await own.close();
    }
  });
});

describe('when the watcher last reconciled', () => {
  let dataDir: string;
  let db: Database;
  let indexer: Indexer;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-reconcile-'));
    db = new Database(':memory:');
    migrate(db);
    indexer = new Indexer(db, new NoteService(new Vault(dataDir)));
  });

  afterEach(async () => {
    db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('is nothing to report when reconciliation is switched off', () => {
    const watcher = new VaultWatcher(dataDir, indexer, { reconcileIntervalMs: 0 });
    expect(watcher.reconcileState()).toBe('disabled');
  });

  it('is pending while the first interval has not gone by yet', () => {
    const watcher = new VaultWatcher(dataDir, indexer, { reconcileIntervalMs: 60_000 });
    expect(watcher.reconcileState()).toBe('pending');
  });

  it('goes stale once several intervals have gone by with no sweep', () => {
    const watcher = new VaultWatcher(dataDir, indexer, { reconcileIntervalMs: 60_000 });
    expect(watcher.reconcileState(Date.now() + 10 * 60_000)).toBe('stale');
  });

  it('is ok again after a sweep, and stale again long after it', async () => {
    const watcher = new VaultWatcher(dataDir, indexer, { reconcileIntervalMs: 60_000 });
    await watcher.reconcile();

    expect(watcher.reconcileState()).toBe('ok');
    expect(watcher.reconcileState(Date.now() + 10 * 60_000)).toBe('stale');
  });
});
