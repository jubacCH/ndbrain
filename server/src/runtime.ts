/**
 * Wiring: turns a `Config` into a running set of services.
 *
 * Shared by the server and the CLI so that both see exactly the same database,
 * vault layout and migrations. A CLI that opened the database differently would
 * eventually disagree with the server about something.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { App } from './app.js';
import { ApiKeyService } from './auth/keys.js';
import { ShareService } from './auth/shares.js';
import { SessionService, UserService } from './auth/users.js';
import { indexFile, type Config } from './config.js';
import { Database } from './db/database.js';
import { migrate } from './db/schema.js';
import { Indexer } from './index/indexer.js';
import { VaultWatcher } from './index/watcher.js';
import { NoteService } from './notes/service.js';
import { Vault } from './vault/fs.js';

export interface Runtime {
  config: Config;
  db: Database;
  vault: Vault;
  notes: NoteService;
  indexer: Indexer;
  app: App;
  users: UserService;
  sessions: SessionService;
  keys: ApiKeyService;
  shares: ShareService;
  close(): void;
}

export async function createRuntime(config: Config): Promise<Runtime> {
  await mkdir(path.join(config.dataDir, 'vaults'), { recursive: true });
  await mkdir(path.join(config.dataDir, 'index'), { recursive: true });

  const db = new Database(indexFile(config));
  migrate(db);

  const vault = new Vault(config.dataDir);
  const notes = new NoteService(vault);
  const indexer = new Indexer(db, notes);
  const app = new App(db, notes, indexer);
  const users = new UserService(db, vault);
  const sessions = new SessionService(db);
  const keys = new ApiKeyService(db);
  const shares = new ShareService(db);

  sessions.purgeExpired();

  return {
    config,
    db,
    vault,
    notes,
    indexer,
    app,
    users,
    sessions,
    keys,
    shares,
    close: () => db.close(),
  };
}

/**
 * Brings the index in line with the files before accepting requests.
 *
 * Notes may have changed while the process was not running — that is the normal
 * case for a folder people also edit over a share. Serving stale search results
 * for the first few minutes after a restart would be a confusing way to start.
 */
export async function syncAllVaults(runtime: Runtime): Promise<void> {
  for (const user of runtime.users.list()) {
    await runtime.indexer.sync(user.id);
  }
}

export function createWatcher(runtime: Runtime): VaultWatcher {
  return new VaultWatcher(runtime.config.dataDir, runtime.indexer, {
    reconcileIntervalMs: runtime.config.reconcileIntervalMs,
  });
}
