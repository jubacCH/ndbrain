export interface Config {
  vaultDir: string;
  dbPath: string;
  port: number;
  adminUser?: string;
  adminPassword?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const config: Config = {
    vaultDir: env.NDBRAIN_VAULT_DIR ?? "/data/vault",
    dbPath: env.NDBRAIN_DB_PATH ?? "/data/ndbrain.db",
    port: Number(env.NDBRAIN_PORT ?? 3000),
  };
  if (env.NDBRAIN_ADMIN_USER) config.adminUser = env.NDBRAIN_ADMIN_USER;
  if (env.NDBRAIN_ADMIN_PASSWORD) config.adminPassword = env.NDBRAIN_ADMIN_PASSWORD;
  return config;
}
