import { describe, expect, it, vi } from "vitest";
import { createShutdown } from "./shutdown.js";

describe("createShutdown", () => {
  it("closes app, watcher and db exactly once, in dependency order", async () => {
    const order: string[] = [];
    const app = { close: vi.fn(async () => void order.push("app")) };
    const watcher = { stop: vi.fn(async () => void order.push("watcher")) };
    const db = { close: vi.fn(() => void order.push("db")) };

    const shutdown = createShutdown({ app, watcher, db });
    await shutdown();
    await shutdown(); // second signal must be a no-op

    expect(order).toEqual(["app", "watcher", "db"]);
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(watcher.stop).toHaveBeenCalledTimes(1);
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  // C2: a real end-to-end version of this (real server, real WS client, real
  // persisted-to-disk assertion) lives in http/server.test.ts's "a real shutdown..."
  // test. This is the lighter-weight ordering unit test the task also asked for.
  it("disconnects collab clients and flushes pending Hocuspocus stores, then force-closes collab sockets, all BEFORE app.close()", async () => {
    const order: string[] = [];
    const app = { close: vi.fn(async () => void order.push("app.close")) };
    const watcher = { stop: vi.fn(async () => void order.push("watcher")) };
    const db = { close: vi.fn(() => void order.push("db")) };
    const hocuspocus = {
      // No documents pending — `flushHocuspocusStores` resolves synchronously in this
      // case, so this test only needs to prove call ORDER, not the async-flush path
      // itself (covered by collab/server.test.ts's own dedicated tests).
      getDocumentsCount: vi.fn(() => 0),
      closeConnections: vi.fn(() => void order.push("hocuspocus.closeConnections")),
      flushPendingStores: vi.fn(),
      configuration: { extensions: [] },
    };
    const closeCollabSockets = vi.fn(() => void order.push("closeCollabSockets"));

    const shutdown = createShutdown({ app, watcher, db, hocuspocus, closeCollabSockets });
    await shutdown();

    expect(order).toEqual(["hocuspocus.closeConnections", "closeCollabSockets", "app.close", "watcher", "db"]);
    expect(hocuspocus.closeConnections).toHaveBeenCalledTimes(1);
    expect(closeCollabSockets).toHaveBeenCalledTimes(1);
  });

  it("awaits documents.flushAll() (which itself awaits any in-flight store()) after app.close()", async () => {
    const order: string[] = [];
    const app = { close: vi.fn(async () => void order.push("app")) };
    const watcher = { stop: vi.fn(async () => void order.push("watcher")) };
    const db = { close: vi.fn(() => void order.push("db")) };
    let releaseFlush = () => {};
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const documents = {
      flushAll: vi.fn(async () => {
        order.push("documents.flushAll start");
        await flushGate;
        order.push("documents.flushAll end");
      }),
    };

    const shutdown = createShutdown({ app, watcher, db, documents });
    const shutdownPromise = shutdown();

    // Give app.close() and the start of flushAll a chance to run before releasing it,
    // proving shutdown() genuinely awaits flushAll rather than racing past it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["app", "documents.flushAll start"]);

    releaseFlush();
    await shutdownPromise;

    expect(order).toEqual(["app", "documents.flushAll start", "documents.flushAll end", "watcher", "db"]);
  });
});
