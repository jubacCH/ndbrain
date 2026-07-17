import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted` is required (not a plain top-level `const`) because Vitest
// hoists `vi.mock(...)` calls above the rest of the file, including normal
// variable declarations — referencing a non-hoisted const from inside a
// mock factory would throw a temporal-dead-zone error.
const { dialogOpenMock, fsMocks, invokeMock } = vi.hoisted(() => ({
  dialogOpenMock: vi.fn(),
  fsMocks: {
    mkdir: vi.fn(),
    readDir: vi.fn(),
    readTextFile: vi.fn(),
    remove: vi.fn(),
    writeTextFile: vi.fn(),
  },
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialogOpenMock }));
vi.mock("@tauri-apps/plugin-fs", () => fsMocks);
// `platform/tauri.ts#isTauri` is re-exported straight from this module, so the
// mock keeps it wired to the same `globalThis.isTauri` flag `setTauriFlag`
// below toggles, rather than a real IPC-backed `isTauri()`.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: () => Boolean((globalThis as { isTauri?: boolean }).isTauri),
}));

import {
  assertSafeRelPath,
  extractTitle,
  LocalNotesStore,
  LocalPathError,
  pickFolderDialog,
} from "./localStore";

function setTauriFlag(value: boolean | undefined) {
  if (value === undefined) {
    delete (globalThis as { isTauri?: boolean }).isTauri;
    return;
  }
  (globalThis as { isTauri?: boolean }).isTauri = value;
}

describe("assertSafeRelPath", () => {
  it("accepts a simple relative path", () => {
    expect(assertSafeRelPath("notes/todo.md")).toBe("notes/todo.md");
  });

  it("normalizes backslashes to forward slashes", () => {
    expect(assertSafeRelPath("notes\\todo.md")).toBe("notes/todo.md");
  });

  it("rejects an absolute unix path", () => {
    expect(() => assertSafeRelPath("/etc/passwd")).toThrow(LocalPathError);
  });

  it("rejects an absolute windows path", () => {
    expect(() => assertSafeRelPath("C:\\Users\\x")).toThrow(LocalPathError);
  });

  it("rejects .. traversal anywhere in the path", () => {
    expect(() => assertSafeRelPath("../secret.md")).toThrow(LocalPathError);
    expect(() => assertSafeRelPath("a/../../etc/passwd")).toThrow(LocalPathError);
  });

  it("rejects an empty path", () => {
    expect(() => assertSafeRelPath("")).toThrow(LocalPathError);
  });
});

describe("extractTitle", () => {
  it("extracts the first heading", () => {
    expect(extractTitle("# Hello World\n\nBody text")).toBe("Hello World");
  });

  it("extracts a lower-level heading and trims whitespace", () => {
    expect(extractTitle("intro\n### My Title   \nmore")).toBe("My Title");
  });

  it("returns null when there is no heading", () => {
    expect(extractTitle("just some text\nno heading here")).toBeNull();
  });
});

describe("pickFolderDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    setTauriFlag(undefined);
  });

  it("returns null and does not open a dialog in the browser", async () => {
    setTauriFlag(undefined);
    await expect(pickFolderDialog()).resolves.toBeNull();
    expect(dialogOpenMock).not.toHaveBeenCalled();
  });

  it("opens a directory dialog and returns the chosen path", async () => {
    setTauriFlag(true);
    dialogOpenMock.mockResolvedValueOnce("/Users/j/notes");

    await expect(pickFolderDialog()).resolves.toBe("/Users/j/notes");
    expect(dialogOpenMock).toHaveBeenCalledWith({ directory: true, multiple: false });
  });

  it("returns null when the user cancels", async () => {
    setTauriFlag(true);
    dialogOpenMock.mockResolvedValueOnce(null);

    await expect(pickFolderDialog()).resolves.toBeNull();
  });
});

