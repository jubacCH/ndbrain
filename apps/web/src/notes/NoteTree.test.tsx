import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

  it("shows an error state when listNotes fails", async () => {
    const client = fakeClient({ listNotes: vi.fn().mockRejectedValue(new Error("boom")) });
    renderTree(client);

    expect(await screen.findByRole("alert")).toHaveTextContent(/failed to load/i);
  });

  describe("creating a new note via the inline input", () => {
    it("reveals an inline input when '+ New note' is clicked", async () => {
      const client = fakeClient();
      renderTree(client);

      await screen.findByText(/no notes yet/i);
      fireEvent.click(screen.getByText("+ New note"));

      expect(screen.getByRole("textbox", { name: /path/i })).toBeInTheDocument();
    });

    it("creates a new note on submit, refreshes, and selects it", async () => {
      const listNotes = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ path: "new-note.md", title: null }]);
      const putNote = vi.fn().mockResolvedValue(undefined);
      const client = fakeClient({ listNotes, putNote });
      renderTree(client);

      await screen.findByText(/no notes yet/i);
      fireEvent.click(screen.getByText("+ New note"));

      const input = screen.getByRole("textbox", { name: /path/i });
      fireEvent.change(input, { target: { value: "new-note.md" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => expect(putNote).toHaveBeenCalledWith("new-note.md", "# new-note\n"));
      await waitFor(() => expect(listNotes).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByTestId("selected-path")).toHaveTextContent("new-note.md"));
      expect(screen.queryByRole("textbox", { name: /path/i })).not.toBeInTheDocument();
    });

    it("creates a new note when the Create button is clicked", async () => {
      const listNotes = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ path: "new-note.md", title: null }]);
      const putNote = vi.fn().mockResolvedValue(undefined);
      const client = fakeClient({ listNotes, putNote });
      renderTree(client);

      await screen.findByText(/no notes yet/i);
      fireEvent.click(screen.getByText("+ New note"));

      const input = screen.getByRole("textbox", { name: /path/i });
      fireEvent.change(input, { target: { value: "new-note.md" } });
      fireEvent.click(screen.getByRole("button", { name: /create/i }));

      await waitFor(() => expect(putNote).toHaveBeenCalledWith("new-note.md", "# new-note\n"));
    });

    it("shows an inline error for a path that does not end with .md, and keeps the input open", async () => {
      const putNote = vi.fn();
      const client = fakeClient({ putNote });
      renderTree(client);

      await screen.findByText(/no notes yet/i);
      fireEvent.click(screen.getByText("+ New note"));

      const input = screen.getByRole("textbox", { name: /path/i });
      fireEvent.change(input, { target: { value: "no-extension" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(await screen.findByRole("alert")).toHaveTextContent(/\.md/);
      expect(putNote).not.toHaveBeenCalled();
      expect(screen.getByRole("textbox", { name: /path/i })).toBeInTheDocument();
    });

    it("ignores an empty submit and keeps the input open", async () => {
      const putNote = vi.fn();
      const client = fakeClient({ putNote });
      renderTree(client);

      await screen.findByText(/no notes yet/i);
      fireEvent.click(screen.getByText("+ New note"));

      const input = screen.getByRole("textbox", { name: /path/i });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(putNote).not.toHaveBeenCalled();
      expect(screen.getByRole("textbox", { name: /path/i })).toBeInTheDocument();
    });

    it("surfaces an inline error and does not select the note when creating it fails", async () => {
      const putNote = vi.fn().mockRejectedValue(new Error("boom"));
      const client = fakeClient({ putNote });
      renderTree(client);

      await screen.findByText(/no notes yet/i);
      fireEvent.click(screen.getByText("+ New note"));

      const input = screen.getByRole("textbox", { name: /path/i });
      fireEvent.change(input, { target: { value: "new-note.md" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(await screen.findByRole("alert")).toHaveTextContent(/failed to create/i);
      expect(screen.getByTestId("selected-path")).toHaveTextContent("none");
    });

    it("closes the input without creating a note on Escape", async () => {
      const putNote = vi.fn();
      const client = fakeClient({ putNote });
      renderTree(client);

      await screen.findByText(/no notes yet/i);
      fireEvent.click(screen.getByText("+ New note"));

      const input = screen.getByRole("textbox", { name: /path/i });
      fireEvent.change(input, { target: { value: "new-note.md" } });
      fireEvent.keyDown(input, { key: "Escape" });

      expect(screen.queryByRole("textbox", { name: /path/i })).not.toBeInTheDocument();
      expect(putNote).not.toHaveBeenCalled();
    });

    it("closes the input without creating a note when Cancel is clicked", async () => {
      const putNote = vi.fn();
      const client = fakeClient({ putNote });
      renderTree(client);

      await screen.findByText(/no notes yet/i);
      fireEvent.click(screen.getByText("+ New note"));

      const input = screen.getByRole("textbox", { name: /path/i });
      fireEvent.change(input, { target: { value: "new-note.md" } });
      fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

      expect(screen.queryByRole("textbox", { name: /path/i })).not.toBeInTheDocument();
      expect(putNote).not.toHaveBeenCalled();
    });
  });
});
