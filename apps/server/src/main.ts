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
import { loadEmbeddingConfig } from "./embed/config.js";
import { createEmbeddingProvider, isEmbeddingEnabled } from "./embed/provider.js";
import { VectorStore } from "./embed/store.js";
import { EmbeddingIndexer } from "./embed/indexer.js";

const config = loadConfig(process.env);
await mkdir(config.vaultDir, { recursive: true });

const db = openDatabase(config.dbPath);
const vault = new Vault(config.vaultDir);
const git = new VaultGit(config.vaultDir);
await git.init();
const indexer = new Indexer(db);

// Embedding stack: with NDBRAIN_EMBEDDING_PROVIDER unset/"none" (the default, and how
// this instance is normally configured), `createEmbeddingProvider` returns the `none`
// provider and every embedding-aware code path (EmbeddingIndexer.enqueue, hybridSearch,
// buildContext's vector-related) short-circuits back to today's FTS-only behavior — no
// provider is ever called, no added latency. See embed/provider.ts's `isNoneProvider`.
const embeddingConfig = loadEmbeddingConfig(process.env);
const embedProvider = createEmbeddingProvider(embeddingConfig);
// Pass the config's dim (NDBRAIN_EMBEDDING_DIM), NOT embedProvider.dim: the openai/ollama
// providers only learn their real dim lazily, from their first embed() call, so
// embedProvider.dim reads 0 here regardless of the configured model. `embeddingConfig.dim`
// is undefined unless the operator set an explicit override, which is exactly the
// "optional hint, otherwise self-adapting" contract VectorStore expects (Plan 5 C1 fix) —
// omitting it isn't an error, the store just learns its dim from the first vector it sees.
const embedStore = new VectorStore(db, embeddingConfig.dim);
const embedIndexer = new EmbeddingIndexer(embedProvider, embedStore);

// One shared mutation queue so external-change and API-driven commits serialize together.
const mutex = new Mutex();
const watcher = new VaultWatcher(vault, indexer, git, mutex);
const notes = new NoteService(vault, git, indexer, watcher, mutex, undefined, embedIndexer);
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

// First-run embedding backfill: only when a real provider is configured AND the vector
// store is still empty (a freshly-turned-on provider against an existing vault, or a
// brand-new one — never on every restart once vectors exist). Deliberately NOT awaited:
// embedding a whole vault can take a while against a real provider/model, and this must
// never delay `app.listen` below or block the event loop.
if (isEmbeddingEnabled(embedProvider) && embedStore.isEmpty()) {
  console.log("[ndbrain] embedding provider configured and vector store empty; starting background reindex");
  void (async () => {
    const paths = await vault.list();
    const notesToEmbed: Array<{ path: string; markdown: string }> = [];
    for (const path of paths) {
      const markdown = await vault.read(path);
      if (markdown !== null) notesToEmbed.push({ path, markdown });
    }
    await embedIndexer.reindexAll(notesToEmbed);
    console.log(`[ndbrain] background embedding reindex complete (${notesToEmbed.length} notes)`);
  })().catch((err) => console.error("[ndbrain] background embedding reindex failed:", err));
}

const app = buildServer({
  notes,
  auth,
  db,
  git,
  indexer,
  vault,
  apiKeys,
  documents,
  embedProvider,
  embedStore,
  embedIndexer,
});
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
