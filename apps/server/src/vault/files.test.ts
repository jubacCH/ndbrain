import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault, VaultPathError } from "./files.js";

let dir: string;
let vault: Vault;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ndbrain-"));
  vault = new Vault(dir);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("Vault", () => {
  it("writes atomically and reads back", async () => {
    await vault.write("myai/note.md", "# Hi");
    expect(await vault.read("myai/note.md")).toBe("# Hi");
  });

  it("returns null for missing notes", async () => {
    expect(await vault.read("nope.md")).toBeNull();
  });

  it("lists all markdown files as sorted relative paths", async () => {
    await vault.write("b.md", "b");
    await vault.write("a/x.md", "x");
    expect(await vault.list()).toEqual(["a/x.md", "b.md"]);
  });

  it("moves and removes notes", async () => {
    await vault.write("a.md", "a");
    await vault.move("a.md", "sub/b.md");
    expect(await vault.read("sub/b.md")).toBe("a");
    expect(await vault.remove("sub/b.md")).toBe(true);
    expect(await vault.read("sub/b.md")).toBeNull();
  });

  it("rejects traversal, absolute and non-md paths", () => {
    expect(() => vault.assertSafePath("../evil.md")).toThrow(VaultPathError);
    expect(() => vault.assertSafePath("/etc/passwd.md")).toThrow(VaultPathError);
    expect(() => vault.assertSafePath("note.txt")).toThrow(VaultPathError);
  });

  it("rejects paths with a .git segment (no audit-bypass writes)", () => {
    expect(() => vault.assertSafePath(".git/config.md")).toThrow(VaultPathError);
    expect(() => vault.assertSafePath("a/.git/x.md")).toThrow(VaultPathError);
  });

  it("never lists markdown files placed under .git/", async () => {
    await vault.write("a.md", "a");
    await mkdir(join(dir, ".git", "sub"), { recursive: true });
    await writeFile(join(dir, ".git", "sub", "hidden.md"), "secret");
    expect(await vault.list()).toEqual(["a.md"]);
  });
});
