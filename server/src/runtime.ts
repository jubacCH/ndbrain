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
import { SettingsService } from './auth/settings.js';
import { History } from './vault/history.js';
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
  settings: SettingsService;
  history: History;
  close(): void;
}

export async function createRuntime(config: Config): Promise<Runtime> {
  await mkdir(path.join(config.dataDir, 'vaults'), { recursive: true });
  await mkdir(path.join(config.dataDir, 'index'), { recursive: true });

  const db = new Database(indexFile(config));
  migrate(db);

  const vault = new Vault(config.dataDir);
  // Shares first: the note write path tells them, from inside its lock, when a
  // note moves or goes, so a note share follows its note and never outlives it.
  const shares = new ShareService(db);
  const notes = new NoteService(vault, shares.lifecycle);
  const indexer = new Indexer(db, notes);
  const app = new App(db, notes, indexer, shares);
  const users = new UserService(db, vault);
  const sessions = new SessionService(db);
  const keys = new ApiKeyService(db);
  const settings = new SettingsService(db);
  const history = new History(config.dataDir);

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
    settings,
    history,
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
    // Whatever disappeared while the process was down took its note shares
    // with it; nothing that is created later may find them waiting.
    await runtime.app.dropDanglingShares(user.id);
  }
}

export function createWatcher(runtime: Runtime): VaultWatcher {
  return new VaultWatcher(runtime.config.dataDir, runtime.indexer, {
    reconcileIntervalMs: runtime.config.reconcileIntervalMs,
    onNoteRemoved: (owner, notePath) => runtime.app.noteVanished(owner, notePath),
    onNoteChanged: (owner, notePath) => runtime.app.noteChanged(owner, notePath),
    afterSync: (owner) => runtime.app.dropDanglingShares(owner),
  });
}
