import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../api/client";
import { AppStateProvider, useAppState } from "../shell/AppState";
import { LocalNotesStore } from "../local/localStore";
import { SourcesContext, type SourcesContextValue } from "../sources/SourcesProvider";
import type { NoteSelection, SourceRuntime } from "../sources/types";
import { BacklinksPanel } from "./BacklinksPanel";

/** Builds a server-kind `SourceRuntime` around a real `ApiClient` with
 *  `backlinks()` mocked directly — `ApiClient` has private fields, so a
 *  structural fake object cannot satisfy `SourceRuntime`'s `client: ApiClient`
 *  (same convention `sources/SourcesProvider.test.tsx` uses). */
function serverRuntime(
  id: string,
  backlinks: (path: string) => Promise<string[]> = vi.fn().mockResolvedValue([]),
): SourceRuntime {
  const client = createApiClient("");
  vi.spyOn(client, "backlinks").mockImplementation(backlinks);
  return { def: { id, kind: "server", label: "Server", url: "" }, state: "connected", kind: "server", client };
}

function folderRuntime(id: string): SourceRuntime {
  return {
    def: { id, kind: "folder", label: "Notes", path: "/tmp/notes" },
    state: "connected",
    kind: "folder",
    store: new LocalNotesStore("/tmp/notes"),
  };
}

function fakeSourcesValue(sources: SourceRuntime[]): SourcesContextValue {
  return {
    sources,
    addServer: vi.fn(),
    addFolder: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    retry: vi.fn(),
  };
}

function Init({ selection }: { selection: NoteSelection | null }) {
  const { setSelection } = useAppState();
  useEffect(() => {
    setSelection(selection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function SelectedPathProbe() {
  const { selection } = useAppState();
  return <div data-testid="selected-path">{selection?.path ?? "none"}</div>;
}

function renderPanel(sources: SourceRuntime[], selection: NoteSelection | null) {
  return render(
    <SourcesContext.Provider value={fakeSourcesValue(sources)}>
      <AppStateProvider>
        <Init selection={selection} />
        <BacklinksPanel />
        <SelectedPathProbe />
      </AppStateProvider>
    </SourcesContext.Provider>,
  );
}

describe("BacklinksPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a placeholder when no note is selected", () => {
    const runtime = serverRuntime("s1");
    renderPanel([runtime], null);

    expect(screen.getByText(/no note selected/i)).toBeInTheDocument();
    expect(runtime.kind === "server" && runtime.client.backlinks).not.toHaveBeenCalled();
  });

  it("shows a loading state while backlinks are being fetched", () => {
    const runtime = serverRuntime("s1", vi.fn(() => new Promise<string[]>(() => {})));
    renderPanel([runtime], { sourceId: "s1", path: "note.md" });

    expect(screen.getByText(/loading backlinks/i)).toBeInTheDocument();
  });

  it("shows an empty state when there are no backlinks", async () => {
    const runtime = serverRuntime("s1", vi.fn().mockResolvedValue([]));
    renderPanel([runtime], { sourceId: "s1", path: "note.md" });

    expect(await screen.findByText(/no backlinks/i)).toBeInTheDocument();
  });

  it("renders the list of backlink source paths", async () => {
    const runtime = serverRuntime("s1", vi.fn().mockResolvedValue(["projects/a.md", "b.md"]));
    renderPanel([runtime], { sourceId: "s1", path: "note.md" });

    expect(await screen.findByText("projects/a.md")).toBeInTheDocument();
    expect(screen.getByText("b.md")).toBeInTheDocument();
  });

  it("clicking a backlink selects it in the same source", async () => {
    const runtime = serverRuntime("s1", vi.fn().mockResolvedValue(["other.md"]));
    renderPanel([runtime], { sourceId: "s1", path: "note.md" });

    const link = await screen.findByText("other.md");
    fireEvent.click(link);

    expect(screen.getByTestId("selected-path")).toHaveTextContent("other.md");
  });

  it("fetches with the current path from the selected source's own client", async () => {
    const backlinks = vi.fn().mockResolvedValue([]);
    const runtime = serverRuntime("s1", backlinks);
    renderPanel([runtime], { sourceId: "s1", path: "note.md" });

    await screen.findByText(/no backlinks/i);
    expect(backlinks).toHaveBeenCalledTimes(1);
    expect(backlinks).toHaveBeenCalledWith("note.md");
  });

  it("shows an error state when backlinks fails", async () => {
    const runtime = serverRuntime("s1", vi.fn().mockRejectedValue(new Error("boom")));
    renderPanel([runtime], { sourceId: "s1", path: "note.md" });

    expect(await screen.findByRole("alert")).toHaveTextContent(/failed to load/i);
  });

  it("shows a quiet notice for a folder-source selection and never calls fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const runtime = folderRuntime("f1");
    renderPanel([runtime], { sourceId: "f1", path: "note.md" });

    expect(await screen.findByText(/not available for local notes/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
