#!/usr/bin/env node
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/database.js";
import { ApiKeyService } from "../keys/service.js";
import { runKeyCli } from "../keys/cli.js";

try {
  const config = loadConfig(process.env);
  await mkdir(dirname(config.dbPath), { recursive: true });
  const db = openDatabase(config.dbPath);
  const keys = new ApiKeyService(db);

  const { code, out } = await runKeyCli(process.argv.slice(2), { keys });
  process.stdout.write(out);
  db.close();
  process.exit(code);
} catch (error) {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
