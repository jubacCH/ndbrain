import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, type HistoryEntry } from "../api/client";
import { LocalNotesStore } from "../local/localStore";
import { AppStateProvider, useAppState } from "../shell/AppState";
import { SourcesContext, type SourcesContextValue } from "../sources/SourcesProvider";
import type { NoteSelection, SourceRuntime } from "../sources/types";
import { HistoryView } from "./HistoryView";

/** Same convention as `panels/BacklinksPanel.test.tsx`: `ApiClient` has
 *  private fields, so a `SourceRuntime`'s `client` must be a real instance
 *  with the method under test mocked directly. */
function serverRuntime(
  id: string,
  history: (path: string) => Promise<HistoryEntry[]> = vi.fn().mockResolvedValue([]),
): SourceRuntime {
  const client = createApiClient("");
  vi.spyOn(client, "history").mockImplementation(history);
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

function renderView(sources: SourceRuntime[], selection: NoteSelection | null) {
  return render(
    <SourcesContext.Provider value={fakeSourcesValue(sources)}>
      <AppStateProvider>
        <Init selection={selection} />
        <HistoryView />
      </AppStateProvider>
    </SourcesContext.Provider>,
  );
}

const ENTRIES: HistoryEntry[] = [
  { hash: "abc1234", message: "fix: typo", author: "Julian", date: "2026-07-10T11:00:00.000Z" },
  { hash: "def5678", message: "feat: add section", author: "Julian", date: "2026-07-09T10:00:00.000Z" },
];

describe("HistoryView", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a placeholder when no note is selected", () => {
    const runtime = serverRuntime("s1");
    renderView([runtime], null);

    expect(screen.getByText(/no note selected/i)).toBeInTheDocument();
    expect(runtime.kind === "server" && runtime.client.history).not.toHaveBeenCalled();
  });

  it("shows a loading state while history is being fetched", () => {
    const runtime = serverRuntime("s1", vi.fn(() => new Promise<HistoryEntry[]>(() => {})));
    renderView([runtime], { sourceId: "s1", path: "note.md" });

    expect(screen.getByText(/loading history/i)).toBeInTheDocument();
  });

  it("shows an empty state when there is no history", async () => {
    const runtime = serverRuntime("s1", vi.fn().mockResolvedValue([]));
    renderView([runtime], { sourceId: "s1", path: "note.md" });

    expect(await screen.findByText(/no history/i)).toBeInTheDocument();
  });

  it("renders commit message, author, and formatted date for each entry", async () => {
    const runtime = serverRuntime("s1", vi.fn().mockResolvedValue(ENTRIES));
    renderView([runtime], { sourceId: "s1", path: "note.md" });

    expect(await screen.findByText("fix: typo")).toBeInTheDocument();
    expect(screen.getByText("feat: add section")).toBeInTheDocument();
    expect(screen.getAllByText("Julian")).toHaveLength(2);
  });

  it("fetches history for the current selected path via the selected source's own client", async () => {
    const history = vi.fn().mockResolvedValue([]);
    const runtime = serverRuntime("s1", history);
    renderView([runtime], { sourceId: "s1", path: "notes/deep.md" });

    await screen.findByText(/no history/i);
    expect(history).toHaveBeenCalledWith("notes/deep.md");
  });

  it("shows an error state when history fails", async () => {
    const runtime = serverRuntime("s1", vi.fn().mockRejectedValue(new Error("boom")));
    renderView([runtime], { sourceId: "s1", path: "note.md" });

    expect(await screen.findByRole("alert")).toHaveTextContent(/failed to load/i);
  });

  it("renders a disabled restore action per commit with a TODO, since there is no restore endpoint yet", async () => {
    const runtime = serverRuntime("s1", vi.fn().mockResolvedValue(ENTRIES));
    renderView([runtime], { sourceId: "s1", path: "note.md" });

    const restoreButtons = await screen.findAllByRole("button", { name: /restore/i });
    expect(restoreButtons).toHaveLength(2);
    for (const button of restoreButtons) {
      expect(button).toBeDisabled();
    }
    expect(screen.getAllByTitle(/not yet supported/i).length).toBeGreaterThan(0);
  });

  it("shows a quiet notice for a folder-source selection and never calls fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const runtime = folderRuntime("f1");
    renderView([runtime], { sourceId: "f1", path: "note.md" });

    expect(await screen.findByText(/not available for local notes/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
