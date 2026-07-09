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
});
