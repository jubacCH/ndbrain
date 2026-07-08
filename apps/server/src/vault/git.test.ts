import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VaultGit } from "./git.js";

let dir: string;
let git: VaultGit;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ndbrain-git-"));
  git = new VaultGit(dir);
  await git.init();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("VaultGit", () => {
  it("init is idempotent", async () => {
    await expect(git.init()).resolves.toBeUndefined();
  });

  it("commits changes with the acting author and lists history", async () => {
    await writeFile(join(dir, "a.md"), "v1");
    await git.commitChange("update a.md", "myai-key");
    await writeFile(join(dir, "a.md"), "v2");
    await git.commitChange("update a.md again", "julian");
    const history = await git.historyFor("a.md");
    expect(history).toHaveLength(2);
    expect(history[0].message).toBe("update a.md again");
    expect(history[0].author).toBe("julian");
  });

  it("is a no-op when nothing changed", async () => {
    await git.commitChange("empty", "julian");
    await expect(git.historyFor("a.md")).resolves.toEqual([]);
  });

  it("creates its own repo even when nested inside another git repo", async () => {
    const outer = await mkdtemp(join(tmpdir(), "ndbrain-outer-"));
    const outerGit = new VaultGit(outer);
    await outerGit.init();
    const inner = join(outer, "vault");
    await mkdir(inner, { recursive: true });
    const innerGit = new VaultGit(inner);
    await innerGit.init();
    await writeFile(join(inner, "n.md"), "x");
    await innerGit.commitChange("update n.md", "julian");
    expect(await innerGit.historyFor("n.md")).toHaveLength(1);
    // the outer repo must NOT have received the commit
    expect(await outerGit.historyFor("vault/n.md")).toEqual([]);
    await rm(outer, { recursive: true, force: true });
  });
});
