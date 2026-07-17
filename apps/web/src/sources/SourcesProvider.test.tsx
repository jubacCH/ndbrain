import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addFolderSource, addServerSource } from "./registry";
import { SourcesProvider } from "./SourcesProvider";
import { useSources } from "./useSources";

// Same fake-plugin convention as `shell/AppRoot.local.test.tsx` /
// `local/localStore.test.ts`: the real Tauri v2 `fs`/`dialog`/`store` plugins
// don't exist in jsdom, so mock them and drive `isTauri()` off a
// `globalThis.isTauri` flag rather than the real (missing) IPC bridge.
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
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: () => Boolean((globalThis as { isTauri?: boolean }).isTauri),
}));

function setTauriFlag(value: boolean | undefined) {
  if (value === undefined) {
    delete (globalThis as { isTauri?: boolean }).isTauri;
    return;
  }
  (globalThis as { isTauri?: boolean }).isTauri = value;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Routes `fetch` by origin + path so several server sources (each a
 *  different base URL) can be probed independently within one test.
 *  `notesStatus` overrides the status `GET /notes` replies with for a given
 *  origin (default 200); login always succeeds unless the password is
 *  literally `"wrong"`. Relative URLs (the browser's `url: ""` source)
 *  resolve against `http://localhost`, same as `AppRoot.local.test.tsx`. */
function routedFetch(notesStatus: Record<string, number> = {}): ReturnType<typeof vi.fn> {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = new URL(url, "http://localhost");
    const origin = parsed.origin;
    const path = parsed.pathname;
    const method = (init?.method ?? "GET").toUpperCase();

    if (path === "/api/v1/notes" && method === "GET") {
      const status = notesStatus[origin] ?? 200;
      if (status === 401) {
        return Promise.resolve(jsonResponse(401, { error: { code: "unauthorized", message: "no session" } }));
      }
      return Promise.resolve(jsonResponse(status, { notes: [] }));
    }
    if (path === "/api/v1/auth/login" && method === "POST") {
      const body = init?.body ? (JSON.parse(init.body as string) as { password?: string }) : {};
      if (body.password === "wrong") {
        return Promise.resolve(jsonResponse(401, { error: { code: "bad_credentials", message: "nope" } }));
      }
      return Promise.resolve(jsonResponse(200, { token: "tok" }));
    }
    if (path === "/api/v1/auth/logout" && method === "POST") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(jsonResponse(404, { error: { code: "not_found", message: "unmapped" } }));
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setTauriFlag(undefined);
  vi.clearAllMocks();
});

describe("SourcesProvider in the browser (!isTauri)", () => {
  it("exposes exactly one implicit origin source and never touches the registry", async () => {
    vi.stubGlobal("fetch", routedFetch());
    const { result } = renderHook(() => useSources(), { wrapper: SourcesProvider });

    expect(result.current.sources).toHaveLength(1);
    expect(result.current.sources[0].def).toEqual({ id: "origin", kind: "server", label: "Server", url: "" });
    expect(localStorage.getItem("ndbrain.sources")).toBeNull();
  });

  it("addServer and addFolder are no-ops: no new runtime, nothing persisted", async () => {
    vi.stubGlobal("fetch", routedFetch());
    const { result } = renderHook(() => useSources(), { wrapper: SourcesProvider });

    await act(async () => {
      await result.current.addServer("New", "https://x.example.com", "u", "p");
      await result.current.addFolder("New folder", "/tmp/notes");
    });

    expect(result.current.sources).toHaveLength(1);
    expect(result.current.sources[0].def.id).toBe("origin");
    expect(localStorage.getItem("ndbrain.sources")).toBeNull();
  });
});

describe("SourcesProvider in Tauri", () => {
  it("builds one runtime per registered source, each with its own client/store", async () => {
    setTauriFlag(true);
    addServerSource("Alpha", "https://alpha.example.com");
    addServerSource("Beta", "https://beta.example.com");
    addFolderSource("Notes", "/Users/j/notes");
    vi.stubGlobal("fetch", routedFetch());

    const { result } = renderHook(() => useSources(), { wrapper: SourcesProvider });

    await waitFor(() => {
      expect(result.current.sources.every((s) => s.state !== "connecting")).toBe(true);
    });

    expect(result.current.sources).toHaveLength(3);
    const [alpha, beta, notes] = result.current.sources;
    expect(alpha.kind).toBe("server");
    expect(beta.kind).toBe("server");
    expect(notes.kind).toBe("folder");
    if (alpha.kind === "server" && beta.kind === "server") {
      expect(alpha.client).not.toBe(beta.client);
    }
    expect(alpha.state).toBe("connected");
    expect(beta.state).toBe("connected");
    expect(notes.state).toBe("connected");
  });

  it("maps probe results: 200 -> connected, 401 -> needs-login, network error -> unreachable", async () => {
    setTauriFlag(true);
    addServerSource("Ok", "https://ok.example.com");
    addServerSource("Denied", "https://denied.example.com");
    addServerSource("Down", "https://down.example.com");
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.origin === "https://down.example.com") return Promise.reject(new Error("network down"));
      if (url.origin === "https://denied.example.com") {
        return Promise.resolve(jsonResponse(401, { error: { code: "unauthorized", message: "no session" } }));
      }
      return Promise.resolve(jsonResponse(200, { notes: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSources(), { wrapper: SourcesProvider });

    await waitFor(() => {
      const byLabel = Object.fromEntries(result.current.sources.map((s) => [s.def.label, s.state]));
      expect(byLabel).toEqual({ Ok: "connected", Denied: "needs-login", Down: "unreachable" });
    });
  });

  it("auth isolation: a 401 on source A flips only A to needs-login, B stays connected", async () => {
    setTauriFlag(true);
    addServerSource("A", "https://a.example.com");
    addServerSource("B", "https://b.example.com");
    vi.stubGlobal("fetch", routedFetch());

    const { result } = renderHook(() => useSources(), { wrapper: SourcesProvider });
    await waitFor(() => {
      expect(result.current.sources.map((s) => s.state)).toEqual(["connected", "connected"]);
    });

    const sourceA = result.current.sources.find((s) => s.def.label === "A");
    if (!sourceA || sourceA.kind !== "server") throw new Error("expected server source A");

    // A later 401 against A alone (B's origin keeps replying 200) must fire
    // only A's own `setUnauthorizedHandler` callback.
    vi.stubGlobal("fetch", routedFetch({ "https://a.example.com": 401 }));
    await act(async () => {
      await expect(sourceA.client.listNotes()).rejects.toThrow();
    });

    await waitFor(() => {
      const byLabel = Object.fromEntries(result.current.sources.map((s) => [s.def.label, s.state]));
      expect(byLabel.A).toBe("needs-login");
      expect(byLabel.B).toBe("connected");
    });

    await act(async () => {
      await result.current.logout(sourceA.def.id);
    });

    const byLabelAfterLogout = Object.fromEntries(result.current.sources.map((s) => [s.def.label, s.state]));
    expect(byLabelAfterLogout.A).toBe("needs-login");
    expect(byLabelAfterLogout.B).toBe("connected");
  });

  it("login(id) flips only that source back to connected", async () => {
    setTauriFlag(true);
    addServerSource("A", "https://a.example.com");
    addServerSource("B", "https://b.example.com");
    vi.stubGlobal("fetch", routedFetch({ "https://a.example.com": 401 }));

    const { result } = renderHook(() => useSources(), { wrapper: SourcesProvider });
    await waitFor(() => {
      const byLabel = Object.fromEntries(result.current.sources.map((s) => [s.def.label, s.state]));
      expect(byLabel).toEqual({ A: "needs-login", B: "connected" });
    });

    const sourceA = result.current.sources.find((s) => s.def.label === "A")!;
    vi.stubGlobal("fetch", routedFetch());
    await act(async () => {
      await result.current.login(sourceA.def.id, "user", "correct");
    });

    const byLabel = Object.fromEntries(result.current.sources.map((s) => [s.def.label, s.state]));
    expect(byLabel).toEqual({ A: "connected", B: "connected" });
  });

  it("retry(id) re-probes a single source", async () => {
    setTauriFlag(true);
    addServerSource("Flaky", "https://flaky.example.com");
    const fetchMock = vi.fn(() => Promise.reject(new Error("down")));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSources(), { wrapper: SourcesProvider });
    await waitFor(() => expect(result.current.sources[0].state).toBe("unreachable"));

    vi.stubGlobal("fetch", routedFetch());
    act(() => {
      result.current.retry(result.current.sources[0].def.id);
    });

    await waitFor(() => expect(result.current.sources[0].state).toBe("connected"));
  });

  it("addServer propagates a login failure and persists/adds nothing", async () => {
    setTauriFlag(true);
    vi.stubGlobal("fetch", routedFetch());
    const { result } = renderHook(() => useSources(), { wrapper: SourcesProvider });
    await waitFor(() => expect(result.current.sources).toHaveLength(0));

    await act(async () => {
      await expect(
        result.current.addServer("Bad", "https://bad.example.com", "user", "wrong"),
      ).rejects.toThrow();
    });

    expect(result.current.sources).toHaveLength(0);
    expect(localStorage.getItem("ndbrain.sources")).toBeNull();
  });

  it("addServer succeeds only after a successful login, then persists and adds a runtime", async () => {
    setTauriFlag(true);
    vi.stubGlobal("fetch", routedFetch());
    const { result } = renderHook(() => useSources(), { wrapper: SourcesProvider });
    await waitFor(() => expect(result.current.sources).toHaveLength(0));

    await act(async () => {
      await result.current.addServer("Good", "https://good.example.com", "user", "correct");
    });

    expect(result.current.sources).toHaveLength(1);
    expect(result.current.sources[0].def.url).toBe("https://good.example.com");
    expect(result.current.sources[0].state).toBe("connected");
    expect(localStorage.getItem("ndbrain.sources")).not.toBeNull();
  });

  it("addFolder grants folder access on add; restoring an existing folder source re-grants it on mount", async () => {
    setTauriFlag(true);
    addFolderSource("Existing", "/Users/j/existing");
    vi.stubGlobal("fetch", routedFetch());

    const { result } = renderHook(() => useSources(), { wrapper: SourcesProvider });
    await waitFor(() => expect(result.current.sources).toHaveLength(1));
    expect(invokeMock).toHaveBeenCalledWith("allow_local_notes_folder", { path: "/Users/j/existing" });

    invokeMock.mockClear();
    await act(async () => {
      await result.current.addFolder("New", "/Users/j/new");
    });
    expect(invokeMock).toHaveBeenCalledWith("allow_local_notes_folder", { path: "/Users/j/new" });
    expect(result.current.sources).toHaveLength(2);
  });

  it("isolation: a folder-only source never triggers a fetch", async () => {
    setTauriFlag(true);
    addFolderSource("OnlyFolder", "/Users/j/only");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSources(), { wrapper: SourcesProvider });
    await waitFor(() => expect(result.current.sources).toHaveLength(1));
    expect(result.current.sources[0].state).toBe("connected");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("remove clears the runtime and the source's unauthorized handler (no leak)", async () => {
    setTauriFlag(true);
    addServerSource("Gone", "https://gone.example.com");
    vi.stubGlobal("fetch", routedFetch());

    const { result } = renderHook(() => useSources(), { wrapper: SourcesProvider });
    await waitFor(() => expect(result.current.sources[0]?.state).toBe("connected"));
    const source = result.current.sources[0];
    if (source.kind !== "server") throw new Error("expected server source");
    const setHandlerSpy = vi.spyOn(source.client, "setUnauthorizedHandler");

    act(() => {
      result.current.remove(source.def.id);
    });

    expect(setHandlerSpy).toHaveBeenCalledWith(null);
    expect(result.current.sources).toHaveLength(0);
  });

  it("rename updates the source's label in place", async () => {
    setTauriFlag(true);
    addServerSource("Old", "https://old.example.com");
    vi.stubGlobal("fetch", routedFetch());

    const { result } = renderHook(() => useSources(), { wrapper: SourcesProvider });
    await waitFor(() => expect(result.current.sources[0]?.state).toBe("connected"));

    act(() => {
      result.current.rename(result.current.sources[0].def.id, "Renamed");
    });

    expect(result.current.sources[0].def.label).toBe("Renamed");
  });
});
