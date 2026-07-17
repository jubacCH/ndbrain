import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `LocalNotesView` calls `@tauri-apps/plugin-dialog`'s `confirm` directly for
// the "move to server?" prompt (C1 finding: `window.confirm` never returns on
// macOS's WKWebView-backed Tauri shell). Mock the plugin the same way
// `localStore.test.ts`/`AppRoot.local.test.tsx` mock Tauri's `fs`/`store`
// plugins, rather than spying on `window.confirm`.
const { dialogConfirmMock } = vi.hoisted(() => ({ dialogConfirmMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: dialogConfirmMock }));

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
    getFolder: vi.fn(async (): Promise<string | null> => "/root"),
    pickFolder: vi.fn(async (): Promise<string | null> => "/root"),
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
    dialogConfirmMock.mockReset().mockResolvedValue(true);

    render(<LocalNotesView store={store} EditorComponent={FakeEditor} moveToServer={moveToServer} />);

    fireEvent.click(await screen.findByText("Note A"));
    fireEvent.click(await screen.findByRole("button", { name: /move to server/i }));

    expect(dialogConfirmMock).toHaveBeenCalledWith(expect.stringMatching(/a\.md/));
    await waitFor(() => expect(moveToServer).toHaveBeenCalledWith("a.md"));
    await waitFor(() => expect(screen.queryByText("Note A")).not.toBeInTheDocument());
  });

  it("does not move to server when the confirmation is declined", async () => {
    const store = makeStore({
      listLocal: vi.fn(async () => [{ path: "a.md", title: "Note A" }]),
    });
    const moveToServer = vi.fn(async (rel: string) => ({ path: rel, localDeleted: true }));
    dialogConfirmMock.mockReset().mockResolvedValue(false);

    render(<LocalNotesView store={store} EditorComponent={FakeEditor} moveToServer={moveToServer} />);

    fireEvent.click(await screen.findByText("Note A"));
    fireEvent.click(await screen.findByRole("button", { name: /move to server/i }));

    await waitFor(() => expect(dialogConfirmMock).toHaveBeenCalled());
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
    dialogConfirmMock.mockReset().mockResolvedValue(true);

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
    dialogConfirmMock.mockReset().mockResolvedValue(true);

    render(<LocalNotesView store={store} EditorComponent={FakeEditor} moveToServer={moveToServer} />);

    fireEvent.click(await screen.findByText("Note A"));
    fireEvent.click(await screen.findByRole("button", { name: /move to server/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/moved to the server/i);
  });

  it("does not treat a declined overwrite confirmation (MoveAbortedError) as an error", async () => {
    const store = makeStore({
      listLocal: vi.fn(async () => [{ path: "a.md", title: "Note A" }]),
    });
    const { MoveAbortedError } = await import("./moveToServer");
    const moveToServer = vi.fn(async () => {
      throw new MoveAbortedError();
    });
    dialogConfirmMock.mockReset().mockResolvedValue(true);

    render(<LocalNotesView store={store} EditorComponent={FakeEditor} moveToServer={moveToServer} />);

    fireEvent.click(await screen.findByText("Note A"));
    fireEvent.click(await screen.findByRole("button", { name: /move to server/i }));

    await waitFor(() => expect(moveToServer).toHaveBeenCalledWith("a.md"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Note A")).toBeInTheDocument();
  });
});

describe("<LocalNotesView> debounced, serialized writes (I2)", () => {
  beforeEach(() => {
    setTauriFlag(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setTauriFlag(undefined);
  });

  it("coalesces rapid successive edits into a single debounced write of only the final content", async () => {
    const store = makeStore({
      listLocal: vi.fn(async () => [{ path: "a.md", title: "Note A" }]),
      readLocal: vi.fn(async () => "original"),
    });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);
    fireEvent.click(await screen.findByText("Note A"));
    const textarea = await screen.findByDisplayValue("original");

    vi.useFakeTimers();
    fireEvent.change(textarea, { target: { value: "o" } });
    fireEvent.change(textarea, { target: { value: "or" } });
    fireEvent.change(textarea, { target: { value: "ori" } });
    fireEvent.change(textarea, { target: { value: "original + final" } });

    // Not written yet — still within the debounce window, and not on every
    // keystroke (I2c: no write, no re-index, per character typed).
    expect(store.writeLocal).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);

    expect(store.writeLocal).toHaveBeenCalledTimes(1);
    expect(store.writeLocal).toHaveBeenCalledWith("a.md", "original + final");
  });

  it("flushes a pending debounced write immediately when switching to a different note, instead of losing it", async () => {
    const store = makeStore({
      listLocal: vi.fn(async () => [
        { path: "a.md", title: "Note A" },
        { path: "b.md", title: "Note B" },
      ]),
      readLocal: vi.fn(async (rel: string) => (rel === "a.md" ? "original a" : "original b")),
    });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);
    await screen.findByText("Note B");
    fireEvent.click(screen.getByText("Note A"));
    const textareaA = await screen.findByDisplayValue("original a");

    vi.useFakeTimers();
    fireEvent.change(textareaA, { target: { value: "edited a" } });
    expect(store.writeLocal).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Note B"));

    // The switch flushed the still-pending debounced edit immediately —
    // it did not wait out the rest of the debounce window (never advanced).
    expect(store.writeLocal).toHaveBeenCalledWith("a.md", "edited a");
  });

  it("flushes a pending debounced write on unmount instead of dropping it", async () => {
    const store = makeStore({
      listLocal: vi.fn(async () => [{ path: "a.md", title: "Note A" }]),
      readLocal: vi.fn(async () => "original"),
    });
    const { unmount } = render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);
    fireEvent.click(await screen.findByText("Note A"));
    const textarea = await screen.findByDisplayValue("original");

    vi.useFakeTimers();
    fireEvent.change(textarea, { target: { value: "edited before unmount" } });
    expect(store.writeLocal).not.toHaveBeenCalled();

    unmount();

    expect(store.writeLocal).toHaveBeenCalledWith("a.md", "edited before unmount");
  });
});

