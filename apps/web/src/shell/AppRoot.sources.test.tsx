import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/useAuth";
import { addFolderSource, addServerSource } from "../sources/registry";
import { SourcesProvider } from "../sources/SourcesProvider";
import { AppRoot } from "./AppRoot";

// Same fake-plugin convention as `sources/SourcesProvider.test.tsx`: the real
// Tauri v2 `fs`/`dialog` plugins don't exist in jsdom, so mock them and drive
// `isTauri()` off a `globalThis.isTauri` flag.
const { fsMocks, invokeMock } = vi.hoisted(() => ({
  fsMocks: {
    mkdir: vi.fn(),
    readDir: vi.fn(),
    readTextFile: vi.fn(),
    remove: vi.fn(),
    writeTextFile: vi.fn(),
  },
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => fsMocks);
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

function renderApp() {
  return render(
    <SourcesProvider>
      <AuthProvider>
        <AppRoot />
      </AuthProvider>
    </SourcesProvider>,
  );
}

describe("AppRoot sidebar composition", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setTauriFlag(undefined);
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("browser (exactly one implicit source): no section header appears in the sidebar", async () => {
    vi.stubGlobal("fetch", routedFetch());
    renderApp();
    await screen.findByText("ndBrain");

    // The implicit browser source is labeled "Server" (see `SourcesProvider`'s
    // `ORIGIN_SOURCE`) - with a single source, that label must never appear as
    // a section header (the hard no-regression requirement).
    expect(screen.queryByText("Server")).not.toBeInTheDocument();
    expect(screen.getByText("+ New note")).toBeInTheDocument();
  });

  it("Tauri, two sources: renders one section per source in registry order, with headers and a device marker", async () => {
    setTauriFlag(true);
    addServerSource("Alpha", "https://alpha.example.com");
    addFolderSource("My Laptop", "/Users/j/notes");
    fsMocks.readDir.mockResolvedValue([]);
    vi.stubGlobal("fetch", routedFetch());

    renderApp();
    await screen.findByText("ndBrain");

    const alphaSection = await screen.findByRole("region", { name: "Alpha" });
    const folderSection = screen.getByRole("region", { name: "My Laptop" });

    // Registry order: Alpha (added first) must precede the folder section in
    // the DOM.
    expect(
      alphaSection.compareDocumentPosition(folderSection) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(within(folderSection).getByText(/device/i)).toBeInTheDocument();
    expect(within(alphaSection).queryByText(/device/i)).not.toBeInTheDocument();
  });

  it("Tauri, folder source: creating a note calls the fs plugin only, never fetch", async () => {
    setTauriFlag(true);
    addFolderSource("My Laptop", "/Users/j/notes");
    fsMocks.readDir.mockResolvedValue([]);
    fsMocks.writeTextFile.mockResolvedValue(undefined);
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    renderApp();
    await screen.findByText("ndBrain");
    const folderSection = await screen.findByRole("region", { name: "My Laptop" });
    await within(folderSection).findByText(/no notes yet/i);

    const fetchCallsBefore = fetchMock.mock.calls.length;

    fireEvent.click(within(folderSection).getByText("+ New note"));
    const input = within(folderSection).getByRole("textbox", { name: /path/i });
    fireEvent.change(input, { target: { value: "new-note.md" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(fsMocks.writeTextFile).toHaveBeenCalledWith(
        expect.stringContaining("new-note.md"),
        "# new-note\n",
      ),
    );
    expect(fetchMock.mock.calls.length).toBe(fetchCallsBefore);
  });
});
