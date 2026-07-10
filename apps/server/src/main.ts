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
import { ApiKeyService } from "./keys/service.js";
import { buildServer } from "./http/server.js";
import { createShutdown } from "./shutdown.js";
import { DocumentManager } from "./collab/document-manager.js";

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
const apiKeys = new ApiKeyService(db);
const documents = new DocumentManager({ notes });
// Late-bind both directions of the NoteService <-> DocumentManager bridge (see
// each class's doc comment): agent/REST writes route into an open collab doc
// instead of the file, and out-of-band file changes (Syncthing/Obsidian, via
// the watcher) rebase into an open collab doc instead of being ignored.
notes.setDocManager(documents);
watcher.onExternalChangeApply = (path, markdown) => documents.applyExternal(path, markdown);

if (!auth.hasUsers() && config.adminUser && config.adminPassword) {
  await auth.createUser(config.adminUser, config.adminPassword);
  console.log(`created initial admin user "${config.adminUser}"`);
}

await indexer.reindexAll(vault);
await watcher.start();

const app = buildServer({ notes, auth, db, git, indexer, vault, apiKeys, documents });
await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`ndbrain listening on :${config.port}`);

// Graceful shutdown: drain requests, stop the watcher, close the db, then exit.
// Idempotent, so a repeated signal cannot trigger a double close.
const shutdown = createShutdown({
  app,
  watcher,
  db,
  documents,
  hocuspocus: app.hocuspocus,
  closeCollabSockets: app.closeCollabSockets,
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void shutdown().then(
      () => process.exit(0),
      (err) => {
        console.error("[ndbrain] shutdown error:", err);
        process.exit(1);
      },
    );
  });
}
