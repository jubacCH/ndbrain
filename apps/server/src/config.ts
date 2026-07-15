export interface Config {
  vaultDir: string;
  dbPath: string;
  port: number;
  adminUser?: string;
  adminPassword?: string;
  /** Origins allowed to make cross-origin requests against the API (e.g. the Tauri
   *  desktop webview, whose origin is neither the server's own host nor "same-origin").
   *  Empty by default: CORS stays fully off (no `Access-Control-*` headers at all),
   *  which is byte-identical to the server's pre-CORS behavior for the browser/
   *  same-origin case (see I1). Populate via `NDBRAIN_ALLOWED_ORIGINS`, a comma-
   *  separated list, e.g. "tauri://localhost,http://tauri.localhost". */
  allowedOrigins: string[];
  /** `SameSite` attribute for the session cookie. Defaults to "lax" (today's
   *  behavior). Cross-origin clients (the desktop webview) need "none", which
   *  browsers only honor together with `Secure` - see `cookieSecure`. */
  cookieSameSite: "lax" | "none";
  /** `Secure` attribute for the session cookie. Defaults to false (today's
   *  behavior, required for plain-http homelab dev). Must be true whenever
   *  `cookieSameSite` is "none" (cookie won't be set over http otherwise), so
   *  desktop-client deployments need the server reachable over https. */
  cookieSecure: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const config: Config = {
    vaultDir: env.NDBRAIN_VAULT_DIR ?? "/data/vault",
    dbPath: env.NDBRAIN_DB_PATH ?? "/data/ndbrain.db",
    port: Number(env.NDBRAIN_PORT ?? 3000),
    allowedOrigins: (env.NDBRAIN_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    cookieSameSite: env.NDBRAIN_COOKIE_SAMESITE === "none" ? "none" : "lax",
    cookieSecure: env.NDBRAIN_COOKIE_SECURE === "true",
  };
  if (env.NDBRAIN_ADMIN_USER) config.adminUser = env.NDBRAIN_ADMIN_USER;
  if (env.NDBRAIN_ADMIN_PASSWORD) config.adminPassword = env.NDBRAIN_ADMIN_PASSWORD;
  return config;
}
