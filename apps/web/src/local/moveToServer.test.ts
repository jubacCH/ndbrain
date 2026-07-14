import { describe, expect, it, vi } from "vitest";
import { moveToServer } from "./moveToServer";

describe("moveToServer", () => {
  it("reads the local note, PUTs it to the server at the same path, then deletes the local copy — in that order", async () => {
    const calls: string[] = [];
    const store = {
      readLocal: vi.fn(async (rel: string) => {
        calls.push(`read:${rel}`);
        return "# Note\nbody";
      }),
      deleteLocal: vi.fn(async (rel: string) => {
        calls.push(`delete:${rel}`);
        return true;
      }),
    };
    const client = {
      putNote: vi.fn(async (path: string, content: string) => {
        calls.push(`put:${path}:${content}`);
      }),
    };

    const result = await moveToServer("sub/note.md", { store, client });

    expect(calls).toEqual(["read:sub/note.md", "put:sub/note.md:# Note\nbody", "delete:sub/note.md"]);
    expect(result).toEqual({ path: "sub/note.md", localDeleted: true });
  });

  it("does not delete the local copy when the PUT fails, and propagates the error", async () => {
    const store = {
      readLocal: vi.fn(async () => "content"),
      deleteLocal: vi.fn(async () => true),
    };
    const client = {
      putNote: vi.fn(async () => {
        throw new Error("network error");
      }),
    };

    await expect(moveToServer("note.md", { store, client })).rejects.toThrow("network error");
    expect(store.deleteLocal).not.toHaveBeenCalled();
  });

  it("propagates a readLocal failure without calling putNote or deleteLocal", async () => {
    const store = {
      readLocal: vi.fn(async () => {
        throw new Error("no local notes folder configured");
      }),
      deleteLocal: vi.fn(async () => true),
    };
    const client = { putNote: vi.fn(async () => {}) };

    await expect(moveToServer("note.md", { store, client })).rejects.toThrow(
      "no local notes folder configured",
    );
    expect(client.putNote).not.toHaveBeenCalled();
    expect(store.deleteLocal).not.toHaveBeenCalled();
  });

  it("resolves with localDeleted:false (without throwing) when the PUT succeeds but the local delete does not", async () => {
    const store = {
      readLocal: vi.fn(async () => "content"),
      deleteLocal: vi.fn(async () => false),
    };
    const client = { putNote: vi.fn(async () => {}) };

    const result = await moveToServer("note.md", { store, client });

    expect(result).toEqual({ path: "note.md", localDeleted: false });
  });

  it("uses the shared localNotesStore/apiClient singletons by default", async () => {
    const { localNotesStore } = await import("./localStore");
    const { apiClient } = await import("../api/client");
    const readSpy = vi.spyOn(localNotesStore, "readLocal").mockResolvedValue("content");
    const deleteSpy = vi.spyOn(localNotesStore, "deleteLocal").mockResolvedValue(true);
    const putSpy = vi.spyOn(apiClient, "putNote").mockResolvedValue(undefined);

    const result = await moveToServer("note.md");

    expect(readSpy).toHaveBeenCalledWith("note.md");
    expect(putSpy).toHaveBeenCalledWith("note.md", "content");
    expect(deleteSpy).toHaveBeenCalledWith("note.md");
    expect(result).toEqual({ path: "note.md", localDeleted: true });

    readSpy.mockRestore();
    deleteSpy.mockRestore();
    putSpy.mockRestore();
  });
});
