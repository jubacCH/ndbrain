import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/useAuth";
import { AppRoot } from "./AppRoot";

// Same fake-plugin convention as `local/localStore.test.ts`: the local-notes
// store this integration test exercises (via the real `<LocalNotesView>`,
// mounted through the "Local" nav button) is backed by the real Tauri v2
// `fs`/`dialog`/`store` plugins, which don't exist in jsdom — mock them so
// `getFolder()`/`listLocal()` resolve instead of throwing against a missing
// IPC bridge.
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
// `platform/tauri.ts#isTauri` re-exports straight from this module — keep it
// wired to the same `globalThis.isTauri` flag `setTauriFlag` toggles, and
// stub `invoke` (used by `LocalNotesStore.grantFolderAccess`) so it never
// attempts a real IPC call against jsdom's missing Tauri bridge.
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

function routedFetch() {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = new URL(url, "http://localhost").pathname;
    const method = (init?.method ?? "GET").toUpperCase();

    if (path === "/api/v1/notes") return Promise.resolve(jsonResponse(200, { notes: [] }));
    if (path === "/api/v1/graph") return Promise.resolve(jsonResponse(200, { nodes: [], edges: [] }));
    if (path === "/api/v1/keys" && method === "GET") return Promise.resolve(jsonResponse(200, { keys: [] }));
    if (path === "/api/v1/audit") return Promise.resolve(jsonResponse(200, { entries: [] }));

    return Promise.resolve(jsonResponse(404, { error: { code: "not_found", message: "unmapped" } }));
  });
}

describe("AppRoot local-notes wiring", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setTauriFlag(undefined);
    vi.clearAllMocks();
  });

  it("does not render a Local nav button outside of Tauri (browser stays unchanged)", async () => {
    vi.stubGlobal("fetch", routedFetch());
    render(
      <AuthProvider>
        <AppRoot />
      </AuthProvider>,
    );
    await screen.findByText("ndBrain");

    expect(screen.queryByRole("button", { name: "Local" })).not.toBeInTheDocument();
  });

  it("shows a Local nav button in Tauri, and opens LocalNotesView in the main slot", async () => {
    setTauriFlag(true);
    loadMock.mockResolvedValue({ get: vi.fn(async () => undefined), set: vi.fn(), save: vi.fn() });
    vi.stubGlobal("fetch", routedFetch());
    render(
      <AuthProvider>
        <AppRoot />
      </AuthProvider>,
    );
    await screen.findByText("ndBrain");

    fireEvent.click(screen.getByRole("button", { name: "Local" }));

    expect(await screen.findByRole("button", { name: /choose folder/i })).toBeInTheDocument();
    // The note editor's placeholder from the normal main slot must be gone —
    // Local and the editor share one mutually-exclusive main slot.
    expect(screen.queryByText("Select a note to start editing.")).not.toBeInTheDocument();
  });

  it("toggling Settings closes an open Local panel, and vice versa", async () => {
    setTauriFlag(true);
    loadMock.mockResolvedValue({ get: vi.fn(async () => undefined), set: vi.fn(), save: vi.fn() });
    vi.stubGlobal("fetch", routedFetch());
    render(
      <AuthProvider>
        <AppRoot />
      </AuthProvider>,
    );
    await screen.findByText("ndBrain");

    fireEvent.click(screen.getByRole("button", { name: "Local" }));
    await screen.findByRole("button", { name: /choose folder/i });

    fireEvent.click(screen.getByText("Settings"));
    expect(await screen.findByText("No API keys yet.")).toBeInTheDocument();
  });
});
