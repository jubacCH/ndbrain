import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as netConnect } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { WebSocket } from "ws";
import { openDatabase, type Database } from "../db/database.js";
import { Indexer } from "../index/indexer.js";
import { NoteService } from "../notes/service.js";
import { Vault } from "../vault/files.js";
import { VaultGit } from "../vault/git.js";
import { AuthService } from "./auth.js";
import { ApiKeyService } from "../keys/service.js";
import { DocumentManager } from "../collab/document-manager.js";
import { buildServer, type NdbrainServer } from "./server.js";
import { createShutdown } from "../shutdown.js";

let dir: string;
let app: NdbrainServer;
let db: Database;
let notes: NoteService;
let apiKeys: ApiKeyService;
let wsUrl: string;
let openProviders: HocuspocusProvider[];
let capturedSockets: WebSocket[];
let documents: DocumentManager;

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
  documents = new DocumentManager({ notes });
  apiKeys = new ApiKeyService(db);
  openProviders = [];
  capturedSockets = [];
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
    // Test-only observation hook (see I4): the injected replacement for the old
    // NODE_ENV-gated global socket list, which leaked every socket in production
    // whenever NODE_ENV was unset (bare `node`/systemd/LXC, not just Docker).
    onCollabSocket: (ws) => capturedSockets.push(ws),
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
  it("handles socket errors gracefully without crashing the server process", async () => {
    await notes.write("myai/test.md", "", "julian");
    const token = await apiKeys.create("myai-agent", "myai/", true);

    // Capture uncaught exceptions at the process level
    const uncaughtErrors: Error[] = [];
    const errorHandler = (err: Error) => uncaughtErrors.push(err);
    process.on("uncaughtException", errorHandler);

    try {
      const doc = new Y.Doc();
      const provider = connect("myai/test.md", token, doc);
      await waitForEvent(provider, "synced");

      // Grab the captured WebSocket via the injected onCollabSocket test hook.
      const capturedWs = capturedSockets[capturedSockets.length - 1];

      if (!capturedWs) {
        throw new Error("Could not capture WebSocket from server handleUpgrade");
      }

      // Emit an error event on the server-side socket that simulates ECONNRESET
      capturedWs.emit("error", new Error("Simulated ECONNRESET: connection reset by peer"));

      // Give any async error handling time to process
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify the server process is still alive and responsive
      // by opening a new connection (if server crashed, this would fail)
      const doc2 = new Y.Doc();
      const provider2 = connect("myai/test.md", token, doc2);
      await waitForEvent(provider2, "synced", 3000);

      // If we successfully connected a second time, the server survived
      expect(uncaughtErrors).toHaveLength(0);
    } finally {
      process.off("uncaughtException", errorHandler);
    }
  });

  it("survives a raw WS upgrade request with a malformed Host header instead of crashing the process", async () => {
    const address = app.server.address() as AddressInfo;

    // Capture uncaught exceptions at the process level: `new URL(url, "http://" + host)`
    // throws on a Host header containing a space, and that throw used to happen with no
    // try/catch anywhere in the raw 'upgrade' callback chain, escaping as an
    // uncaughtException that (without this listener) would kill the whole process.
    const uncaughtErrors: Error[] = [];
    const errorHandler = (err: Error) => uncaughtErrors.push(err);
    process.on("uncaughtException", errorHandler);

    let rawSocket: import("node:net").Socket | undefined;
    try {
      await new Promise<void>((resolve) => {
        rawSocket = netConnect(address.port, "127.0.0.1", () => {
          rawSocket!.write(
            "GET /collab HTTP/1.1\r\n" +
              "Host: bad host with spaces\r\n" +
              "Upgrade: websocket\r\n" +
              "Connection: Upgrade\r\n" +
              "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
              "Sec-WebSocket-Version: 13\r\n" +
              "\r\n",
          );
        });
        // Any of these outcomes (reset, close, or a bounded timeout) is acceptable here -
        // the point isn't what happens to this one malformed connection, it's that
        // handling it must never take the whole process down.
        rawSocket.on("error", () => resolve());
        rawSocket.on("close", () => resolve());
        rawSocket.on("data", () => resolve());
        setTimeout(resolve, 500);
      });

      // Give the event loop a moment for a crash-inducing throw to have surfaced.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(uncaughtErrors).toHaveLength(0);

      // The server must still be alive: a subsequent, well-formed WS connection succeeds.
      const token = await apiKeys.create("myai-agent", "myai/", true);
      const doc = new Y.Doc();
      const provider = connect("myai/after-bad-host.md", token, doc);
      await waitForEvent(provider, "synced", 3000);
    } finally {
      process.off("uncaughtException", errorHandler);
      // The malformed-host request is tolerated (not rejected), so its raw socket is left
      // open by the server (a legitimate, if unauthenticated, pending connection) - close it
      // ourselves so it doesn't linger past this test and block `afterEach`'s `app.close()`
      // (that hang is exactly C2's concern, not this test's; it isn't fixed yet at this
      // point in the branch and shouldn't gate this unrelated C1 assertion).
      rawSocket?.destroy();
    }
  });

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

  it("a real shutdown resolves within a bounded time and persists a pending edit, even with an open collab client (C2)", async () => {
    // Own generous test timeout: the 5000ms *internal* race below is the actual
    // assertion under test (bounded shutdown); this just gives it room to lose.
    await notes.write("myai/shutdown.md", "", "julian");
    const token = await apiKeys.create("myai-agent", "myai/", true);

    const doc = new Y.Doc();
    const provider = connect("myai/shutdown.md", token, doc);
    await waitForEvent(provider, "synced");

    // Edit, then wait for it to actually reach the SERVER over the wire (a bounded
    // real wait for a deterministic condition, not a fixed sleep) before shutting
    // down - deliberately NOT waiting out this suite's 20ms debounce on top of that.
    // Shutdown must force the pending store itself, not rely on having gotten lucky
    // with timing, but it also isn't meant to survive an edit that hasn't even
    // reached the server yet (that's plain network transit, not a debounce window).
    doc.getText("content").insert(0, "persisted before exit");
    await expect
      .poll(() => documents.getLiveMarkdown("myai/shutdown.md"), { timeout: 2000, interval: 10 })
      .toBe("persisted before exit");

    const shutdown = createShutdown({
      app,
      watcher: { stop: async () => {} },
      db: { close: () => {} },
      documents,
      hocuspocus: app.hocuspocus,
      closeCollabSockets: app.closeCollabSockets,
    });

    const start = Date.now();
    await Promise.race([
      shutdown(),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("shutdown did not resolve in time")), 5000),
      ),
    ]);
    expect(Date.now() - start).toBeLessThan(5000);

    expect(await notes.read("myai/shutdown.md")).toBe("persisted before exit");

    // This test's own `shutdown()` already closed `app` - drop it from `openProviders`
    // handling too so `afterEach`'s own `app.close()` (idempotent) and provider
    // teardown don't have anything surprising left to do.
    provider.destroy();
    openProviders.splice(openProviders.indexOf(provider), 1);
  }, 8000);
});
