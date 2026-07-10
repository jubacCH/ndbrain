import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteSummary } from "../api/client";
import { AppStateProvider, useAppState } from "../shell/AppState";
import { NoteTree, type NoteTreeClient } from "./NoteTree";

function fakeClient(overrides: Partial<NoteTreeClient> = {}): NoteTreeClient {
  return {
    listNotes: vi.fn().mockResolvedValue([]),
    putNote: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Renders the currently selected path next to the tree so tests can assert on
 *  the context side-effect of clicking a note without reaching into internals. */
function SelectedPathProbe() {
  const { selectedPath } = useAppState();
  return <div data-testid="selected-path">{selectedPath ?? "none"}</div>;
}

function renderTree(client: NoteTreeClient) {
  return render(
    <AppStateProvider>
      <NoteTree client={client} />
      <SelectedPathProbe />
    </AppStateProvider>,
  );
}

describe("NoteTree", () => {
  let promptSpy: ReturnType<typeof vi.spyOn>;
  let alertSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
    alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
  });

  afterEach(() => {
    promptSpy.mockRestore();
    alertSpy.mockRestore();
  });

  it("shows a loading state while notes are being fetched", () => {
    const client = fakeClient({ listNotes: vi.fn(() => new Promise<NoteSummary[]>(() => {})) });
    renderTree(client);

    expect(screen.getByText(/loading notes/i)).toBeInTheDocument();
  });

  it("shows an empty state when there are no notes", async () => {
    const client = fakeClient({ listNotes: vi.fn().mockResolvedValue([]) });
    renderTree(client);

    expect(await screen.findByText(/no notes yet/i)).toBeInTheDocument();
  });

  it("renders folders and notes, preferring title over filename", async () => {
    const client = fakeClient({
      listNotes: vi.fn().mockResolvedValue([
        { path: "projects/ndbrain.md", title: "ndBrain" },
        { path: "untitled.md", title: null },
      ]),
    });
    renderTree(client);

    expect(await screen.findByText("projects")).toBeInTheDocument();
    expect(screen.getByText("ndBrain")).toBeInTheDocument();
    expect(screen.getByText("untitled.md")).toBeInTheDocument();
  });

  it("clicking a note sets it as the selected path via AppState", async () => {
    const client = fakeClient({
      listNotes: vi.fn().mockResolvedValue([{ path: "a.md", title: "A" }]),
    });
    renderTree(client);

    const noteButton = await screen.findByText("A");
    fireEvent.click(noteButton);

    expect(screen.getByTestId("selected-path")).toHaveTextContent("a.md");
  });

  it("collapses and expands a folder on click", async () => {
    const client = fakeClient({
      listNotes: vi.fn().mockResolvedValue([{ path: "projects/a.md", title: "A" }]),
    });
    renderTree(client);

    await screen.findByText("A");
    const folderButton = screen.getByText("projects");
    fireEvent.click(folderButton);

    expect(screen.queryByText("A")).not.toBeInTheDocument();

    fireEvent.click(folderButton);
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("creates a new note via prompt, refreshes, and selects it", async () => {
    const listNotes = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ path: "new-note.md", title: null }]);
    const putNote = vi.fn().mockResolvedValue(undefined);
    promptSpy.mockReturnValue("new-note.md");
    const client = fakeClient({ listNotes, putNote });
    renderTree(client);

    await screen.findByText(/no notes yet/i);
    fireEvent.click(screen.getByText("+ New note"));

    await waitFor(() => expect(putNote).toHaveBeenCalledWith("new-note.md", "# new-note\n"));
    await waitFor(() => expect(listNotes).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("selected-path")).toHaveTextContent("new-note.md"));
  });

  it("rejects a new note path that does not end with .md", async () => {
    promptSpy.mockReturnValue("no-extension");
    const putNote = vi.fn();
    const client = fakeClient({ putNote });
    renderTree(client);

    await screen.findByText(/no notes yet/i);
    fireEvent.click(screen.getByText("+ New note"));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(expect.stringMatching(/\.md/)),
    );
    expect(putNote).not.toHaveBeenCalled();
  });

  it("shows an error state when listNotes fails", async () => {
    const client = fakeClient({ listNotes: vi.fn().mockRejectedValue(new Error("boom")) });
    renderTree(client);

    expect(await screen.findByRole("alert")).toHaveTextContent(/failed to load/i);
  });
});
