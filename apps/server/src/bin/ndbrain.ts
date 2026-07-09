#!/usr/bin/env node
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/database.js";
import { ApiKeyService } from "../keys/service.js";
import { runKeyCli } from "../keys/cli.js";

const config = loadConfig(process.env);
const db = openDatabase(config.dbPath);
const keys = new ApiKeyService(db);

const { code, out } = await runKeyCli(process.argv.slice(2), { keys });
process.stdout.write(out);
db.close();
process.exit(code);
