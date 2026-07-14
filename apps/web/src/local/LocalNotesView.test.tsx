import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalNotesView } from "./LocalNotesView";
import type { LocalNoteSummary } from "./localStore";

/** Fake editor component (default `LocalEditor` mounts real CodeMirror — that's
 *  covered by its own test; here we only exercise `LocalNotesView`'s own
 *  list/search/move logic and its wiring to the editor's `onChange`). */
function FakeEditor({
  path,
  content,
  onChange,
}: {
  path: string;
  content: string;
  onChange: (c: string) => void;
}) {
  return (
    <textarea
      aria-label="note content"
      data-path={path}
      value={content}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function setTauriFlag(value: boolean | undefined) {
  if (value === undefined) {
    delete (globalThis as { isTauri?: boolean }).isTauri;
    return;
  }
  (globalThis as { isTauri?: boolean }).isTauri = value;
}

function makeStore(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getFolder: vi.fn(async () => "/root"),
    pickFolder: vi.fn(async () => "/root"),
    listLocal: vi.fn(async (): Promise<LocalNoteSummary[]> => []),
    readLocal: vi.fn(async () => ""),
    writeLocal: vi.fn(async () => undefined),
    deleteLocal: vi.fn(async () => true),
    grantFolderAccess: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("<LocalNotesView>", () => {
  beforeEach(() => {
    setTauriFlag(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setTauriFlag(undefined);
  });

  it("renders nothing outside of Tauri, even if a store were somehow passed", async () => {
    setTauriFlag(undefined);
    const store = makeStore();
    const { container } = render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);

    expect(container).toBeEmptyDOMElement();
    expect(store.getFolder).not.toHaveBeenCalled();
  });

  it("shows a 'choose folder' prompt when no local folder is configured yet", async () => {
    const store = makeStore({ getFolder: vi.fn(async () => null) });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);

    expect(await screen.findByRole("button", { name: /choose folder/i })).toBeInTheDocument();
    expect(store.listLocal).not.toHaveBeenCalled();
  });

  it("picking a folder lists the notes it contains", async () => {
    const store = makeStore({
      getFolder: vi.fn(async () => null),
      pickFolder: vi.fn(async () => "/root"),
      listLocal: vi.fn(async () => [{ path: "a.md", title: "Note A" }]),
    });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);

    fireEvent.click(await screen.findByRole("button", { name: /choose folder/i }));

    expect(await screen.findByText("Note A")).toBeInTheDocument();
    expect(store.pickFolder).toHaveBeenCalledTimes(1);
    expect(store.grantFolderAccess).toHaveBeenCalledWith("/root");
  });

  it("lists notes automatically when a folder is already configured", async () => {
    const store = makeStore({
      listLocal: vi.fn(async () => [
        { path: "a.md", title: "Note A" },
        { path: "no-title.md", title: null },
      ]),
    });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);

    expect(await screen.findByText("Note A")).toBeInTheDocument();
    expect(screen.getByText("no-title.md")).toBeInTheDocument();
    // The runtime fs scope grant does not survive an app restart, unlike the
    // persisted folder path — must be re-granted when restoring it, too.
    expect(store.grantFolderAccess).toHaveBeenCalledWith("/root");
  });

  it("opening a note reads its content and renders it in the editor", async () => {
    const store = makeStore({
      listLocal: vi.fn(async () => [{ path: "a.md", title: "Note A" }]),
      readLocal: vi.fn(async (rel: string) => `content of ${rel}`),
    });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);

    fireEvent.click(await screen.findByText("Note A"));

    expect(await screen.findByDisplayValue("content of a.md")).toBeInTheDocument();
    expect(store.readLocal).toHaveBeenCalledWith("a.md");
  });

  it("editing the open note calls writeLocal with the new content", async () => {
    const store = makeStore({
      listLocal: vi.fn(async () => [{ path: "a.md", title: "Note A" }]),
      readLocal: vi.fn(async () => "original"),
    });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);

    fireEvent.click(await screen.findByText("Note A"));
    const textarea = await screen.findByDisplayValue("original");
    fireEvent.change(textarea, { target: { value: "original + edit" } });

    await waitFor(() => expect(store.writeLocal).toHaveBeenCalledWith("a.md", "original + edit"));
  });

  it("refreshes the title in the list after an edit changes the note's heading", async () => {
    const store = makeStore({
      listLocal: vi.fn(async () => [{ path: "a.md", title: "Old Title" }]),
      readLocal: vi.fn(async () => "# Old Title"),
    });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);

    fireEvent.click(await screen.findByText("Old Title"));
    const textarea = await screen.findByDisplayValue("# Old Title");
    fireEvent.change(textarea, { target: { value: "# New Title" } });

    await waitFor(() => expect(screen.getByText("New Title")).toBeInTheDocument());
  });

  it("searches local notes by title/content via the on-device index", async () => {
    const store = makeStore({
      listLocal: vi.fn(async () => [
        { path: "migraine.md", title: "Migraine Log" },
        { path: "recipe.md", title: "Pasta Recipe" },
      ]),
      readLocal: vi.fn(async (rel: string) =>
        rel === "migraine.md" ? "# Migraine Log\ntriggers and notes" : "# Pasta Recipe\ntomato sauce",
      ),
    });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);

    await screen.findByText("Migraine Log");
    fireEvent.change(screen.getByRole("searchbox", { name: /search local notes/i }), {
      target: { value: "migr" },
    });

    await waitFor(() => expect(screen.getByText("Migraine Log")).toBeInTheDocument());
    expect(screen.queryByText("Pasta Recipe")).not.toBeInTheDocument();
  });

  it("shows a robust error instead of crashing when listing fails", async () => {
    const store = makeStore({ listLocal: vi.fn(async () => Promise.reject(new Error("disk error"))) });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/failed to load local notes/i);
  });

  it("moves a note to the server after confirmation, then removes it from the local list", async () => {
    const store = makeStore({
      listLocal: vi.fn(async () => [{ path: "a.md", title: "Note A" }]),
    });
    const moveToServer = vi.fn(async (rel: string) => ({ path: rel, localDeleted: true }));
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<LocalNotesView store={store} EditorComponent={FakeEditor} moveToServer={moveToServer} />);

    fireEvent.click(await screen.findByText("Note A"));
    fireEvent.click(await screen.findByRole("button", { name: /move to server/i }));

    await waitFor(() => expect(moveToServer).toHaveBeenCalledWith("a.md"));
    await waitFor(() => expect(screen.queryByText("Note A")).not.toBeInTheDocument());
  });

  it("does not move to server when the confirmation is declined", async () => {
    const store = makeStore({
      listLocal: vi.fn(async () => [{ path: "a.md", title: "Note A" }]),
    });
    const moveToServer = vi.fn(async (rel: string) => ({ path: rel, localDeleted: true }));
    vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<LocalNotesView store={store} EditorComponent={FakeEditor} moveToServer={moveToServer} />);

    fireEvent.click(await screen.findByText("Note A"));
    fireEvent.click(await screen.findByRole("button", { name: /move to server/i }));

    expect(moveToServer).not.toHaveBeenCalled();
    expect(screen.getByText("Note A")).toBeInTheDocument();
  });

  it("shows an error and keeps the note listed when moveToServer's PUT fails", async () => {
    const store = makeStore({
      listLocal: vi.fn(async () => [{ path: "a.md", title: "Note A" }]),
    });
    const moveToServer = vi.fn(async () => {
      throw new Error("server unreachable");
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<LocalNotesView store={store} EditorComponent={FakeEditor} moveToServer={moveToServer} />);

    fireEvent.click(await screen.findByText("Note A"));
    fireEvent.click(await screen.findByRole("button", { name: /move to server/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/server unreachable/i);
    expect(screen.getByText("Note A")).toBeInTheDocument();
  });

  it("warns (without treating it as failure) when the move succeeds but the local copy could not be confirmed removed", async () => {
    const store = makeStore({
      listLocal: vi.fn(async () => [{ path: "a.md", title: "Note A" }]),
    });
    const moveToServer = vi.fn(async (rel: string) => ({ path: rel, localDeleted: false }));
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<LocalNotesView store={store} EditorComponent={FakeEditor} moveToServer={moveToServer} />);

    fireEvent.click(await screen.findByText("Note A"));
    fireEvent.click(await screen.findByRole("button", { name: /move to server/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/moved to the server/i);
  });
});
