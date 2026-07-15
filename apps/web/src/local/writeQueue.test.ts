import { describe, expect, it, vi } from "vitest";
import { createWriteQueue } from "./writeQueue";

/** A controllable promise the test can resolve/reject on its own schedule —
 *  used to simulate slow/out-of-order-settling writes (e.g. two overlapping
 *  Tauri IPC calls) without relying on real timers. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createWriteQueue", () => {
  it("never starts a new write for a path before the previous one has settled", async () => {
    const first = deferred<void>();
    const write = vi.fn((path: string, content: string) => {
      return path === "a.md" && content === "1" ? first.promise : Promise.resolve();
    });
    const queue = createWriteQueue(write);

    queue.enqueue("a.md", "1");
    queue.enqueue("a.md", "2");
    // Give any (incorrect) eager scheduling a chance to run.
    await Promise.resolve();
    await Promise.resolve();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("a.md", "1");

    first.resolve();
    await queue.flush("a.md");

    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(2, "a.md", "2");
  });

  it("coalesces writes enqueued while one is already in flight — only the latest content still gets its own write", async () => {
    const first = deferred<void>();
    const calls: string[] = [];
    const write = vi.fn(async (path: string, content: string) => {
      calls.push(content);
      if (content === "a") await first.promise;
    });
    const queue = createWriteQueue(write);

    queue.enqueue("note.md", "a"); // starts writing immediately
    queue.enqueue("note.md", "b"); // superseded before "a" settles
    queue.enqueue("note.md", "c"); // superseded before "a" settles

    first.resolve();
    await queue.flush("note.md");

    // "b" was overwritten by "c" before the queue ever got to it — only the
    // in-flight "a" and the final "c" were actually written to disk.
    expect(calls).toEqual(["a", "c"]);
  });

  it("guarantees the last-enqueued content is the last one written, even if writes would otherwise settle out of order", async () => {
    // Simulates the original bug: a write for older content ("stale") takes
    // longer than a write for newer content ("fresh") would, if they were
    // allowed to race. The queue must never let that reordering surface.
    const staleWrite = deferred<void>();
    const writeOrder: string[] = [];
    const write = vi.fn(async (_path: string, content: string) => {
      if (content === "stale") await staleWrite.promise;
      writeOrder.push(content);
    });
    const queue = createWriteQueue(write);

    queue.enqueue("note.md", "stale");
    // "stale"'s write is now in flight; resolving it later, after "fresh" has
    // been queued, must not let "stale" win — the queue only starts writing
    // "fresh" once "stale" is done, and "fresh" is the last word either way.
    queue.enqueue("note.md", "fresh");

    staleWrite.resolve();
    await queue.flush("note.md");

    expect(writeOrder).toEqual(["stale", "fresh"]);
    expect(write).toHaveBeenLastCalledWith("note.md", "fresh");
  });

  it("flush resolves only once every enqueued write for that path has settled", async () => {
    const first = deferred<void>();
    const write = vi.fn(() => first.promise);
    const queue = createWriteQueue(write);

    queue.enqueue("note.md", "x");

    let flushed = false;
    const flushPromise = queue.flush("note.md").then(() => {
      flushed = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(flushed).toBe(false);

    first.resolve();
    await flushPromise;
    expect(flushed).toBe(true);
  });

  it("flush is a no-op when nothing is pending or in flight for a path", async () => {
    const write = vi.fn(async () => {});
    const queue = createWriteQueue(write);

    await expect(queue.flush("never-touched.md")).resolves.toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  });

  it("flushAll waits for every path with pending or in-flight work", async () => {
    const a = deferred<void>();
    const b = deferred<void>();
    const write = vi.fn((path: string) => (path === "a.md" ? a.promise : b.promise));
    const queue = createWriteQueue(write);

    queue.enqueue("a.md", "1");
    queue.enqueue("b.md", "1");

    let flushed = false;
    const flushAllPromise = queue.flushAll().then(() => {
      flushed = true;
    });

    await Promise.resolve();
    expect(flushed).toBe(false);

    a.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(flushed).toBe(false); // b.md is still in flight

    b.resolve();
    await flushAllPromise;
    expect(flushed).toBe(true);
  });

  it("writes to different paths run independently of one another", async () => {
    const a = deferred<void>();
    const calls: string[] = [];
    const write = vi.fn(async (path: string, content: string) => {
      calls.push(`start:${path}:${content}`);
      if (path === "a.md") await a.promise;
      calls.push(`end:${path}:${content}`);
    });
    const queue = createWriteQueue(write);

    queue.enqueue("a.md", "1");
    queue.enqueue("b.md", "1");
    await queue.flush("b.md");

    // b.md's write must not have waited on a.md's still-pending write.
    expect(calls).toEqual(["start:a.md:1", "start:b.md:1", "end:b.md:1"]);

    a.resolve();
    await queue.flush("a.md");
    expect(calls).toEqual(["start:a.md:1", "start:b.md:1", "end:b.md:1", "end:a.md:1"]);
  });
});
