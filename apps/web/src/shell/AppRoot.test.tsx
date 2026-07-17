import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/useAuth";
import { SourcesProvider } from "../sources/SourcesProvider";
import { AppRoot } from "./AppRoot";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Routes each request by method + pathname to a canned body, mirroring the real
 *  @ndbrain/server REST surface. `AppRoot`'s subcomponents all use the default
 *  (real) `apiClient` — same convention as the existing `App.test.tsx` — so an
 *  assembly-level test drives them through `fetch` rather than injecting a fake
 *  client into every child. Never renders `<Editor>` against a selected note:
 *  that would construct a real `HocuspocusProvider`/WebSocket, which is out of
 *  scope here (covered by `Editor.test.tsx`'s fake-provider seam instead). */
function routedFetch(opts: { createKeyResponse?: string } = {}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = new URL(url, "http://localhost").pathname;
    const method = (init?.method ?? "GET").toUpperCase();

    if (path === "/api/v1/notes") return Promise.resolve(jsonResponse(200, { notes: [] }));
    if (path === "/api/v1/graph") return Promise.resolve(jsonResponse(200, { nodes: [], edges: [] }));
    if (path === "/api/v1/keys" && method === "GET") return Promise.resolve(jsonResponse(200, { keys: [] }));
    if (path === "/api/v1/keys" && method === "POST") {
      return Promise.resolve(jsonResponse(200, { key: opts.createKeyResponse ?? "ndb_test123" }));
    }
    if (path === "/api/v1/audit") return Promise.resolve(jsonResponse(200, { entries: [] }));

    return Promise.resolve(
      jsonResponse(404, { error: { code: "not_found", message: `unmapped in test: ${method} ${path}` } }),
    );
  });
}

describe("AppRoot", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the search palette from the shell button, via Cmd-K, and closes it on Escape", async () => {
    vi.stubGlobal("fetch", routedFetch());
    render(
      <SourcesProvider>
        <AuthProvider>
          <AppRoot />
        </AuthProvider>
      </SourcesProvider>,
    );
    await screen.findByText("ndBrain");

    fireEvent.click(screen.getByText("Search…"));
    expect(screen.getByRole("dialog", { name: /search palette/i })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog", { name: /search palette/i })).toBeInTheDocument();
  });

  it("shows a tabbed Backlinks/Graph/History right panel and switches between them", async () => {
    vi.stubGlobal("fetch", routedFetch());
    render(
      <SourcesProvider>
        <AuthProvider>
          <AppRoot />
        </AuthProvider>
      </SourcesProvider>,
    );
    await screen.findByText("ndBrain");

    expect(screen.getByRole("tab", { name: "Backlinks" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Backlinks")).toHaveTextContent("No note selected.");

    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    await waitFor(() => expect(screen.getByLabelText("Graph")).toHaveTextContent("No notes yet."));

    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(screen.getByLabelText("History")).toHaveTextContent("No note selected.");
  });

  it("toggles a Settings area (Keys/Audit tabs) from the shell nav, and clears a shown key secret on close", async () => {
    vi.stubGlobal("fetch", routedFetch());
    render(
      <SourcesProvider>
        <AuthProvider>
          <AppRoot />
        </AuthProvider>
      </SourcesProvider>,
    );
    await screen.findByText("ndBrain");

    fireEvent.click(screen.getByText("Settings"));
    await screen.findByText("No API keys yet.");

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "ci-bot" } });
    fireEvent.change(screen.getByLabelText(/namespace/i), { target: { value: "myai/" } });
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    expect(await screen.findByDisplayValue("ndb_test123")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Audit Log" }));
    await screen.findByText("No audit entries yet.");

    // Close Settings (toggle the shell nav button again) and reopen: the secret
    // must be gone even though `SettingsArea` stays mounted the whole time.
    fireEvent.click(screen.getByText("Settings"));
    fireEvent.click(screen.getByText("Settings"));

    expect(screen.queryByDisplayValue("ndb_test123")).not.toBeInTheDocument();
  });

  it("shows the placeholder in the main slot until a note is selected", async () => {
    vi.stubGlobal("fetch", routedFetch());
    render(
      <SourcesProvider>
        <AuthProvider>
          <AppRoot />
        </AuthProvider>
      </SourcesProvider>,
    );
    await screen.findByText("ndBrain");
    expect(screen.getByText("Select a note to start editing.")).toBeInTheDocument();
  });
});
