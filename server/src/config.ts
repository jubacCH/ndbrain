/**
 * Runtime configuration, read from the environment.
 *
 * Defaults are chosen so that running the binary with no configuration at all
 * produces a *safe* server rather than a convenient one — an unconfigured
 * self-hosted service is the normal case, not an edge case.
 */

import path from 'node:path';

export interface Config {
  /** Holds `vaults/` and `index/`. */
  dataDir: string;
  host: string;
  port: number;
  /**
   * Marks the session cookie `Secure`, so browsers only send it over HTTPS.
   *
   * Defaults to on. Behind a reverse proxy — the normal deployment — this is
   * correct; the cost of the default being wrong is a login that does not stick
   * on plain HTTP, which is a visible annoyance rather than a silent exposure.
   */
  cookieSecure: boolean;
  cookieSameSite: 'strict' | 'lax' | 'none';
  /** Origins allowed to make credentialed requests. Empty means same-origin only. */
  allowedOrigins: string[];
  /** How often the watcher compares the whole vault against the index. */
  reconcileIntervalMs: number;
  logLevel: string;
  /** Built web UI to serve. Absent means API only — the default in tests. */
  webRoot?: string;
}

function envString(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}

export function loadConfig(env = process.env): Config {
  const sameSite = envString('NDBRAIN_COOKIE_SAMESITE', 'lax').toLowerCase();

  const config: Config = {
    dataDir: path.resolve(envString('NDBRAIN_DATA_DIR', './data')),
    host: envString('NDBRAIN_HOST', '0.0.0.0'),
    port: envInt('NDBRAIN_PORT', 3000),
    cookieSecure: envBool('NDBRAIN_COOKIE_SECURE', true),
    cookieSameSite: sameSite === 'strict' || sameSite === 'none' ? sameSite : 'lax',
    allowedOrigins: envString('NDBRAIN_ALLOWED_ORIGINS', '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    reconcileIntervalMs: envInt('NDBRAIN_RECONCILE_INTERVAL_MS', 5 * 60 * 1000),
    logLevel: envString('NDBRAIN_LOG_LEVEL', 'info'),
  };

  const webRoot = process.env['NDBRAIN_WEB_ROOT'];
  if (webRoot !== undefined && webRoot !== '') {
    config.webRoot = path.resolve(webRoot);
  }

  // SameSite=None without Secure is discarded by every current browser, which
  // presents as "login does nothing" with no error anywhere. Fail loudly instead.
  if (config.cookieSameSite === 'none' && !config.cookieSecure) {
    throw new Error(
      'NDBRAIN_COOKIE_SAMESITE=none requires NDBRAIN_COOKIE_SECURE=true — ' +
        'browsers silently discard the cookie otherwise',
    );
  }

  void env;
  return config;
}

export function indexFile(config: Config): string {
  return path.join(config.dataDir, 'index', 'ndbrain.db');
}