describe("<LocalNotesView> changing the local notes folder (I3)", () => {
  beforeEach(() => {
    setTauriFlag(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setTauriFlag(undefined);
  });

  it("does not show a 'Change folder' button before any folder is configured", async () => {
    const store = makeStore({ getFolder: vi.fn(async () => null) });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);

    await screen.findByRole("button", { name: /choose folder/i });
    expect(screen.queryByRole("button", { name: /change folder/i })).not.toBeInTheDocument();
  });

  it("shows a 'Change folder' button once configured; re-picking loads the new folder's notes", async () => {
    const store = makeStore({
      listLocal: vi.fn(async () => [{ path: "a.md", title: "Note A" }]),
    });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);
    await screen.findByText("Note A");

    store.pickFolder = vi.fn(async () => "/new-root");
    store.listLocal = vi.fn(async () => [{ path: "new.md", title: "New Note" }]);

    fireEvent.click(screen.getByRole("button", { name: /change folder/i }));

    expect(await screen.findByText("New Note")).toBeInTheDocument();
    expect(screen.queryByText("Note A")).not.toBeInTheDocument();
    expect(store.grantFolderAccess).toHaveBeenCalledWith("/new-root");
  });

  it("does nothing when the folder picker is cancelled from 'Change folder'", async () => {
    const store = makeStore({
      listLocal: vi.fn(async () => [{ path: "a.md", title: "Note A" }]),
    });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);
    await screen.findByText("Note A");
    store.pickFolder = vi.fn(async () => null);

    fireEvent.click(screen.getByRole("button", { name: /change folder/i }));

    await waitFor(() => expect(store.pickFolder).toHaveBeenCalled());
    expect(screen.getByText("Note A")).toBeInTheDocument();
  });
});

