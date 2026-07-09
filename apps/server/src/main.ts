import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { Indexer } from "./index/indexer.js";
import { NoteService } from "./notes/service.js";
import { Mutex } from "./notes/mutex.js";
import { Vault } from "./vault/files.js";
import { VaultGit } from "./vault/git.js";
import { VaultWatcher } from "./watch/watcher.js";
import { AuthService } from "./http/auth.js";
import { buildServer } from "./http/server.js";

const config = loadConfig(process.env);
await mkdir(config.vaultDir, { recursive: true });

const db = openDatabase(config.dbPath);
const vault = new Vault(config.vaultDir);
const git = new VaultGit(config.vaultDir);
await git.init();
const indexer = new Indexer(db);
// One shared mutation queue so external-change and API-driven commits serialize together.
const mutex = new Mutex();
const watcher = new VaultWatcher(vault, indexer, git, mutex);
const notes = new NoteService(vault, git, indexer, watcher, mutex);
const auth = new AuthService(db);

if (!auth.hasUsers() && config.adminUser && config.adminPassword) {
  await auth.createUser(config.adminUser, config.adminPassword);
  console.log(`created initial admin user "${config.adminUser}"`);
}

await indexer.reindexAll(vault);
await watcher.start();

const app = buildServer({ notes, auth, db, git, indexer, vault });
await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`ndbrain listening on :${config.port}`);
