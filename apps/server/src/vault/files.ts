import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { randomUUID } from "node:crypto";

export class VaultPathError extends Error {}

/** Filesystem access to the markdown vault. All paths are vault-relative POSIX paths. */
export class Vault {
  constructor(readonly rootDir: string) {}

  assertSafePath(path: string): string {
    const norm = normalize(path).replaceAll(sep, "/");
    if (!norm.endsWith(".md")) throw new VaultPathError(`not a markdown path: ${path}`);
    if (norm.startsWith("/") || norm.startsWith("..") || norm.includes("/../"))
      throw new VaultPathError(`unsafe path: ${path}`);
    // Reject any path that touches the git metadata dir: writes there would be
    // indexed but never committed, bypassing the audit trail.
    if (norm.split("/").includes(".git")) throw new VaultPathError(`unsafe path: ${path}`);
    return norm;
  }

  private abs(path: string): string {
    return join(this.rootDir, this.assertSafePath(path));
  }

  async read(path: string): Promise<string | null> {
    try {
      return await readFile(this.abs(path), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async write(path: string, content: string): Promise<void> {
    const target = this.abs(path);
    await mkdir(dirname(target), { recursive: true });
    const tmp = join(dirname(target), `.${randomUUID()}.tmp`);
    await writeFile(tmp, content, "utf8");
    await rename(tmp, target);
  }

  async remove(path: string): Promise<boolean> {
    try {
      await rm(this.abs(path));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  async move(from: string, to: string): Promise<void> {
    const target = this.abs(to);
    await mkdir(dirname(target), { recursive: true });
    await rename(this.abs(from), target);
  }

  async list(): Promise<string[]> {
    const entries = await readdir(this.rootDir, { recursive: true, withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => join(e.parentPath, e.name).slice(this.rootDir.length + 1).replaceAll(sep, "/"))
      // Never surface git metadata as notes (list() reads the FS directly).
      .filter((rel) => !rel.split("/").includes(".git"))
      .sort();
  }
}