describe("<LocalNotesView> surfacing load errors instead of dying silently (M3)", () => {
  beforeEach(() => {
    setTauriFlag(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setTauriFlag(undefined);
  });

  it("shows an error when grantFolderAccess fails while restoring a previously configured folder on mount", async () => {
    const store = makeStore({
      grantFolderAccess: vi.fn(async () => {
        throw new Error("scope denied");
      }),
    });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/scope denied/i);
  });

  it("shows an error when grantFolderAccess fails right after picking a folder", async () => {
    const store = makeStore({
      getFolder: vi.fn(async () => null),
      pickFolder: vi.fn(async () => "/root"),
      grantFolderAccess: vi.fn(async () => {
        throw new Error("scope denied");
      }),
    });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);

    fireEvent.click(await screen.findByRole("button", { name: /choose folder/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/scope denied/i);
  });
});

describe("<LocalNotesView> creating a new local note", () => {
  beforeEach(() => {
    setTauriFlag(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setTauriFlag(undefined);
  });

  it("does not show '+ New note' before a folder is configured", async () => {
    const store = makeStore({ getFolder: vi.fn(async () => null) });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);

    await screen.findByRole("button", { name: /choose folder/i });
    expect(screen.queryByRole("button", { name: /new note/i })).not.toBeInTheDocument();
  });

  it("shows '+ New note' once a folder is configured; clicking it opens an inline input", async () => {
    const store = makeStore({ listLocal: vi.fn(async () => []) });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);

    fireEvent.click(await screen.findByRole("button", { name: /new note/i }));

    expect(await screen.findByRole("textbox", { name: /new local note/i })).toBeInTheDocument();
  });

  it("typing a bare name and pressing Enter creates '<name>.md' and opens it in the editor", async () => {
    const store = makeStore({ listLocal: vi.fn(async () => []) });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);

    fireEvent.click(await screen.findByRole("button", { name: /new note/i }));
    const input = await screen.findByRole("textbox", { name: /new local note/i });
    fireEvent.change(input, { target: { value: "ideas" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(store.writeLocal).toHaveBeenCalledWith("ideas.md", "# ideas\n"));
    expect(await screen.findByText("ideas")).toBeInTheDocument();
    // RTL's default text normalizer trims trailing whitespace before matching,
    // so the trailing "\n" from the real `writeLocal` content (asserted above)
    // is intentionally omitted from this matcher.
    expect(await screen.findByDisplayValue("# ideas")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /new local note/i })).not.toBeInTheDocument();
  });

  it("does not double the .md extension when the user already typed it", async () => {
    const store = makeStore({ listLocal: vi.fn(async () => []) });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);

    fireEvent.click(await screen.findByRole("button", { name: /new note/i }));
    const input = await screen.findByRole("textbox", { name: /new local note/i });
    fireEvent.change(input, { target: { value: "ideas.md" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(store.writeLocal).toHaveBeenCalledWith("ideas.md", "# ideas\n"));
  });

  it("supports creating a note inside a subfolder", async () => {
    const store = makeStore({ listLocal: vi.fn(async () => []) });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);

    fireEvent.click(await screen.findByRole("button", { name: /new note/i }));
    const input = await screen.findByRole("textbox", { name: /new local note/i });
    fireEvent.change(input, { target: { value: "projekte/idee" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(store.writeLocal).toHaveBeenCalledWith("projekte/idee.md", "# idee\n"));
  });

  it("shows an error and does not write when the name collides with an existing note", async () => {
    const store = makeStore({ listLocal: vi.fn(async () => [{ path: "ideas.md", title: "Ideas" }]) });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);
    await screen.findByText("Ideas");

    fireEvent.click(await screen.findByRole("button", { name: /new note/i }));
    const input = await screen.findByRole("textbox", { name: /new local note/i });
    fireEvent.change(input, { target: { value: "ideas" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByRole("alert")).toHaveTextContent(/already exists/i);
    expect(store.writeLocal).not.toHaveBeenCalled();
    expect(await screen.findByRole("textbox", { name: /new local note/i })).toBeInTheDocument();
  });

  it("shows an error and does not write for an unsafe path, without crashing", async () => {
    const store = makeStore({ listLocal: vi.fn(async () => []) });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);

    fireEvent.click(await screen.findByRole("button", { name: /new note/i }));
    const input = await screen.findByRole("textbox", { name: /new local note/i });
    fireEvent.change(input, { target: { value: "../escape" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(store.writeLocal).not.toHaveBeenCalled();
  });

  it("Escape closes the input without creating anything", async () => {
    const store = makeStore({ listLocal: vi.fn(async () => []) });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);

    fireEvent.click(await screen.findByRole("button", { name: /new note/i }));
    const input = await screen.findByRole("textbox", { name: /new local note/i });
    fireEvent.change(input, { target: { value: "ideas" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: /new local note/i })).not.toBeInTheDocument();
    expect(store.writeLocal).not.toHaveBeenCalled();
  });

  it("flushes a pending debounced edit of the currently open note before creating and switching to the new one", async () => {
    const store = makeStore({
      listLocal: vi.fn(async () => [{ path: "a.md", title: "Note A" }]),
      readLocal: vi.fn(async () => "original"),
    });
    render(<LocalNotesView store={store} EditorComponent={FakeEditor} />);
    fireEvent.click(await screen.findByText("Note A"));
    const textarea = await screen.findByDisplayValue("original");

    vi.useFakeTimers();
    fireEvent.change(textarea, { target: { value: "edited a" } });
    expect(store.writeLocal).not.toHaveBeenCalled();
    vi.useRealTimers();

    fireEvent.click(screen.getByRole("button", { name: /new note/i }));
    const input = screen.getByRole("textbox", { name: /new local note/i });
    fireEvent.change(input, { target: { value: "ideas" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(store.writeLocal).toHaveBeenCalledWith("ideas.md", "# ideas\n"));
    await waitFor(() => expect(store.writeLocal).toHaveBeenCalledWith("a.md", "edited a"));
  });
});
