import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { openDatabase, type Database } from "../db/database.js";
import { Indexer } from "../index/indexer.js";
import { NoteService } from "../notes/service.js";
import { Vault } from "../vault/files.js";
import { VaultGit } from "../vault/git.js";
import { AuthService } from "../http/auth.js";
import { ApiKeyService } from "../keys/service.js";
import { DocumentManager } from "./document-manager.js";
import { createCollabServer, type CollabServerDeps } from "./server.js";

let dir: string;
let db: Database;
let notes: NoteService;
let documents: DocumentManager;
let auth: AuthService;
let apiKeys: ApiKeyService;
let deps: CollabServerDeps;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ndbrain-collab-server-"));
  db = openDatabase(":memory:");
  const git = new VaultGit(dir);
  await git.init();
  notes = new NoteService(new Vault(dir), git, new Indexer(db));
  documents = new DocumentManager({ notes });
  auth = new AuthService(db);
  apiKeys = new ApiKeyService(db);
  deps = { auth, apiKeys, documents };
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("createCollabServer", () => {
  it("merges concurrent Y.Text edits from two independent replicas through the shared server document", async () => {
    // Fast debounce so this test doesn't wait out Hocuspocus's default 2s/10s.
    const server = createCollabServer(deps, { debounce: 10, maxDebounce: 50 });
    const direct = await server.openDirectConnection("note-merge-spec.md");

    // Two independent replicas, diverging from the same empty starting state —
    // simulates two collaborators editing offline before syncing.
    const clientA = new Y.Doc();
    const clientB = new Y.Doc();
    clientA.getText("content").insert(0, "Hello ");
    clientB.getText("content").insert(0, "World");

    // Push both replicas' updates into the server's authoritative Y.Doc.
    // Real CRDT merge via Y.applyUpdate — no mocking of Yjs internals.
    await direct.transact((document) => {
      Y.applyUpdate(document, Y.encodeStateAsUpdate(clientA));
    });
    await direct.transact((document) => {
      Y.applyUpdate(document, Y.encodeStateAsUpdate(clientB));
    });

    const merged = direct.document?.getText("content").toString() ?? "";
    expect(merged).toContain("Hello");
    expect(merged).toContain("World");

    // Propagate the merged server state back to both replicas.
    const mergedUpdate = Y.encodeStateAsUpdate(direct.document as Y.Doc);
    Y.applyUpdate(clientA, mergedUpdate);
    Y.applyUpdate(clientB, mergedUpdate);

    // True CRDT convergence: server and both replicas now agree byte-for-byte.
    expect(clientA.getText("content").toString()).toBe(merged);
    expect(clientB.getText("content").toString()).toBe(merged);

    await direct.disconnect({ unloadImmediately: true });
    expect(server.documents.size).toBe(0);
  });

  it("exposes handleConnection so a host process can forward its own WebSocket upgrades", () => {
    const server = createCollabServer(deps);
    expect(typeof server.handleConnection).toBe("function");
  });

  describe("onLoadDocument -> DocumentManager.load", () => {
    it("seeds the server's Y.Doc from the note's existing file content", async () => {
      await notes.write("myai/a.md", "# existing content", "julian");
      const server = createCollabServer(deps);

      const direct = await server.openDirectConnection("myai/a.md");

      expect(direct.document?.getText("content").toString()).toBe("# existing content");
      await direct.disconnect({ unloadImmediately: true });
    });
  });

  describe("onStoreDocument -> DocumentManager.store", () => {
    it("persists a document edit back to the vault through NoteService, attributed to the connection's actor", async () => {
      const token = await apiKeys.create("myai-agent", "myai/", true);
      const server = createCollabServer(deps);

      const context = await server.hooks("onAuthenticate", {
        token,
        documentName: "myai/a.md",
        connectionConfig: { readOnly: false, isAuthenticated: false },
        context: {},
      } as never);
      expect(context).toEqual({ actor: "myai-agent" });

      const direct = await server.openDirectConnection("myai/a.md", context);
      await direct.transact((document) => {
        document.getText("content").insert(0, "hello from the doc");
      });

      // `disconnect({ unloadImmediately: true })` runs `onStoreDocument`
      // (debounce=0 on that path) and awaits it before resolving — a
      // deterministic sync point, no sleep/poll needed.
      await direct.disconnect({ unloadImmediately: true });

      expect(await notes.read("myai/a.md")).toBe("hello from the doc");
    });
  });

  describe("afterUnloadDocument -> DocumentManager.unload", () => {
    it("removes the path from DocumentManager's live registry once Hocuspocus unloads it", async () => {
      const server = createCollabServer(deps);
      await notes.write("myai/a.md", "# A", "julian");

      const direct = await server.openDirectConnection("myai/a.md");
      expect(documents.isLive("myai/a.md")).toBe(true);

      await direct.disconnect({ unloadImmediately: true });

      expect(documents.isLive("myai/a.md")).toBe(false);
    });
  });

  describe("onAuthenticate wiring", () => {
    it("rejects a connection whose parsed documentName is not already canonical", async () => {
      const token = await apiKeys.create("myai-agent", "myai/", true);
      const server = createCollabServer(deps);

      // "myai/./a.md" normalizes (assertSafePath) to "myai/a.md" - not equal to
      // the raw name Hocuspocus parsed from the wire message, so this must be
      // rejected rather than silently opening "myai/a.md" under a different key.
      await expect(
        server.hooks("onAuthenticate", {
          token,
          documentName: "myai/./a.md",
          connectionConfig: { readOnly: false, isAuthenticated: false },
          context: {},
        } as never),
      ).rejects.toThrow();
    });

    it("sets connectionConfig.readOnly for a read-only key", async () => {
      const token = await apiKeys.create("reader", "myai/", false);
      const server = createCollabServer(deps);
      const connectionConfig = { readOnly: false, isAuthenticated: false };

      const context = await server.hooks("onAuthenticate", {
        token,
        documentName: "myai/a.md",
        connectionConfig,
        context: {},
      } as never);

      expect(connectionConfig.readOnly).toBe(true);
      expect(context).toEqual({ actor: "reader" });
    });

    it("leaves connectionConfig.readOnly false for a write-capable key", async () => {
      const token = await apiKeys.create("writer", "myai/", true);
      const server = createCollabServer(deps);
      const connectionConfig = { readOnly: false, isAuthenticated: false };

      await server.hooks("onAuthenticate", {
        token,
        documentName: "myai/a.md",
        connectionConfig,
        context: {},
      } as never);

      expect(connectionConfig.readOnly).toBe(false);
    });

    it("rejects an out-of-scope key", async () => {
      const token = await apiKeys.create("myai-agent", "myai/", true);
      const server = createCollabServer(deps);

      await expect(
        server.hooks("onAuthenticate", {
          token,
          documentName: "other/a.md",
          connectionConfig: { readOnly: false, isAuthenticated: false },
          context: {},
        } as never),
      ).rejects.toThrow();
    });
  });
});
