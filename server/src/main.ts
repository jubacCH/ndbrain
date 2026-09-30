/**
 * Entry point.
 *
 * Starts the watcher and the HTTP server, and shuts both down cleanly on a
 * signal. Clean shutdown matters more than usual here: a container stop in the
 * middle of a write would otherwise leave a temporary file behind and, worse, a
 * WAL that the next start has to recover.
 */

import { loadConfig } from './config.js';
import { startupMessage } from './errors.js';
import { buildServer } from './http/server.js';
import { createRuntime, createWatcher, syncAllVaults } from './runtime.js';

async function main(): Promise<void> {
  const config = loadConfig();

  /**
   * Where a skipped note is reported.
   *
   * The runtime is built before the server that owns the logger, and the first
   * sync runs right after — so this starts on the console and is swapped for
   * Fastify's logger as soon as there is one, rather than making the runtime
   * depend on the HTTP layer for a warning.
   */
  let warn = (message: string): void => console.warn(message);

  const runtime = await createRuntime(config, {
    onSkipped: (owner, notePath, error) => {
      const reason = error instanceof Error ? error.message : String(error);
      warn(
        `skipping ${owner}:${notePath} — ${reason}. ` +
          'It stays on disk and out of search until it is renamed.',
      );
    },
    /**
     * Said plainly, and with what to do about it.
     *
     * The failure this is here to prevent is an agent getting a 401 one morning
     * with nothing anywhere to explain it, so the line names the key, the
     * account and the day, and the command that renews it — because the person
     * reading it at that point is looking for the command, not for the reason.
     */
    onExpiringKeys: (keys) => {
      for (const key of keys) {
        // `expiringSoon` only ever returns keys that have a deadline; this
        // narrows the type rather than covering a case that can occur.
        if (key.expiresAt === null) continue;

        const day = new Date(key.expiresAt).toISOString().slice(0, 10);
        const days = Math.max(0, Math.ceil((key.expiresAt - Date.now()) / 86_400_000));
        warn(
          `agent key "${key.name}" (${key.id}) for ${key.owner} expires on ${day}, ` +
            `in ${days} day${days === 1 ? '' : 's'} — whatever uses it will start getting 401 ` +
            'then, with no other sign. Make its replacement with: ' +
            `ndbrain-user key create ${key.owner} "${key.name}"` +
            `${key.canWrite ? ' --write' : ''}${key.scope === '' ? '' : ` --scope ${key.scope}`}` +
            `, then: ndbrain-user key revoke ${key.id}`,
        );
      }
    },
  });

  // Built before the server and started after it: the health endpoint has to be
  // able to say when the last reconcile ran, and a watcher that only existed
  // after `buildServer` would leave it answering "nothing is watching".
  const watcher = createWatcher(runtime);

  const server = await buildServer({
    app: runtime.app,
    db: runtime.db,
    users: runtime.users,
    sessions: runtime.sessions,
    keys: runtime.keys,
    shares: runtime.shares,
    settings: runtime.settings,
    history: runtime.history,
    config,
    watcher,
  });

  warn = (message: string): void => server.log.warn(message);

  if (runtime.users.count() === 0) {
    server.log.warn(
      'no accounts exist yet — create one with: ndbrain-user create <name>. ' +
        'Nobody can sign in until you do; there is no self-registration on purpose.',
    );
  }

  // A vault that cannot be synced is reported and left behind rather than
  // allowed to stop the start; see `syncAllVaults`.
  for (const failure of (await syncAllVaults(runtime)).failed) {
    server.log.error(
      { err: failure.error },
      `could not index one vault at start-up — its search results will be stale ` +
        `until "ndbrain-user reindex ${failure.owner}" succeeds`,
    );
  }

  await watcher.start();

  await server.listen({ host: config.host, port: config.port });
  server.log.info({ dataDir: config.dataDir }, 'ndbrain is up');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.log.info({ signal }, 'shutting down');

    try {
      await server.close();
      await watcher.stop();
      runtime.close();
    } catch (error) {
      server.log.error({ err: error }, 'error during shutdown');
      process.exitCode = 1;
    }
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}

try {
  await main();
} catch (error) {
  // One line and a non-zero exit rather than the unhandled rejection this used
  // to be; see `startupMessage`. Nothing here is recoverable — the server is
  // not listening yet — so there is nothing to do but say what happened and
  // leave the decision about restarting to whatever supervises the process.
  console.error(startupMessage(error));
  process.exit(1);
}
