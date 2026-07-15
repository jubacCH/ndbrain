import { describe, expect, it, vi } from "vitest";

// `@tauri-apps/plugin-dialog`'s ESM export namespace isn't configurable, so
// `vi.spyOn` on the real module throws ("Cannot redefine property") — use
// `vi.mock`/`vi.hoisted` instead, same convention as `localStore.test.ts` /
// `AppRoot.local.test.tsx`. Only exercised by the "defaults confirmOverwrite
// to the native dialog" test below; every other test injects its own
// `confirmOverwrite`.
const { dialogConfirmMock } = vi.hoisted(() => ({ dialogConfirmMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: dialogConfirmMock }));

import { ApiError } from "../api/client";
import { MoveAbortedError, moveToServer } from "./moveToServer";

/** A client double whose `getNote` always 404s — the common case in these
 *  tests where the existence check should report "no conflict" and get out
 *  of the way without the caller needing to reason about it. */
function noConflictClient(putNote: (path: string, content: string) => Promise<void>) {
  return {
    getNote: vi.fn(async (path: string) => {
      throw new ApiError(404, "not_found", path);
    }),
    putNote: vi.fn(putNote),
  };
}

describe("moveToServer", () => {
  it("reads the local note, checks for a server conflict, PUTs it to the server at the same path, then deletes the local copy — in that order", async () => {
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
      getNote: vi.fn(async (rel: string) => {
        calls.push(`getNote:${rel}`);
        throw new ApiError(404, "not_found", rel);
      }),
      putNote: vi.fn(async (path: string, content: string) => {
        calls.push(`put:${path}:${content}`);
      }),
    };

    const result = await moveToServer("sub/note.md", { store, client });

    expect(calls).toEqual([
      "read:sub/note.md",
      "getNote:sub/note.md",
      "put:sub/note.md:# Note\nbody",
      "delete:sub/note.md",
    ]);
    expect(result).toEqual({ path: "sub/note.md", localDeleted: true });
  });

  it("does not delete the local copy when the PUT fails, and propagates the error", async () => {
    const store = {
      readLocal: vi.fn(async () => "content"),
      deleteLocal: vi.fn(async () => true),
    };
    const client = noConflictClient(async () => {
      throw new Error("network error");
    });

    await expect(moveToServer("note.md", { store, client })).rejects.toThrow("network error");
    expect(store.deleteLocal).not.toHaveBeenCalled();
  });

  it("propagates a readLocal failure without calling getNote, putNote or deleteLocal", async () => {
    const store = {
      readLocal: vi.fn(async () => {
        throw new Error("no local notes folder configured");
      }),
      deleteLocal: vi.fn(async () => true),
    };
    const client = noConflictClient(async () => {});

    await expect(moveToServer("note.md", { store, client })).rejects.toThrow(
      "no local notes folder configured",
    );
    expect(client.getNote).not.toHaveBeenCalled();
    expect(client.putNote).not.toHaveBeenCalled();
    expect(store.deleteLocal).not.toHaveBeenCalled();
  });

  it("resolves with localDeleted:false (without throwing) when the PUT succeeds but the local delete does not", async () => {
    const store = {
      readLocal: vi.fn(async () => "content"),
      deleteLocal: vi.fn(async () => false),
    };
    const client = noConflictClient(async () => {});

    const result = await moveToServer("note.md", { store, client });

    expect(result).toEqual({ path: "note.md", localDeleted: false });
  });

  it("uses the shared localNotesStore/apiClient singletons by default", async () => {
    const { localNotesStore } = await import("./localStore");
    const { apiClient } = await import("../api/client");
    const readSpy = vi.spyOn(localNotesStore, "readLocal").mockResolvedValue("content");
    const deleteSpy = vi.spyOn(localNotesStore, "deleteLocal").mockResolvedValue(true);
    const getNoteSpy = vi.spyOn(apiClient, "getNote").mockRejectedValue(new ApiError(404, "not_found", "note.md"));
    const putSpy = vi.spyOn(apiClient, "putNote").mockResolvedValue(undefined);

    const result = await moveToServer("note.md");

    expect(readSpy).toHaveBeenCalledWith("note.md");
    expect(getNoteSpy).toHaveBeenCalledWith("note.md");
    expect(putSpy).toHaveBeenCalledWith("note.md", "content");
    expect(deleteSpy).toHaveBeenCalledWith("note.md");
    expect(result).toEqual({ path: "note.md", localDeleted: true });

    readSpy.mockRestore();
    getNoteSpy.mockRestore();
    deleteSpy.mockRestore();
    putSpy.mockRestore();
  });

  describe("when a server note already exists at the target path", () => {
    function conflictingClient(putNote: (path: string, content: string) => Promise<void> = async () => {}) {
      return {
        getNote: vi.fn(async (path: string) => ({ path, content: "existing server content" })),
        putNote: vi.fn(putNote),
      };
    }

    it("asks for a separate overwrite confirmation before PUTting, and proceeds when accepted", async () => {
      const calls: string[] = [];
      const store = {
        readLocal: vi.fn(async () => "local content"),
        deleteLocal: vi.fn(async () => {
          calls.push("delete");
          return true;
        }),
      };
      const client = {
        getNote: vi.fn(async () => ({ path: "note.md", content: "existing" })),
        putNote: vi.fn(async () => {
          calls.push("put");
        }),
      };
      const confirmOverwrite = vi.fn(async (message: string) => {
        calls.push(`confirm:${message}`);
        return true;
      });

      const result = await moveToServer("note.md", { store, client, confirmOverwrite });

      expect(confirmOverwrite).toHaveBeenCalledTimes(1);
      expect(confirmOverwrite.mock.calls[0][0]).toContain("note.md");
      expect(calls[0]).toMatch(/^confirm:/);
      expect(calls.slice(1)).toEqual(["put", "delete"]);
      expect(result).toEqual({ path: "note.md", localDeleted: true });
    });

    it("does not PUT or delete, and throws MoveAbortedError, when the overwrite confirmation is declined", async () => {
      const store = {
        readLocal: vi.fn(async () => "local content"),
        deleteLocal: vi.fn(async () => true),
      };
      const client = conflictingClient();
      const confirmOverwrite = vi.fn(async () => false);

      await expect(moveToServer("note.md", { store, client, confirmOverwrite })).rejects.toThrow(
        MoveAbortedError,
      );

      expect(client.putNote).not.toHaveBeenCalled();
      expect(store.deleteLocal).not.toHaveBeenCalled();
    });

    it("does not ask for an overwrite confirmation when no server note exists", async () => {
      const store = {
        readLocal: vi.fn(async () => "content"),
        deleteLocal: vi.fn(async () => true),
      };
      const client = noConflictClient(async () => {});
      const confirmOverwrite = vi.fn(async () => true);

      await moveToServer("note.md", { store, client, confirmOverwrite });

      expect(confirmOverwrite).not.toHaveBeenCalled();
    });

    it("propagates a non-404 existence-check failure without PUTting or deleting", async () => {
      const store = {
        readLocal: vi.fn(async () => "content"),
        deleteLocal: vi.fn(async () => true),
      };
      const client = {
        getNote: vi.fn(async () => {
          throw new Error("network unreachable");
        }),
        putNote: vi.fn(async () => {}),
      };

      await expect(moveToServer("note.md", { store, client })).rejects.toThrow("network unreachable");
      expect(client.putNote).not.toHaveBeenCalled();
      expect(store.deleteLocal).not.toHaveBeenCalled();
    });

    it("defaults confirmOverwrite to the native dialog's confirm() when a conflict exists", async () => {
      dialogConfirmMock.mockReset().mockResolvedValue(true);
      const store = {
        readLocal: vi.fn(async () => "content"),
        deleteLocal: vi.fn(async () => true),
      };
      const client = conflictingClient();

      await moveToServer("note.md", { store, client });

      expect(dialogConfirmMock).toHaveBeenCalledTimes(1);
      expect(dialogConfirmMock.mock.calls[0][0]).toContain("note.md");
    });
  });
});
