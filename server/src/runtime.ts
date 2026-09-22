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
import { NoteBindings, noteLifecycle } from './auth/noteBindings.js';
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

/** How often the two self-growing tables are swept. */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

/**
 * What the caller wants to be told about, beyond what it can ask for.
 *
 * Only the reporting channels live here. Anything a service needs to *work*
 * comes from `Config`, so that a runtime built by the CLI and one built by the
 * server differ in where their warnings go and in nothing else.
 */
export interface RuntimeOptions {
  /** A file in the vault that could not be indexed; see `IndexerOptions`. */
  onSkipped?: (owner: string, notePath: string, error: unknown) => void;
}

export async function createRuntime(config: Config, options: RuntimeOptions = {}): Promise<Runtime> {
  await mkdir(path.join(config.dataDir, 'vaults'), { recursive: true });
  await mkdir(path.join(config.dataDir, 'index'), { recursive: true });

  const db = new Database(indexFile(config));
  migrate(db);

  const vault = new Vault(config.dataDir);
  // Shares first: the note write path tells them, from inside its lock, when a
  // note moves or goes, so a note share follows its note and never outlives it.
  const shares = new ShareService(db);
  const notes = new NoteService(vault, noteLifecycle(shares, new NoteBindings(shares, vault)));
  const indexer = new Indexer(db, notes, options);
  const app = new App(db, notes, indexer, shares);
  const users = new UserService(db, vault);
  const sessions = new SessionService(db);
  const keys = new ApiKeyService(db);
  const settings = new SettingsService(db);
  const history = new History(config.dataDir);

  // Both tables that grow without anybody asking, swept on one timer.
  //
  // `sessions` was swept here already, but only here — its docstring said "on
  // start and periodically" while a service that runs for months starts rarely.
  // `access_log` was never swept at all, and on the live instance it had become
  // ninety-seven per cent of the database file.
  //
  // Daily rather than hourly: nothing here is urgent, and a sweep is a write
  // that blocks the event loop for as long as it runs, because `node:sqlite` is
  // synchronous. `unref` so it can never be the reason the process stays up.
  const sweep = (): void => {
    sessions.purgeExpired();
    keys.purgeLog();
  };
  sweep();
  const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

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
    close: () => {
      clearInterval(sweepTimer);
      db.close();
    },
  };
}

/** Which vaults could not be brought in line, so the caller can say so. */
export interface StartupSyncReport {
  failed: Array<{ owner: string; error: unknown }>;
}

/**
 * Brings the index in line with the files before accepting requests.
 *
 * Notes may have changed while the process was not running — that is the normal
 * case for a folder people also edit over a share. Serving stale search results
 * for the first few minutes after a restart would be a confusing way to start.
 *
 * One vault that cannot be synced does not stop the others, and does not stop
 * the start. This runs before `server.listen`, so anything thrown from here
 * used to take the process down before the port opened — and under a container
 * policy of `restart: unless-stopped` that is a crash loop with no health
 * endpoint to ask what is wrong. A stale index for one account is a bad day;
 * a server nobody can reach is a worse one for everybody else.
 */
export async function syncAllVaults(runtime: Runtime): Promise<StartupSyncReport> {
  const report: StartupSyncReport = { failed: [] };

  for (const user of runtime.users.list()) {
    // Before the index, not after. Whatever was replaced or removed while the
    // process was down took its note shares with it, and indexing first would
    // put the stranger's words into the search, the task list and the tags of
    // everybody the old note was shared with — for the length of one sync,
    // which on a large vault is not a moment. The watcher confirms before it
    // indexes for exactly this reason; the start and the reconcile now do too.
    try {
      await runtime.app.dropDanglingShares(user.id);
      await runtime.indexer.sync(user.id);
    } catch (error) {
      report.failed.push({ owner: user.id, error });
    }
  }

  return report;
}

export function createWatcher(runtime: Runtime): VaultWatcher {
  return new VaultWatcher(runtime.config.dataDir, runtime.indexer, {
    reconcileIntervalMs: runtime.config.reconcileIntervalMs,
    onNoteRemoved: (owner, notePath) => runtime.app.noteVanished(owner, notePath),
    onNoteChanged: (owner, notePath) => runtime.app.noteChanged(owner, notePath),
    beforeSync: (owner) => runtime.app.dropDanglingShares(owner),
  });
}
