import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createCollabServer } from "./server.js";

describe("createCollabServer", () => {
  it("merges concurrent Y.Text edits from two independent replicas through the shared server document", async () => {
    const server = createCollabServer();
    const direct = await server.openDirectConnection("note-merge-spec");

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
    const server = createCollabServer();
    expect(typeof server.handleConnection).toBe("function");
  });
});