describe("LocalNotesStore in the browser (!isTauri)", () => {
  beforeEach(() => {
    setTauriFlag(undefined);
    vi.clearAllMocks();
  });

  it("no-ops to empty/false without calling any tauri API", async () => {
    const store = new LocalNotesStore("/root");

    await expect(store.listLocal()).resolves.toEqual([]);
    await expect(store.readLocal("a.md")).resolves.toBe("");
    await expect(store.writeLocal("a.md", "x")).resolves.toBeUndefined();
    await expect(store.deleteLocal("a.md")).resolves.toBe(false);

    expect(fsMocks.readDir).not.toHaveBeenCalled();
    expect(fsMocks.readTextFile).not.toHaveBeenCalled();
    expect(fsMocks.writeTextFile).not.toHaveBeenCalled();
    expect(fsMocks.remove).not.toHaveBeenCalled();
    expect(fsMocks.mkdir).not.toHaveBeenCalled();
  });

  it("grantFolderAccess no-ops without invoking the Tauri command", async () => {
    const store = new LocalNotesStore("/root");
    await expect(store.grantFolderAccess()).resolves.toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not crash and does not validate rel on the no-op path", async () => {
    const store = new LocalNotesStore("/root");
    await expect(store.readLocal("../../etc/passwd")).resolves.toBe("");
    await expect(store.writeLocal("/abs/path.md", "x")).resolves.toBeUndefined();
  });
});

