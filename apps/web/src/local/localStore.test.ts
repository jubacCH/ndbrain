import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted` is required (not a plain top-level `const`) because Vitest
// hoists `vi.mock(...)` calls above the rest of the file, including normal
// variable declarations — referencing a non-hoisted const from inside a
// mock factory would throw a temporal-dead-zone error.
const { dialogOpenMock, fsMocks, loadMock, invokeMock } = vi.hoisted(() => ({
  dialogOpenMock: vi.fn(),
  fsMocks: {
    mkdir: vi.fn(),
    readDir: vi.fn(),
    readTextFile: vi.fn(),
    remove: vi.fn(),
    writeTextFile: vi.fn(),
  },
  loadMock: vi.fn(),
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialogOpenMock }));
vi.mock("@tauri-apps/plugin-fs", () => fsMocks);
vi.mock("@tauri-apps/plugin-store", () => ({ load: loadMock }));
// `platform/tauri.ts#isTauri` is re-exported straight from this module, so the
// mock keeps it wired to the same `globalThis.isTauri` flag `setTauriFlag`
// below toggles, rather than a real IPC-backed `isTauri()`.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: () => Boolean((globalThis as { isTauri?: boolean }).isTauri),
}));

import { LocalNotesStore, LocalPathError, assertSafeRelPath, extractTitle } from "./localStore";

interface FakeStore {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
}

function makeFakeStore(initial: Record<string, unknown> = {}): FakeStore {
  const data: Record<string, unknown> = { ...initial };
  return {
    get: vi.fn(async (key: string) => data[key]),
    set: vi.fn(async (key: string, value: unknown) => {
      data[key] = value;
    }),
    save: vi.fn(async () => undefined),
  };
}

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

describe("LocalNotesStore in the browser (!isTauri)", () => {
  beforeEach(() => {
    setTauriFlag(undefined);
    vi.clearAllMocks();
  });

  it("no-ops to null/empty/false without calling any tauri API", async () => {
    const store = new LocalNotesStore();

    await expect(store.pickFolder()).resolves.toBeNull();
    await expect(store.getFolder()).resolves.toBeNull();
    await expect(store.listLocal()).resolves.toEqual([]);
    await expect(store.readLocal("a.md")).resolves.toBe("");
    await expect(store.writeLocal("a.md", "x")).resolves.toBeUndefined();
    await expect(store.deleteLocal("a.md")).resolves.toBe(false);

    expect(dialogOpenMock).not.toHaveBeenCalled();
    expect(loadMock).not.toHaveBeenCalled();
    expect(fsMocks.readDir).not.toHaveBeenCalled();
    expect(fsMocks.readTextFile).not.toHaveBeenCalled();
    expect(fsMocks.writeTextFile).not.toHaveBeenCalled();
    expect(fsMocks.remove).not.toHaveBeenCalled();
    expect(fsMocks.mkdir).not.toHaveBeenCalled();
  });

  it("grantFolderAccess no-ops without invoking the Tauri command", async () => {
    const store = new LocalNotesStore();
    await expect(store.grantFolderAccess("/root")).resolves.toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not crash and does not validate rel on the no-op path", async () => {
    const store = new LocalNotesStore();
    await expect(store.readLocal("../../etc/passwd")).resolves.toBe("");
    await expect(store.writeLocal("/abs/path.md", "x")).resolves.toBeUndefined();
  });
});

