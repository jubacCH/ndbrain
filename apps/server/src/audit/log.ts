import type { Database } from "../db/database.js";

/** Records exactly one row per MCP tool call in the `access_log` audit trail.
 *
 * Every call — read or write, allowed or denied — must produce a row so the log is a
 * complete trace of what agents attempted, not just what they were permitted to do. */
export function logAccess(
  db: Database,
  keyId: number | null,
  tool: string,
  target: string | null,
  allowed: boolean,
): void {
  db.prepare("INSERT INTO access_log (key_id, tool, target, allowed) VALUES (?, ?, ?, ?)").run(
    keyId,
    tool,
    target,
    allowed ? 1 : 0,
  );
}