describe("LocalNotesStore in Tauri", () => {
  beforeEach(() => {
    setTauriFlag(true);
    vi.clearAllMocks();
  });

  afterEach(() => {
    setTauriFlag(undefined);
  });

  it("listLocal recursively lists .md files with parsed titles, skipping dotfiles/dirs", async () => {
    fsMocks.readDir.mockImplementation(async (dir: string) => {
      if (dir === "/root") {
        return [
          { name: "a.md", isFile: true, isDirectory: false, isSymlink: false },
          { name: "sub", isFile: false, isDirectory: true, isSymlink: false },
          { name: ".git", isFile: false, isDirectory: true, isSymlink: false },
          { name: "notes.txt", isFile: true, isDirectory: false, isSymlink: false },
        ];
      }
      if (dir === "/root/sub") {
        return [{ name: "b.md", isFile: true, isDirectory: false, isSymlink: false }];
      }
      throw new Error(`unexpected readDir(${dir})`);
    });
    fsMocks.readTextFile.mockImplementation(async (path: string) => {
      if (path === "/root/a.md") return "# Note A\nbody";
      if (path === "/root/sub/b.md") return "no heading here";
      throw new Error(`unexpected readTextFile(${path})`);
    });

    const store = new LocalNotesStore("/root");
    const notes = await store.listLocal();

    expect(notes).toEqual([
      { path: "a.md", title: "Note A" },
      { path: "sub/b.md", title: null },
    ]);
    expect(fsMocks.readDir).not.toHaveBeenCalledWith("/root/.git");
    expect(fsMocks.readTextFile).not.toHaveBeenCalledWith("/root/notes.txt");
  });

  it("listLocal skips a file that fails to read (title: null) instead of aborting the whole listing", async () => {
    fsMocks.readDir.mockImplementation(async (dir: string) => {
      if (dir === "/root") {
        return [
          { name: "a.md", isFile: true, isDirectory: false, isSymlink: false },
          { name: "broken.md", isFile: true, isDirectory: false, isSymlink: false },
          { name: "c.md", isFile: true, isDirectory: false, isSymlink: false },
        ];
      }
      throw new Error(`unexpected readDir(${dir})`);
    });
    fsMocks.readTextFile.mockImplementation(async (path: string) => {
      if (path === "/root/a.md") return "# A";
      if (path === "/root/broken.md") throw new Error("EACCES: permission denied");
      if (path === "/root/c.md") return "# C";
      throw new Error(`unexpected readTextFile(${path})`);
    });

    const store = new LocalNotesStore("/root");
    const notes = await store.listLocal();

    expect(notes).toEqual([
      { path: "a.md", title: "A" },
      { path: "broken.md", title: null },
      { path: "c.md", title: "C" },
    ]);
  });

  it("readLocal reads the file at this store's folder + rel", async () => {
    fsMocks.readTextFile.mockResolvedValueOnce("hello");
    const store = new LocalNotesStore("/root");

    expect(await store.readLocal("sub/note.md")).toBe("hello");
    expect(fsMocks.readTextFile).toHaveBeenCalledWith("/root/sub/note.md");
  });

  it("readLocal rejects an unsafe rel path without touching the filesystem", async () => {
    const store = new LocalNotesStore("/root");

    await expect(store.readLocal("../secret.md")).rejects.toThrow(LocalPathError);
    expect(fsMocks.readTextFile).not.toHaveBeenCalled();
  });

  it("writeLocal mkdir -p's the parent directory before writing", async () => {
    const store = new LocalNotesStore("/root");

    await store.writeLocal("sub/dir/note.md", "content");

    expect(fsMocks.mkdir).toHaveBeenCalledWith("/root/sub/dir", { recursive: true });
    expect(fsMocks.writeTextFile).toHaveBeenCalledWith("/root/sub/dir/note.md", "content");
  });

  it("writeLocal at the root skips mkdir (no parent directory)", async () => {
    const store = new LocalNotesStore("/root");

    await store.writeLocal("note.md", "content");

    expect(fsMocks.mkdir).not.toHaveBeenCalled();
    expect(fsMocks.writeTextFile).toHaveBeenCalledWith("/root/note.md", "content");
  });

  it("writeLocal rejects an unsafe rel path without touching the filesystem", async () => {
    const store = new LocalNotesStore("/root");

    await expect(store.writeLocal("/abs.md", "x")).rejects.toThrow(LocalPathError);
    expect(fsMocks.mkdir).not.toHaveBeenCalled();
    expect(fsMocks.writeTextFile).not.toHaveBeenCalled();
  });

  it("deleteLocal removes the file and returns true", async () => {
    fsMocks.remove.mockResolvedValueOnce(undefined);
    const store = new LocalNotesStore("/root");

    expect(await store.deleteLocal("note.md")).toBe(true);
    expect(fsMocks.remove).toHaveBeenCalledWith("/root/note.md");
  });

  it("deleteLocal returns false when the underlying remove fails", async () => {
    fsMocks.remove.mockRejectedValueOnce(new Error("not found"));
    const store = new LocalNotesStore("/root");

    expect(await store.deleteLocal("gone.md")).toBe(false);
  });

  it("grantFolderAccess invokes the allow_local_notes_folder Rust command with this store's folder", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const store = new LocalNotesStore("/Users/j/notes");

    await store.grantFolderAccess();

    expect(invokeMock).toHaveBeenCalledWith("allow_local_notes_folder", { path: "/Users/j/notes" });
  });

  it("keeps two stores with different folders fully independent", async () => {
    fsMocks.readDir.mockImplementation(async (dir: string) => {
      if (dir === "/root-a") return [{ name: "a.md", isFile: true, isDirectory: false, isSymlink: false }];
      if (dir === "/root-b") return [{ name: "b.md", isFile: true, isDirectory: false, isSymlink: false }];
      throw new Error(`unexpected readDir(${dir})`);
    });
    fsMocks.readTextFile.mockImplementation(async (path: string) => {
      if (path === "/root-a/a.md") return "# A";
      if (path === "/root-b/b.md") return "# B";
      throw new Error(`unexpected readTextFile(${path})`);
    });

    const storeA = new LocalNotesStore("/root-a");
    const storeB = new LocalNotesStore("/root-b");

    expect(await storeA.listLocal()).toEqual([{ path: "a.md", title: "A" }]);
    expect(await storeB.listLocal()).toEqual([{ path: "b.md", title: "B" }]);

    await storeA.writeLocal("note.md", "content a");
    await storeB.writeLocal("note.md", "content b");
    expect(fsMocks.writeTextFile).toHaveBeenCalledWith("/root-a/note.md", "content a");
    expect(fsMocks.writeTextFile).toHaveBeenCalledWith("/root-b/note.md", "content b");

    await storeA.grantFolderAccess();
    await storeB.grantFolderAccess();
    expect(invokeMock).toHaveBeenCalledWith("allow_local_notes_folder", { path: "/root-a" });
    expect(invokeMock).toHaveBeenCalledWith("allow_local_notes_folder", { path: "/root-b" });
  });
});