describe("LocalNotesStore in Tauri", () => {
  let fakeStore: FakeStore;

  beforeEach(() => {
    setTauriFlag(true);
    vi.clearAllMocks();
    fakeStore = makeFakeStore();
    loadMock.mockImplementation(async () => fakeStore);
  });

  afterEach(() => {
    setTauriFlag(undefined);
  });

  it("pickFolder opens a directory dialog and persists the choice", async () => {
    dialogOpenMock.mockResolvedValueOnce("/Users/j/notes");
    const store = new LocalNotesStore();

    const path = await store.pickFolder();

    expect(path).toBe("/Users/j/notes");
    expect(dialogOpenMock).toHaveBeenCalledWith({ directory: true, multiple: false });
    expect(fakeStore.set).toHaveBeenCalledWith("folderPath", "/Users/j/notes");
    expect(fakeStore.save).toHaveBeenCalled();
    expect(await store.getFolder()).toBe("/Users/j/notes");
  });

  it("pickFolder returns null and does not persist when the user cancels", async () => {
    dialogOpenMock.mockResolvedValueOnce(null);
    const store = new LocalNotesStore();

    expect(await store.pickFolder()).toBeNull();
    expect(fakeStore.set).not.toHaveBeenCalled();
  });

  it("getFolder reads the persisted path back from the tauri store", async () => {
    fakeStore = makeFakeStore({ folderPath: "/persisted/path" });
    loadMock.mockImplementation(async () => fakeStore);
    const store = new LocalNotesStore();

    expect(await store.getFolder()).toBe("/persisted/path");
  });

  it("listLocal recursively lists .md files with parsed titles, skipping dotfiles/dirs", async () => {
    fakeStore = makeFakeStore({ folderPath: "/root" });
    loadMock.mockImplementation(async () => fakeStore);
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

    const store = new LocalNotesStore();
    const notes = await store.listLocal();

    expect(notes).toEqual([
      { path: "a.md", title: "Note A" },
      { path: "sub/b.md", title: null },
    ]);
    expect(fsMocks.readDir).not.toHaveBeenCalledWith("/root/.git");
    expect(fsMocks.readTextFile).not.toHaveBeenCalledWith("/root/notes.txt");
  });

  it("listLocal skips a file that fails to read (title: null) instead of aborting the whole listing", async () => {
    fakeStore = makeFakeStore({ folderPath: "/root" });
    loadMock.mockImplementation(async () => fakeStore);
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

    const store = new LocalNotesStore();
    const notes = await store.listLocal();

    expect(notes).toEqual([
      { path: "a.md", title: "A" },
      { path: "broken.md", title: null },
      { path: "c.md", title: "C" },
    ]);
  });

  it("listLocal returns [] when no folder is configured", async () => {
    const store = new LocalNotesStore();
    expect(await store.listLocal()).toEqual([]);
    expect(fsMocks.readDir).not.toHaveBeenCalled();
  });

  it("readLocal reads the file at root + rel", async () => {
    fakeStore = makeFakeStore({ folderPath: "/root" });
    loadMock.mockImplementation(async () => fakeStore);
    fsMocks.readTextFile.mockResolvedValueOnce("hello");
    const store = new LocalNotesStore();

    expect(await store.readLocal("sub/note.md")).toBe("hello");
    expect(fsMocks.readTextFile).toHaveBeenCalledWith("/root/sub/note.md");
  });

  it("readLocal rejects an unsafe rel path without touching the filesystem", async () => {
    fakeStore = makeFakeStore({ folderPath: "/root" });
    loadMock.mockImplementation(async () => fakeStore);
    const store = new LocalNotesStore();

    await expect(store.readLocal("../secret.md")).rejects.toThrow(LocalPathError);
    expect(fsMocks.readTextFile).not.toHaveBeenCalled();
  });

  it("readLocal throws when no folder is configured", async () => {
    const store = new LocalNotesStore();
    await expect(store.readLocal("a.md")).rejects.toThrow(LocalPathError);
  });

  it("writeLocal mkdir -p's the parent directory before writing", async () => {
    fakeStore = makeFakeStore({ folderPath: "/root" });
    loadMock.mockImplementation(async () => fakeStore);
    const store = new LocalNotesStore();

    await store.writeLocal("sub/dir/note.md", "content");

    expect(fsMocks.mkdir).toHaveBeenCalledWith("/root/sub/dir", { recursive: true });
    expect(fsMocks.writeTextFile).toHaveBeenCalledWith("/root/sub/dir/note.md", "content");
  });

  it("writeLocal at the root skips mkdir (no parent directory)", async () => {
    fakeStore = makeFakeStore({ folderPath: "/root" });
    loadMock.mockImplementation(async () => fakeStore);
    const store = new LocalNotesStore();

    await store.writeLocal("note.md", "content");

    expect(fsMocks.mkdir).not.toHaveBeenCalled();
    expect(fsMocks.writeTextFile).toHaveBeenCalledWith("/root/note.md", "content");
  });

  it("writeLocal rejects an unsafe rel path without touching the filesystem", async () => {
    fakeStore = makeFakeStore({ folderPath: "/root" });
    loadMock.mockImplementation(async () => fakeStore);
    const store = new LocalNotesStore();

    await expect(store.writeLocal("/abs.md", "x")).rejects.toThrow(LocalPathError);
    expect(fsMocks.mkdir).not.toHaveBeenCalled();
    expect(fsMocks.writeTextFile).not.toHaveBeenCalled();
  });

  it("deleteLocal removes the file and returns true", async () => {
    fakeStore = makeFakeStore({ folderPath: "/root" });
    loadMock.mockImplementation(async () => fakeStore);
    fsMocks.remove.mockResolvedValueOnce(undefined);
    const store = new LocalNotesStore();

    expect(await store.deleteLocal("note.md")).toBe(true);
    expect(fsMocks.remove).toHaveBeenCalledWith("/root/note.md");
  });

  it("deleteLocal returns false when the underlying remove fails", async () => {
    fakeStore = makeFakeStore({ folderPath: "/root" });
    loadMock.mockImplementation(async () => fakeStore);
    fsMocks.remove.mockRejectedValueOnce(new Error("not found"));
    const store = new LocalNotesStore();

    expect(await store.deleteLocal("gone.md")).toBe(false);
  });

  it("deleteLocal returns false when no folder is configured", async () => {
    const store = new LocalNotesStore();
    expect(await store.deleteLocal("note.md")).toBe(false);
    expect(fsMocks.remove).not.toHaveBeenCalled();
  });

  it("grantFolderAccess invokes the allow_local_notes_folder Rust command with the path", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const store = new LocalNotesStore();

    await store.grantFolderAccess("/Users/j/notes");

    expect(invokeMock).toHaveBeenCalledWith("allow_local_notes_folder", { path: "/Users/j/notes" });
  });
});
