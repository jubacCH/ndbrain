import { describe, expect, it } from "vitest";
import { Mutex } from "./mutex.js";

describe("Mutex", () => {
  it("runs queued tasks strictly sequentially regardless of their duration", async () => {
    const mutex = new Mutex();
    const order: string[] = [];
    const task = (id: string, delay: number) =>
      mutex.run(async () => {
        order.push(`${id}:start`);
        await new Promise((r) => setTimeout(r, delay));
        order.push(`${id}:end`);
      });
    // b/c would finish before a if they were not serialized.
    await Promise.all([task("a", 30), task("b", 5), task("c", 15)]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("keeps serializing subsequent tasks after one rejects", async () => {
    const mutex = new Mutex();
    const order: string[] = [];
    await expect(
      mutex.run(async () => {
        order.push("x");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await mutex.run(async () => {
      order.push("y");
    });
    expect(order).toEqual(["x", "y"]);
  });

  it("returns the value produced by the task", async () => {
    const mutex = new Mutex();
    await expect(mutex.run(async () => 42)).resolves.toBe(42);
  });
});
