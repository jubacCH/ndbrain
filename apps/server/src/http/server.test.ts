import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { openDatabase, type Database } from "../db/database.js";
import { Indexer } from "../index/indexer.js";
import { NoteService } from "../notes/service.js";
import { Vault } from "../vault/files.js";
import { VaultGit } from "../vault/git.js";
import { AuthService } from "./auth.js";
import { ApiKeyService } from "../keys/service.js";
import { DocumentManager } from "../collab/document-manager.js";
import { buildServer } from "./server.js";

let dir: string;
let app: FastifyInstance;
let db: Database;
let notes: NoteService;
let apiKeys: ApiKeyService;
let wsUrl: string;
let openProviders: HocuspocusProvider[];

/** Real WS client, real network round trip through `/collab` - no mocking of
 *  Hocuspocus or the wire protocol. */
function connect(name: string, token: string, document: Y.Doc): HocuspocusProvider {
  const provider = new HocuspocusProvider({ url: wsUrl, name, token, document });
  openProviders.push(provider);
  return provider;
}

/** Deterministic sync point: resolves the first time `event` fires on `target`,
 *  rejects if it doesn't within `timeoutMs` (a safety net against a genuinely
 *  hung connection, not a substitute for the real signal). `HocuspocusProvider`
 *  ships its own minimal `EventEmitter` (on/emit/off only, no `once`), so this
 *  wires the one-shot behavior manually. */
function waitForEvent<T = unknown>(
  target: { on(event: string, cb: (arg: T) => void): void; off(event: string, cb: (arg: T) => void): void },
  event: string,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeoutMs);
    function handler(arg: T) {
      clearTimeout(timer);
      target.off(event, handler);
      resolve(arg);
    }
    target.on(event, handler);
  });
}

/** Deterministic sync point: resolves once `ytext` contains `needle`, instead
 *  of polling/sleeping - driven by Yjs's own observe callback. */
function waitForText(ytext: Y.Text, needle: string, timeoutMs = 5000): Promise<void> {
  if (ytext.toString().includes(needle)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ytext.unobserve(check);
      reject(new Error(`timed out waiting for text to contain "${needle}"`));
    }, timeoutMs);
    function check() {
      if (ytext.toString().includes(needle)) {
        clearTimeout(timer);
        ytext.unobserve(check);
        resolve();
      }
    }
    ytext.observe(check);
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ndbrain-collab-ws-"));
  db = openDatabase(":memory:");
  const vault = new Vault(dir);
  const git = new VaultGit(dir);
  await git.init();
  const indexer = new Indexer(db);
  const auth = new AuthService(db);
  notes = new NoteService(vault, git, indexer);
  const documents = new DocumentManager({ notes });
  apiKeys = new ApiKeyService(db);
  openProviders = [];
  // Short debounce: some assertions below check that a real edit landed on disk.
  app = buildServer({
    notes,
    auth,
    db,
    git,
    indexer,
    vault,
    apiKeys,
    documents,
    collabOptions: { debounce: 20, maxDebounce: 100 },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${address.port}/collab`;
});

afterEach(async () => {
  for (const provider of openProviders.splice(0)) provider.destroy();
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("/collab WebSocket upgrade", () => {
  it("syncs a real client edit to a second connected client over the real WS upgrade path", async () => {
    await notes.write("myai/live.md", "", "julian");
    const token = await apiKeys.create("myai-agent", "myai/", true);

    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const providerA = connect("myai/live.md", token, docA);
    const providerB = connect("myai/live.md", token, docB);
    await Promise.all([waitForEvent(providerA, "synced"), waitForEvent(providerB, "synced")]);

    docA.getText("content").insert(0, "hello from A");

    await waitForText(docB.getText("content"), "hello from A");
    expect(docB.getText("content").toString()).toBe("hello from A");

    // Also verify the edit actually persists back to the vault
    // (onStoreDocument -> DocumentManager.store), not just the in-memory CRDT
    // broadcast. No client-visible "stored" event exists to await, so this
    // polls the actual outcome (bounded, not a blind fixed-length sleep).
    await expect
      .poll(async () => notes.read("myai/live.md"), { timeout: 2000, interval: 20 })
      .toBe("hello from A");
  });

  it("rejects a token whose document scope doesn't cover the requested note", async () => {
    const outOfScopeToken = await apiKeys.create("other-agent", "other/", true);
    const doc = new Y.Doc();
    const provider = connect("myai/protected.md", outOfScopeToken, doc);

    const failure = await waitForEvent<{ reason: string }>(provider, "authenticationFailed");
    expect(failure.reason).toBeTruthy();
  });

  it("rejects an invalid/garbage token outright", async () => {
    const doc = new Y.Doc();
    const provider = connect("myai/anything.md", "ndb_garbage", doc);

    await expect(waitForEvent(provider, "authenticationFailed")).resolves.toBeDefined();
  });

  it("lets a read-only key connect and read the live doc, but its own edits never propagate to other clients or the file", async () => {
    await notes.write("myai/ro.md", "seed", "julian");
    const writeToken = await apiKeys.create("writer", "myai/", true);
    const readToken = await apiKeys.create("reader", "myai/", false);

    const docWriter = new Y.Doc();
    const docReader = new Y.Doc();
    const providerWriter = connect("myai/ro.md", writeToken, docWriter);
    const providerReader = connect("myai/ro.md", readToken, docReader);
    await Promise.all([waitForEvent(providerWriter, "synced"), waitForEvent(providerReader, "synced")]);

    expect(docReader.getText("content").toString()).toBe("seed");

    // Read-only client's own local Y.Doc still accepts the local mutation
    // (Yjs is local-first) - the assertion is that the SERVER rejects it, so
    // it never reaches the writer's replica or the file.
    docReader.getText("content").insert(4, " ro-edit");

    // No server->client ack event exists for "this will never arrive" - a
    // bounded real wait is the correct tool for a negative assertion (proving
    // an absence), not a substitute for a positive sync signal. 300ms is
    // generously above the 20/100ms debounce and local-loopback latency.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(docWriter.getText("content").toString()).toBe("seed");
    expect(await notes.read("myai/ro.md")).toBe("seed");
  });
});
