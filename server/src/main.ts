/**
 * Entry point.
 *
 * Starts the watcher and the HTTP server, and shuts both down cleanly on a
 * signal. Clean shutdown matters more than usual here: a container stop in the
 * middle of a write would otherwise leave a temporary file behind and, worse, a
 * WAL that the next start has to recover.
 */

import { loadConfig } from './config.js';
import { buildServer } from './http/server.js';
import { createRuntime, createWatcher, syncAllVaults } from './runtime.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = await createRuntime(config);

  const server = await buildServer({
    app: runtime.app,
    users: runtime.users,
    sessions: runtime.sessions,
    keys: runtime.keys,
    config,
  });

  if (runtime.users.count() === 0) {
    server.log.warn(
      'no accounts exist yet — create one with: ndbrain-user create <name>. ' +
        'Nobody can sign in until you do; there is no self-registration on purpose.',
    );
  }

  await syncAllVaults(runtime);

  const watcher = createWatcher(runtime);
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

await main();
